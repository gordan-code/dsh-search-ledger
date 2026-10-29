import { randomUUID } from 'node:crypto'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult, WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { WebError } from '@deepseek-ai/dsh-web'
import type { Channel, Operation, RequestSource, RouteSnapshot, RoutingConfig, AttemptResult } from '../contracts.ts'
import { BillingError } from '../contracts.ts'
import { decide } from './policy.ts'
import { resolveRoute } from '../routing/resolver.ts'
import type { BillingDatabase } from '../storage/database.ts'
import { adapterFor } from '../providers/index.ts'
import { isTransportError, endpointFor, validateEndpoint, validateFetchUrl, validateQuery, type RawResponse, type SearchAdapter, type FetchAdapter } from '../providers/common.ts'
import { requiresCredential } from '../channel-kinds.ts'
import { resolveCandidates } from '../routing/candidates.ts'
import { abortable, mayFailover, OperationBudget } from './failover.ts'
import { breakerViews, coolingChannels } from './breaker.ts'
import { budgetState, budgetWindow } from './budget.ts'
import type { BreakerSettings, BudgetSettings } from '../contracts.ts'

export interface MeteredWebDeps {
  db: BillingDatabase
  readConfig: () => RoutingConfig
  source: () => RequestSource
  resolveCredential: (ref: string) => Promise<string | undefined>
  /** 渠道私有Key池，已按本次起点排序；不提供时兼容旧单引用模式。 */
  resolveChannelCredentials?: (channel: Channel) => Promise<string[]>
  quotaSubject: (key: string) => string
  /** 在账本 prepare 成功后锁定渠道身份；失败时取消 prepared 且不得派发网络请求。 */
  afterPrepare?: (route: RouteSnapshot) => void
  /** 人工熔断复位标记；缺省时只按账本推导，不影响冷却自动恢复。 */
  breakerResets?: { list: (profileId: string) => Record<string, string> }
  httpFetch?: typeof fetch
  now?: () => Date
}

type SearchInput = WebSearchRequest
type FetchInput = WebFetchRequest

function safeError(code: string, message: string): BillingError {
  return new BillingError(code, message)
}

function nowIso(now: () => Date): string {
  let date: Date
  try { date = now() } catch { throw safeError('TIME_INVALID', '时间无效') }
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw safeError('TIME_INVALID', '时间无效')
  return date.toISOString()
}

function endpointOrigin(route: RouteSnapshot, target: URL | undefined): string {
  if (route.channel.kind === 'local-http') {
    if (target === undefined) throw safeError('ENDPOINT_INVALID', '抓取地址无效')
    return target.origin
  }
  try { return new URL(endpointFor(route.channel, route.operation)).origin } catch { throw safeError('ENDPOINT_INVALID', '渠道地址无效') }
}

function upstreamError(error: unknown, signal?: AbortSignal): BillingError {
  if (signal?.aborted && signal.reason instanceof BillingError) return signal.reason
  if (isTransportError(error)) {
    if (error.code === 'CANCELLED') return safeError('CANCELLED', '请求已取消')
    return safeError('UPSTREAM_UNKNOWN', '上游响应未知')
  }
  if (error instanceof Error && (error as { code?: unknown }).code === 'WEB_ABORTED') return safeError('CANCELLED', '请求已取消')
  const webCode = error instanceof Error ? (error as { code?: unknown }).code : undefined
  if (typeof webCode === 'string' && ['WEB_PROVIDER_ERROR', 'WEB_FETCH_TIMEOUT', 'WEB_FETCH_TOO_LARGE', 'WEB_UNSUPPORTED_CONTENT_TYPE'].includes(webCode)) return safeError('UPSTREAM_UNKNOWN', '上游抓取响应未知')
  if (error instanceof BillingError) return error
  return safeError('INTERNAL_ERROR', '渠道内部执行失败，已停止派发')
}

/**
 * 计量 Web seam：路由、账本、一次网络派发和规范化均在同一调用中完成。
 * provider 的 available() 有意只反映实例已装配，绝不读取会话或凭证。
 */
