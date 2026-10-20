// 按发起会话的provider解析渠道；返回与后续配置变更隔离的快照。
import { createHash } from 'node:crypto'
import { BillingError } from '../contracts.ts'
import type { Channel, Operation, RequestSource, RouteSnapshot, RoutingConfig } from '../contracts.ts'
export { parseRoutingConfig, DEFAULT_CONFIG } from '../config-schema.ts'
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
export function resolveRoute(config: RoutingConfig, source: RequestSource, operation: Operation, overrides: Partial<Record<Operation, string | null>> = {}): RouteSnapshot {
  const session = source.sessionId ? overrides[operation] : undefined; const global = config.globalOverrides[operation]
  const id = session ?? global ?? (source.sourceProviderId ? config.providerBindings[source.sourceProviderId]?.[operation] : undefined)
  if (!id) throw new BillingError('ROUTE_UNBOUND', '当前provider未绑定渠道，请配置绑定或独立覆盖')
  const channel = config.channels.find(item => item.id === id)
  if (!channel || !channel.enabled || channel.archived) throw new BillingError('CHANNEL_DISABLED', '所选渠道不存在、已停用或已删除')
  if (!channel.capabilities.includes(operation)) throw new BillingError('CAPABILITY_UNSUPPORTED', '所选渠道不支持该操作')
  return freeze({ ...structuredClone(source), operation, channel: structuredClone(channel), price: structuredClone(channel.prices[operation]!), configRevision: createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20), routeSource: session ? 'session' : global ? 'global' : 'binding' })
}
export function assertChannelIdentity(previous: Channel[], next: Channel[]): void {
  for (const old of previous) {
    const item = next.find(channel => channel.id === old.id)
    if (!item || old.kind !== item.kind || old.billingClass !== item.billingClass || old.endpointBase !== item.endpointBase) throw new BillingError('CHANNEL_IDENTITY_CHANGED', '渠道不能删除或改变地址/分类，请停用旧渠道并新建ID')
  }
}
