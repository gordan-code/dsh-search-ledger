// Host装配只注册自有Web后端；配置、凭证及数据目录均来自同一宿主上下文。
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolve, join } from 'node:path'
import { z } from 'zod'
import { BillingDatabase } from './storage/database.ts'
import { MeteredWeb } from './accounting/meter.ts'
import { BillingController } from './host/controller.ts'
import { installationSubject } from './host/installation.ts'
import { ChannelIdentities } from './host/channel-identities.ts'
import { readConfig } from './config.ts'
import { routingDiagnostics, webSelection } from './host/diagnostics.ts'
import { ChannelManagement } from './host/channel-management.ts'
import { ChannelCredentials } from './host/channel-credentials.ts'
import { KeyTester } from './host/key-tester.ts'
import { candidateStates } from './host/candidate-status.ts'
import { requestSource } from './routing/context.ts'
import type { Config as PluginConfig } from './config.ts'
import { BillingError } from './contracts.ts'
import type { AttemptFilter, BreakerSettings, BudgetSettings, ExportFormat } from './contracts.ts'
import { BreakerResets } from './host/breaker-resets.ts'
import { breakerViews } from './accounting/breaker.ts'
import { budgetState, budgetWindow } from './accounting/budget.ts'
import { buildExport, EXPORT_ROW_LIMIT } from './host/ledger-export.ts'
export { Config } from './config.ts'
export { BillingController } from './host/controller.ts'
// 保留旧命名空间，与已安装实例的Settings、凭据和账本身份兼容；发布包名为dsh-search-ledger。
export const name = 'dsh-search-ledger'
export const inject = ['web', 'credentials', 'typert', 'profileContext']
const filterSchema = z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), channelId: z.string().max(80).optional(), sourceProviderId: z.string().max(160).optional(), sessionId: z.string().max(160).optional(), currency: z.enum(['CNY', 'USD']).optional() }).strict()
export function apply(ctx: Context, config: PluginConfig): void {
  const profile = ctx.profileContext
  if (!profile?.home || !profile.name) throw new BillingError('PROFILE_MISSING', '请在DSH profile内加载本插件')
  const profileId = profile.name; const home = resolve(profile.home); const directory = join(home, 'dsh-search-ledger')
  const quotaSubject = installationSubject(directory); const db = new BillingDatabase(join(directory, 'usage.sqlite'))
  ctx.effect(() => () => db.close())
  const identities = new ChannelIdentities(join(directory, 'usage.sqlite'))
  ctx.effect(() => () => identities.close())
  const breakerResets = new BreakerResets(join(directory, 'usage.sqlite'))
  ctx.effect(() => () => breakerResets.close())
  let configError: string | null = null
  const currentConfig = () => {
    try {
      const next = readConfig(config)
      identities.assertConfig(profileId, next.channels); configError = null; return next
    } catch { configError = '渠道配置无效或改变了已有用量渠道的身份，请恢复配置或使用新渠道ID'; throw new BillingError('CONFIG_INVALID', configError) }
  }
  const source = () => requestSource(ctx, profileId)
  const channels = new ChannelManagement({
    readConfig: currentConfig, isUsed: id => identities.isUsed(profileId, id) || db.hasChannelAttempts(profileId, id),
    sessionReferenceCount: id => db.channelSessionReferences(profileId, id),
    saveChannels: async (next, revision) => {
      const settings = ctx.get('settings')
      if (!settings) throw new BillingError('SETTINGS_UNAVAILABLE', '配置服务不可用，未删除渠道')
      await settings.mutate('dsh-search-ledger', [{ op: 'set', path: ['channels'], value: JSON.parse(JSON.stringify(next)) }], revision)
      identities.assertConfig(profileId, next)
      const updated = settings.describe({ redactSecrets: true }).find(item => String(item.ns) === 'dsh-search-ledger')?.revision
      if (updated === undefined) throw new BillingError('SETTINGS_UNAVAILABLE', '保存后的配置版本不可用，请重新打开面板')
      return updated
    },
  })
  const credentials = new ChannelCredentials({ profileId: JSON.stringify([home, profileId]), readChannels: () => currentConfig().channels, credentials: ctx.credentials })
  const web = new MeteredWeb({ db, readConfig: currentConfig, source, quotaSubject, breakerResets, afterPrepare: route => { channels.assertDispatch(route.channel.id); identities.remember(route) }, resolveCredential: async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value, resolveChannelCredentials: channel => credentials.resolve(channel) })
  const keyTester = new KeyTester({ db, web, profileId, readConfig: currentConfig, resolveKeys: channel => credentials.resolve(channel, false) })
  ctx.effect(() => () => keyTester.close())
  const registered = { search: false, fetch: false }
  ctx.effect(() => {
    const dispose = ctx.web.registerSearchProvider(web.searchProvider); registered.search = true
    return () => { registered.search = false; dispose() }
  })
  ctx.effect(() => {
    const dispose = ctx.web.registerFetchProvider(web.fetchProvider); registered.fetch = true
    return () => { registered.fetch = false; dispose() }
  })
  // ./typert贡献的登记/卸载归宿主Loader所有，不与其异步加载过程抢占登记。
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const filter = (value: AttemptFilter): AttemptFilter => {
    const parsed = filterSchema.safeParse(value)
    if (!parsed.success || (parsed.data.from && parsed.data.to && parsed.data.from >= parsed.data.to)) throw new BillingError('FILTER_INVALID', '日期或筛选条件无效')
    return parsed.data
  }
  const sessionExists = (id: string) => {
    if (!id || id.length > 160 || !ctx.get('agents')?.get(id as never)) throw new BillingError('SESSION_UNAVAILABLE', '该会话未在本profile中打开，请先打开会话后再设置覆盖')
  }
  const listProviders = () => ctx.get('llm')?.listProviders().map(p => ({ id: p.id, name: p.name })) ?? []
  // 未配置时仍返回可展示的状态，避免面板把"未启用"误读成"无数据"。
  const breakerSnapshot = () => {
    const snapshot = structuredClone(currentConfig())
    const settings = snapshot.breaker ?? { enabled: false, failureThreshold: 3, windowMs: 300_000, cooldownMs: 600_000 }
    const now = new Date()
    const observations = db.recentOutcomes(profileId, new Date(now.getTime() - settings.windowMs).toISOString())
    const resets = breakerResets.list(profileId)
    return [...breakerViews(observations, snapshot.channels.map(channel => ({ id: channel.id, name: channel.name })), settings, resets, now.getTime()).values()]
  }
  const budgetSnapshot = () => {
    const snapshot = structuredClone(currentConfig())
    const settings = snapshot.budget ?? { enabled: false, window: 'day' as const, limits: {}, requests: null, onExceed: 'warn' as const }
    const range = budgetWindow(new Date(), settings.window)
    return budgetState(db.budgetUsage(profileId, range.from, range.to), settings, range)
  }
  new BillingController(ctx, {
    getStatus: () => {
      let settings: ReturnType<typeof currentConfig> | undefined
      try { settings = currentConfig() } catch { /* 状态页仍返回可见的配置错误。 */ }
      const selection = webSelection(ctx)
      const diagnostics = routingDiagnostics(settings ?? { channels: [], providerBindings: {}, globalOverrides: {} }, listProviders(), selection.selection, selection.trusted, selection.source, {
        search: { registered: registered.search, available: web.searchProvider.available() },
        fetch: { registered: registered.fetch, available: web.fetchProvider.available() },
      })
      const totalAttempts = db.summary(profileId).reduce((total, row) => total + row.total, 0)
      const latest = db.list(profileId, {}, undefined, 1).items[0]
      return { version: '0.6.1', profileId, namespace: 'dsh-search-ledger', coverage: '仅统计经本插件执行的请求；费用为本地估算', ...diagnostics, configError, totalAttempts, lastAttemptAt: latest?.startedAt ?? null }
    },
    listProviders,
    listChannelStates: () => channels.list(),
    getChannelCredential: (id, ref) => credentials.get(id, ref),
    setChannelCredential: (id, ref, keys) => credentials.set(id, ref, keys),
    unsetChannelCredential: (id, ref) => credentials.unset(id, ref),
    testChannelKeys: (id, ref, operation, keys, count, signature, signal) => keyTester.test(id, ref, operation, keys, count, signal, signature),
    getCandidateStates: async (operation, providerId, sessionId) => {
      if (!['search', 'fetch'].includes(operation) || (providerId !== null && (typeof providerId !== 'string' || providerId.length > 160))) throw new BillingError('INPUT_INVALID', '候选查询参数无效')
      if (sessionId !== null) sessionExists(sessionId)
      const snapshot = structuredClone(currentConfig())
      const overrides = sessionId === null ? {} : db.getOverrides(profileId, sessionId)
      return candidateStates(snapshot, operation, providerId, overrides, async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value, channel => credentials.resolve(channel, false))
    },
    deleteChannel: (id, revision) => channels.deleteChannel(id, revision),
    listBreakerStates: () => breakerSnapshot(),
    resetBreaker: (channelId) => {
      const snapshot = currentConfig()
      if (!snapshot.channels.some(channel => channel.id === channelId)) throw new BillingError('CHANNEL_DISABLED', '渠道不存在，无法复位')
      breakerResets.reset(profileId, channelId, new Date().toISOString())
      return breakerSnapshot()
    },
    getBudgetState: () => budgetSnapshot(),
    exportLedger: (value, format: ExportFormat) => {
      if (format !== 'csv' && format !== 'json') throw new BillingError('INPUT_INVALID', '导出格式无效')
      const { items, truncated } = db.allViews(profileId, filter(value), EXPORT_ROW_LIMIT)
      return buildExport(items, format, truncated, new Date())
    },
    getSummary: value => db.summary(profileId, filter(value)),
    listAttempts: (value, cursor, limit) => db.list(profileId, filter(value), cursor ?? undefined, limit),
    getSessionOverride: id => { sessionExists(id); return db.getOverrides(profileId, id) },
    setSessionOverride: (id, operation, channelId, revision) => {
      sessionExists(id)
      if (operation !== 'search' && operation !== 'fetch') throw new BillingError('INPUT_INVALID', '操作无效')
      if (channelId !== null && !currentConfig().channels.some(c => c.id === channelId && c.enabled && !c.archived && c.capabilities.includes(operation))) throw new BillingError('CHANNEL_DISABLED', '覆盖渠道不存在、停用或缺少能力')
      if (channelId !== null) channels.assertDispatch(channelId)
      return db.setOverride(profileId, id, operation, channelId, revision)
    },
  })
}