export class MeteredWeb {
  readonly searchProvider: WebSearchProvider
  readonly fetchProvider: WebFetchProvider
  private readonly deps: MeteredWebDeps
  private readonly httpFetch: typeof fetch | undefined

  constructor(deps: MeteredWebDeps) {
    this.deps = deps
    this.httpFetch = deps.httpFetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
    this.searchProvider = {
      id: 'web-search-metered',
      available: () => true,
      search: (request, signal) => this.providerCall(() => this.search(request, signal)),
    }
    this.fetchProvider = {
      id: 'web-fetch-metered',
      available: () => true,
      fetch: (request, signal) => this.providerCall(() => this.fetch(request, signal)),
    }
  }

  private async providerCall<T>(run: () => Promise<T>): Promise<T> {
    try { return await run() } catch (error) {
      // 原生ToolRuntime只对HarnessError投影结构化错误码；浏览器共享BillingError不引入宿主依赖。
      if (error instanceof BillingError) throw new WebError(error.message, error.code)
      throw new WebError('计量后端执行失败，请检查接入状态', 'BILLING_FAILED')
    }
  }

  async search(request: SearchInput, signal?: AbortSignal): Promise<WebSearchResult> {
    const input = validateQuery(request?.query, request?.maxResults)
    return await this.run('search', input, signal) as WebSearchResult
  }

  async fetch(request: FetchInput, signal?: AbortSignal): Promise<WebFetchResult> {
    const target = validateFetchUrl(request?.url)
    return await this.run('fetch', { url: target.toString() }, signal, target) as WebFetchResult
  }

  /** 手动测试单Key：复用计量/身份接缝，不经过路由接力，不返回网页或搜索内容。 */
  async probe(route: RouteSnapshot, key: string, operationId: string, attemptId: string, signal: AbortSignal, check: () => void): Promise<void> {
    validateEndpoint(route.channel, route.operation)
    const adapter = adapterFor(route.channel, this.httpFetch)
    if (route.operation === 'search') {
      const input = validateQuery('DSH API connectivity test', 1)
      const raw = await this.execute('search', input, route, adapter, key, signal, undefined, operationId, true, check, attemptId)
      ;(adapter as SearchAdapter).normalizeSearch(raw.payload, input)
    } else {
      const target = validateFetchUrl('https://example.com/')
      const input = { url: target.toString() }
      const raw = await this.execute('fetch', input, route, adapter, key, signal, target, operationId, true, check, attemptId)
      ;(adapter as FetchAdapter).normalizeFetch(raw.payload, input, raw.status)
    }
  }

