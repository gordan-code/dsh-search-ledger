import type { CandidateState, Channel, Operation, RoutingConfig } from '../contracts.ts'
import { requiresCredential } from '../channel-kinds.ts'
import { abortable } from '../accounting/failover.ts'

/** 仅凭证引用解析，无网络认证；绝不返回Key或底层错误文本。 */
export async function candidateStates(config: RoutingConfig, operation: Operation, providerId: string | null, overrides: Partial<Record<Operation, string | null>>, resolveCredential: (ref: string) => Promise<string | undefined>, resolveChannelCredentials?: (channel: Channel) => Promise<string[]>): Promise<CandidateState[]> {
  const preferred = overrides[operation] ?? config.globalOverrides[operation] ?? (providerId ? config.providerBindings[providerId]?.[operation] : undefined)
  const channels = config.channels.filter(c => c.enabled && !c.archived && c.capabilities.includes(operation))
  const sorted = [...channels.filter(c => c.id === preferred), ...channels.filter(c => c.id !== preferred)]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const rows: CandidateState[] = []
    for (const channel of sorted) {
      let credentialReady = true; let reason: string | null = null
      if (requiresCredential(channel)) {
        if (!channel.credentialRef && !resolveChannelCredentials) { credentialReady = false; reason = '未配置凭证' }
        else if (controller.signal.aborted) { credentialReady = false; reason = '凭证暂不可读取' }
        else {
          try {
            const keys = await abortable(Promise.resolve().then(() => resolveChannelCredentials ? resolveChannelCredentials(channel) : resolveCredential(channel.credentialRef!).then(key => key ? [key] : [])), controller.signal)
            credentialReady = keys.some(key => typeof key === 'string' && key.trim().length > 0)
            if (!credentialReady) reason = '未配置凭证'
          } catch { credentialReady = false; reason = '凭证暂不可读取' }
        }
      }
      rows.push({ channelId: channel.id, capabilities: [...channel.capabilities], credentialReady, reason })
    }
    return rows
  } finally { clearTimeout(timer) }
}
