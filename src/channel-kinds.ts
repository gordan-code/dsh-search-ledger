import type { BillingClass, Channel, ChannelKind, Operation } from './contracts.ts'

/** 浏览器安全的渠道能力元数据；不依赖 Node、凭证宿主或网络。 */
export interface ChannelKindDefinition {
  kind: ChannelKind
  billingClass: BillingClass | readonly BillingClass[]
  capabilities: readonly Operation[]
  requiresCredential: boolean
}

export const CHANNEL_KINDS: Readonly<Record<ChannelKind, ChannelKindDefinition>> = Object.freeze({
  'deepseek-api': { kind: 'deepseek-api', billingClass: ['official', 'relay'], capabilities: ['search', 'fetch'], requiresCredential: true },
  searxng: { kind: 'searxng', billingClass: 'free', capabilities: ['search'], requiresCredential: false },
  tavily: { kind: 'tavily', billingClass: ['free', 'service'], capabilities: ['search', 'fetch'], requiresCredential: true },
  'local-http': { kind: 'local-http', billingClass: 'free', capabilities: ['fetch'], requiresCredential: false },
  tinyfish: { kind: 'tinyfish', billingClass: 'service', capabilities: ['search', 'fetch'], requiresCredential: true },
  qianfan: { kind: 'qianfan', billingClass: 'service', capabilities: ['search'], requiresCredential: true },
})

export function kindDefinition(kind: ChannelKind): ChannelKindDefinition {
  return CHANNEL_KINDS[kind]
}

export function requiresCredential(channel: Channel | ChannelKind): boolean {
  const kind = typeof channel === 'string' ? channel : channel.kind
  return CHANNEL_KINDS[kind].requiresCredential
}

export function supportsOperation(channel: Channel | ChannelKind, operation: Operation): boolean {
  const kind = typeof channel === 'string' ? channel : channel.kind
  return CHANNEL_KINDS[kind].capabilities.includes(operation)
}