  private async run(operation: Operation, input: SearchInput | FetchInput, signal?: AbortSignal, target?: URL): Promise<WebSearchResult | WebFetchResult> {
    const source = structuredClone(this.deps.source())
    const config = structuredClone(this.deps.readConfig())
    const overrides = source.sessionId === undefined ? {} : this.deps.db.getOverrides(source.profileId, source.sessionId)
    const settings = config.failover?.[operation]
    const ordered = settings?.enabled === true
    const routes = this.guard(source.profileId, ordered ? resolveCandidates(config, source, operation, overrides) : [resolveRoute(config, source, operation, overrides)], config)
    let budget = ordered || (this.deps.resolveChannelCredentials && routes.some(route => requiresCredential(route.channel))) ? new OperationBudget(settings?.totalTimeoutMs ?? 60_000, signal) : undefined
    const operationId = randomUUID()
    let available = false
    try {
      for (const route of routes) {
        budget?.check()
        validateEndpoint(route.channel, operation)
        let keys: (string | undefined)[]
        // 旧单渠道模式保留prepared后取消的审计语义；有序模式在预检前即响应取消。
        try { keys = budget ? await abortable(this.credentials(route), budget.controller.signal) : await this.credentials(route) }
        catch (error) {
          budget?.check()
          if (ordered && error instanceof BillingError && ['CREDENTIAL_MISSING', 'CREDENTIAL_UNAVAILABLE'].includes(error.code)) continue
          throw error
        }
        budget?.check()
        const multiple = keys.length > 1
        // 池内接力独立于跨渠道开关；沿用已配置预算，缺省20秒/60秒。
        if (multiple && !budget) budget = new OperationBudget(settings?.totalTimeoutMs ?? 60_000, signal)
        const adapter = adapterFor(route.channel, this.httpFetch)
        available = true
        for (let index = 0; index < keys.length; index++) {
          budget?.check()
          const key = keys[index]
          const call = async (child?: AbortSignal, check = () => budget?.check()) => {
            const raw = await this.execute(operation, input, route, adapter, key, child, target, operationId, ordered || multiple, check)
            return operation === 'search'
              ? (adapter as SearchAdapter).normalizeSearch(raw.payload, input as SearchInput)
              : (adapter as FetchAdapter).normalizeFetch(raw.payload, input as FetchInput, raw.status)
          }
          try { return budget ? await budget.attempt(settings?.attemptTimeoutMs ?? 20_000, call) : await call(signal) }
          catch (error) {
            budget?.check()
            if (!mayFailover(error) || (!ordered && index === keys.length - 1)) throw error
          }
        }
      }
      throw safeError(available ? 'ALL_CHANNELS_FAILED' : 'NO_AVAILABLE_CHANNEL', available ? '所有候选渠道均失败或超时；请查看本地账本' : '没有具备对应能力及可解析凭证的可用渠道')
    } finally { budget?.close() }
  }

  /**
   * 派发前的两道闸门：先按熔断剔除冷却渠道，再按预算决定放行、降级或停止。
   * 两者都只读账本已有终态，不写任何状态，因此同样的账本总得到同样的判定。
   */
  private guard(profileId: string, routes: readonly RouteSnapshot[], config: RoutingConfig): readonly RouteSnapshot[] {
    if (routes.length === 0) return routes
    const clock = this.deps.now ?? (() => new Date())
    let now: Date
    try { now = clock() } catch { throw safeError('TIME_INVALID', '时间无效') }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw safeError('TIME_INVALID', '时间无效')
    const afterBreaker = this.applyBreaker(profileId, routes, config.breaker, now)
    return this.applyBudget(profileId, afterBreaker, config.budget, now)
  }

  private applyBreaker(profileId: string, routes: readonly RouteSnapshot[], settings: BreakerSettings | undefined, now: Date): readonly RouteSnapshot[] {
    if (settings?.enabled !== true || routes.length === 0) return routes
    const channels = [...new Map(routes.map(route => [route.channel.id, { id: route.channel.id, name: route.channel.name }])).values()]
    let observations
    try {
      const since = new Date(now.getTime() - settings.windowMs).toISOString()
      observations = this.deps.db.recentOutcomes(profileId, since)
    } catch (error) {
      if (error instanceof BillingError) throw error
      throw safeError('DB_QUERY_FAILED', '熔断状态读取失败，已停止派发')
    }
    let resets: Record<string, string> = {}
    try { resets = this.deps.breakerResets?.list(profileId) ?? {} } catch { throw safeError('DB_QUERY_FAILED', '熔断复位标记读取失败，已停止派发') }
    const cooling = coolingChannels(breakerViews(observations, channels, settings, resets, now.getTime()))
    const kept = routes.filter(route => !cooling.has(route.channel.id))
    if (kept.length === 0 && cooling.size > 0) {
      const names = routes.filter(route => cooling.has(route.channel.id)).map(route => route.channel.name).join('、')
      throw safeError('CHANNEL_COOLING_DOWN', `候选渠道连续失败已进入冷却：${names}；可稍后重试或在渠道页手动复位`)
    }
    return kept
  }

