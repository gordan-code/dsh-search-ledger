// 诊断只读取配置与本地账本；不探测网络、不解析或回传凭证值。
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { Operation, ProviderRouteView, ProviderView, RouteStatus, RoutingConfig, WebOperationStatus } from '../contracts.ts'

export function webSelection(ctx: Context): { selection: Record<Operation, string | undefined>; trusted: boolean; source: WebOperationStatus['selectionSource'] } {
  // ConfigEditor公开entry/fiber接口提供被实例实际持有的volatile配置；不读取WebRuntime私有字段或Map。
  const entries = ctx.get('configEditor')?.entries().filter((row: { options: { name?: string }; fiber: { config: unknown } }) => row.options.name === '@deepseek-ai/dsh-web') ?? []
  const entry = entries.length === 1 ? entries[0] : undefined
  const config = entry?.fiber.config as { searchProvider?: { get(): string | undefined }; fetchProvider?: { get(): string | undefined } } | undefined
  if (typeof config?.searchProvider?.get === 'function' && typeof config?.fetchProvider?.get === 'function') {
    return { selection: { search: config.searchProvider.get(), fetch: config.fetchProvider.get() }, trusted: true, source: 'runtime-entry' }
  }
  const descriptor = ctx.get('settings')?.describe({ redactSecrets: true }).find(row => String(row.ns) === 'web')
  const value = descriptor?.value as { searchProvider?: string; fetchProvider?: string } | undefined
  return { selection: { search: value?.searchProvider, fetch: value?.fetchProvider }, trusted: false, source: value ? 'settings-only' : 'unknown' }
}

export function routeStatus(config: RoutingConfig, providerId: string, operation: Operation): RouteStatus {
  const global = config.globalOverrides[operation]
  const binding = config.providerBindings[providerId]?.[operation]
  const preferred = global ?? binding ?? null
  const ordered = config.failover?.[operation]?.enabled === true
  const eligible = config.channels.filter(c => c.enabled && !c.archived && c.capabilities.includes(operation))
  const channelId = ordered ? (eligible.find(c => c.id === preferred) ?? eligible[0])?.id ?? null : preferred
  const source = channelId !== preferred && ordered ? 'ordered' : global ? 'global' : binding ? 'binding' : 'none'
  const channel = config.channels.find(c => c.id === channelId)
  const reason = !channelId ? '未绑定渠道；原生请求将于派发前被拒绝'
    : !channel || channel.archived ? '所选渠道已删除或不存在'
    : !channel.enabled ? '所选渠道已停用'
    : !channel.capabilities.includes(operation) ? '所选渠道不支持此操作'
    : null
  return { channelId, source, ready: reason === null, reason }
}

export function routingDiagnostics(config: RoutingConfig, providers: ProviderView[], selection: Record<Operation, string | undefined>, trusted = true, source: WebOperationStatus['selectionSource'] = 'runtime-entry', evidence: Record<Operation, { registered: boolean; available: boolean }> = { search: { registered: false, available: false }, fetch: { registered: false, available: false } }) {
  const operation = (op: Operation): WebOperationStatus => {
    const own = trusted && selection[op] === (op === 'search' ? 'web-search-metered' : 'web-fetch-metered')
    return { providerId: selection[op] ?? null, metered: own && evidence[op].registered && evidence[op].available, selectionSource: source, registered: own ? evidence[op].registered : null, available: own ? evidence[op].available : null }
  }
  const operations = { search: operation('search'), fetch: operation('fetch') }
  const ids = new Set([...providers.map(p => p.id), ...Object.keys(config.providerBindings)])
  const routes: ProviderRouteView[] = [...ids].map(providerId => ({ providerId, search: routeStatus(config, providerId, 'search'), fetch: routeStatus(config, providerId, 'fetch') }))
  const issues: string[] = []
  for (const op of ['search', 'fetch'] as const) {
    if (!operations[op].metered) issues.push(`${op === 'search' ? 'Search' : 'Fetch'} 当前后端为 ${operations[op].providerId ?? '未显式选择'}，尚未确认由计费后端接管`)
    const missing = routes.filter(route => !route[op].ready).length
    if (missing) issues.push(`${missing} 个Provider的${op === 'search' ? 'Search' : 'Fetch'}未绑定可用渠道（不含独立会话覆盖）`)
    if (config.globalOverrides[op] && !routeStatus(config, '', op).ready) issues.push(`全局 ${op} 覆盖无效：${routeStatus(config, '', op).reason}`)
    else if (!routes.length && !config.globalOverrides[op] && !config.failover?.[op]?.enabled) issues.push(`${op} 尚未绑定渠道，请设置Provider绑定或全局覆盖`)
  }
  return { operations, routes, issues, active: operations.search.metered && operations.fetch.metered }
}
