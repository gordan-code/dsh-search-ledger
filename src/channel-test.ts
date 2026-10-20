// 浏览器/Host共用的确认快照，仅含公开渠道配置，不含Key。
import type { Channel, Operation } from './contracts.ts'
export function channelTestSignature(channel: Channel, operation: Operation): string {
  const price = channel.prices[operation]
  return JSON.stringify([channel.id, channel.name, channel.kind, channel.billingClass, channel.enabled, channel.archived ?? false,
    channel.endpointBase, channel.credentialRef ?? '', [...channel.capabilities].sort(), operation,
    price?.perThousand ?? null, price?.currency ?? null, price?.policy ?? null, channel.monthlyCredits ?? 1000])
}