  private applyBudget(profileId: string, routes: readonly RouteSnapshot[], settings: BudgetSettings | undefined, now: Date): readonly RouteSnapshot[] {
    if (settings?.enabled !== true || routes.length === 0) return routes
    let state
    try {
      const range = budgetWindow(now, settings.window)
      state = budgetState(this.deps.db.budgetUsage(profileId, range.from, range.to), settings, range)
    } catch (error) {
      if (error instanceof BillingError) throw error
      throw safeError('DB_QUERY_FAILED', '预算用量读取失败，已停止派发')
    }
    if (!state.exceeded) return routes
    if (settings.onExceed === 'warn') return routes
    if (settings.onExceed === 'fallback') {
      const free = routes.filter(route => route.channel.billingClass === 'free')
      if (free.length > 0) return free
      throw safeError('BUDGET_EXCEEDED', '预算已用尽且没有免费候选渠道，已停止派发')
    }
    throw safeError('BUDGET_EXCEEDED', `预算已用尽（${settings.window === 'day' ? '当日' : '本月'}），已停止派发；可在面板调整预算或改用免费渠道`)
  }

  private async credentials(route: RouteSnapshot): Promise<(string | undefined)[]> {    if (!requiresCredential(route.channel)) return [undefined]
    if (this.deps.resolveChannelCredentials) {
      let keys: string[]
      try { keys = await this.deps.resolveChannelCredentials(route.channel) } catch { throw safeError('CREDENTIAL_UNAVAILABLE', '渠道凭证不可用') }
      const usable = [...new Set(keys.filter(key => typeof key === 'string' && key.trim().length > 0))]
      if (!usable.length) throw safeError('CREDENTIAL_MISSING', '渠道凭证不可用')
      return usable
    }
    const ref = route.channel.credentialRef
    if (ref === undefined) throw safeError('CREDENTIAL_MISSING', '渠道凭证不可用')
    let key: string | undefined
    try { key = await this.deps.resolveCredential(ref) } catch { throw safeError('CREDENTIAL_UNAVAILABLE', '渠道凭证不可用') }
    if (typeof key !== 'string' || key.trim().length === 0) throw safeError('CREDENTIAL_MISSING', '渠道凭证不可用')
    return [key]
  }

  private quota(route: RouteSnapshot, credential: string | undefined, startedAt: Date): { subject: string; window: string; limit: number; credits: number } | undefined {
    if (route.channel.kind !== 'tavily' || credential === undefined) return undefined
    let subject: string
    try { subject = this.deps.quotaSubject(credential) } catch { throw safeError('QUOTA_INVALID', '额度主体无效') }
    if (typeof subject !== 'string' || subject.length === 0) throw safeError('QUOTA_INVALID', '额度主体无效')
    return { subject, window: startedAt.toISOString().slice(0, 7), limit: route.channel.monthlyCredits ?? 1000, credits: 1 }
  }

