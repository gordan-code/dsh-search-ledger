// 有序故障转移候选解析；只构造冻结快照，不读取凭证或派发网络请求。
import { createHash } from 'node:crypto'
import { BillingError } from '../contracts.ts'
import type { Channel, Operation, RequestSource, RouteSnapshot, RoutingConfig } from '../contracts.ts'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(item => freeze(item))
    Object.freeze(value)
  }
  return value
}

function revision(config: RoutingConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20)
}

function failoverEnabled(config: RoutingConfig, operation: Operation): boolean {
  return config.failover?.[operation]?.enabled === true
}

function usable(channel: Channel, operation: Operation): boolean {
  return channel.enabled === true && channel.archived !== true && channel.capabilities.includes(operation) && channel.prices[operation] !== undefined
}

function routeSnapshot(source: RequestSource, operation: Operation, channel: Channel, configRevision: string, routeSource: RouteSnapshot['routeSource']): RouteSnapshot {
  const price = channel.prices[operation]
  if (price === undefined) throw new BillingError('CAPABILITY_UNSUPPORTED', '所选渠道缺少该操作价格')
  return freeze({
    ...structuredClone(source), operation,
    channel: structuredClone(channel), price: structuredClone(price), configRevision, routeSource,
  })
}

/**
 * 解析一次原生操作的完整候选链。
 * 默认关闭时严格复用旧 resolveRoute 的单一绑定语义；开启后按会话覆盖、全局覆盖、provider绑定、配置顺序去重。
 */
export function resolveCandidates(
  config: RoutingConfig,
  source: RequestSource,
  operation: Operation,
  overrides: Partial<Record<Operation, string | null>> = {},
): readonly RouteSnapshot[] {
  const configRevision = revision(config)
  const sessionId = source.sessionId ? overrides[operation] : undefined
  const globalId = config.globalOverrides[operation]
  const bindingId = source.sourceProviderId ? config.providerBindings[source.sourceProviderId]?.[operation] : undefined
  const preferred = sessionId
    ? { id: sessionId, routeSource: 'session' as const }
    : globalId
      ? { id: globalId, routeSource: 'global' as const }
      : bindingId
        ? { id: bindingId, routeSource: 'binding' as const }
        : undefined

  if (!failoverEnabled(config, operation)) {
    const selected = preferred
    if (selected === undefined) throw new BillingError('ROUTE_UNBOUND', '当前provider未绑定渠道，请配置绑定或独立覆盖')
    const channel = config.channels.find(item => item.id === selected.id)
    if (channel === undefined || !channel.enabled || channel.archived) throw new BillingError('CHANNEL_DISABLED', '所选渠道不存在、已停用或已删除')
    if (!channel.capabilities.includes(operation)) throw new BillingError('CAPABILITY_UNSUPPORTED', '所选渠道不支持该操作')
    return freeze([routeSnapshot(source, operation, channel, configRevision, selected.routeSource)])
  }

  const byId = new Map(config.channels.map(channel => [channel.id, channel]))
  const seen = new Set<string>()
  const routes: RouteSnapshot[] = []
  if (preferred !== undefined) {
    seen.add(preferred.id)
    const channel = byId.get(preferred.id)
    if (channel !== undefined && usable(channel, operation)) routes.push(routeSnapshot(source, operation, channel, configRevision, preferred.routeSource))
  }
  for (const channel of config.channels) {
    if (seen.has(channel.id)) continue
    seen.add(channel.id)
    if (!usable(channel, operation)) continue
    routes.push(routeSnapshot(source, operation, channel, configRevision, 'ordered'))
  }
  return freeze(routes)
}