  private async execute<T extends SearchInput | FetchInput>(
    operation: Operation,
    request: T,
    route: RouteSnapshot,
    adapter: SearchAdapter | FetchAdapter,
    credential: string | undefined,
    signal?: AbortSignal,
    target?: URL,
    operationId: string = randomUUID(),
    ordered = false,
    checkBudget: () => void = () => {},
    attemptId: string = randomUUID(),
  ): Promise<RawResponse> {
    checkBudget()
    const clock = this.deps.now ?? (() => new Date())
    const startedAt = nowIso(clock)
    const startedDate = new Date(startedAt)
    const ownerToken = randomUUID()
    const quota = this.quota(route, credential, startedDate)
    try {
      this.deps.db.prepare({
        attemptId, operationId, ownerToken, operation, profileId: route.profileId,
        sessionId: route.sessionId, sourceProviderId: route.sourceProviderId, sourceModel: route.sourceModel,
        channelId: route.channel.id, channelName: route.channel.name, channelKind: route.channel.kind,
        endpointOrigin: endpointOrigin(route, target), price: route.price, configRevision: route.configRevision,
        startedAt, quota,
      })
    } catch (error) {
      if (error instanceof BillingError) throw error
      throw safeError('DB_PREPARE_FAILED', '计量准备失败')
    }

    // 先完成账本 prepared，再锁定渠道身份；锁定失败必须释放 prepared 额度。
    try {
      this.deps.afterPrepare?.(route)
      checkBudget()
    } catch (error) {
      this.cancelPrepared(attemptId, ownerToken)
      if (error instanceof BillingError) throw error
      throw safeError('CHANNEL_IDENTITY_INVALID', '渠道身份未锁定')
    }

    if (signal?.aborted) {
      this.cancelPrepared(attemptId, ownerToken)
      throw safeError('CANCELLED', '请求已取消')
    }
    let dispatched = false
    try {
      try { dispatched = this.deps.db.dispatch(attemptId, ownerToken) } catch { throw safeError('DB_DISPATCH_FAILED', '计量派发失败') }
      if (!dispatched) throw safeError('ATTEMPT_DISPATCH_FAILED', '无法派发计量请求')
      if (signal?.aborted) {
        this.finishUnknown(attemptId, ownerToken)
        throw safeError('CANCELLED', '请求已取消')
      }
      let raw: RawResponse
      try {
        raw = operation === 'search'
          ? await abortable((adapter as SearchAdapter).search(request as SearchInput, route, credential, signal), signal)
          : await abortable((adapter as FetchAdapter).fetch(request as FetchInput, route, credential, signal), signal)
      } catch (error) {
        // 只要传输层抛错，响应证据就不完整；即使已有 HTTP 状态，也必须按 unknown 结算。
        this.finishUnknown(attemptId, ownerToken)
        throw upstreamError(error, signal)
      }

      const decision = decide(operation, route.price.policy, { status: raw.status, payload: raw.payload, billingEvidence: raw.billingEvidence })
      const result: AttemptResult = {
        outcome: decision.outcome,
        status: raw.status,
        ...(decision.resultCount === undefined ? {} : { resultCount: decision.resultCount }),
        ...(decision.hasContent === undefined ? {} : { hasContent: decision.hasContent }),
        ...(decision.outcome === 'failed' ? { errorCode: 'UPSTREAM_FAILED' } : decision.outcome === 'unknown' ? { errorCode: 'UPSTREAM_UNKNOWN' } : {}),
        completedAt: nowIso(this.deps.now ?? (() => new Date())),
      }
      try {
        if (!this.deps.db.finish(attemptId, ownerToken, result)) throw safeError('DB_FINISH_FAILED', '计量结算失败')
      } catch (error) {
        if (error instanceof BillingError && error.code === 'DB_FINISH_FAILED') throw error
        throw safeError('DB_FINISH_FAILED', '计量结算失败')
      }
      // 本地抓取将 HTTP 非 2xx 作为标准 WebFetchResult 返回；失败状态仍已在上一步独立入账。
      if (decision.outcome === 'failed' && !(!ordered && operation === 'fetch' && route.channel.kind === 'local-http')) throw safeError('UPSTREAM_FAILED', '上游请求失败')
      if (decision.outcome === 'unknown') throw safeError('UPSTREAM_UNKNOWN', '上游响应未知')
      return raw
    } catch (error) {
      if (!dispatched) {
        this.cancelPrepared(attemptId, ownerToken)
      }
      throw error
    }
  }

  private finishUnknown(attemptId: string, ownerToken: string): void {
    try {
      if (!this.deps.db.finish(attemptId, ownerToken, { outcome: 'unknown', errorCode: 'UPSTREAM_UNKNOWN', completedAt: nowIso(this.deps.now ?? (() => new Date())) })) throw new Error('not settled')
    } catch {
      throw safeError('DB_FINISH_FAILED', '未知请求结算失败，已停止派发')
    }
  }

  private cancelPrepared(attemptId: string, ownerToken: string): void {
    try { if (!this.deps.db.cancelPrepared(attemptId, ownerToken)) throw new Error('not cancelled') }
    catch { throw safeError('DB_CANCEL_FAILED', '未派发请求取消写入失败，已停止接力') }
  }
}
