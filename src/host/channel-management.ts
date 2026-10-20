// 删除仅归档配置身份，不擦除账本；原生派发前再检查，防止陈旧表单/快照继续使用。
import { BillingError } from '../contracts.ts'
import type { Channel, ChannelState, RoutingConfig } from '../contracts.ts'
export interface ChannelManagementDeps {
  readConfig(): RoutingConfig
  isUsed(id: string): boolean
  sessionReferenceCount(id: string): number
  saveChannels(channels: Channel[], revision: number): Promise<number>
}
export class ChannelManagement {
  private readonly deleting = new Set<string>()
  constructor(private readonly deps: ChannelManagementDeps) {}
  list(): ChannelState[] {
    const config = this.deps.readConfig()
    return config.channels.map(channel => {
      const references: string[] = []
      for (const operation of ['search', 'fetch'] as const) {
        if (config.globalOverrides[operation] === channel.id) references.push(`全局 ${operation}`)
        for (const [provider, binding] of Object.entries(config.providerBindings)) if (binding[operation] === channel.id) references.push(`Provider ${provider} · ${operation}`)
      }
      const sessions = this.deps.sessionReferenceCount(channel.id)
      if (sessions) references.push(`${sessions} 项会话覆盖`)
      const used = this.deps.isUsed(channel.id)
      const reason = channel.archived ? '渠道已删除'
        : used ? '已有历史账目，仍可正常使用；不可删除或更换地址归属，不再使用时可停用'
        : references.length ? '请先解除绑定或覆盖后再删除'
        : this.deleting.has(channel.id) ? '渠道删除进行中'
        : null
      return { id: channel.id, used, canDelete: reason === null, reason, references }
    })
  }
  async deleteChannel(id: string, revision: number): Promise<number> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !Number.isSafeInteger(revision) || revision < 0) throw new BillingError('INPUT_INVALID', '渠道ID或配置版本无效')
    const state = this.list().find(state => state.id === id)
    if (!state) throw new BillingError('CHANNEL_MISSING', '渠道不存在，请重新读取配置')
    if (!state.canDelete) throw new BillingError(state.used ? 'CHANNEL_IN_USE' : 'CHANNEL_REFERENCED', state.reason ?? '渠道不能删除')
    this.deleting.add(id)
    try {
      const channels = this.deps.readConfig().channels.map(channel => channel.id === id ? { ...channel, enabled: false, archived: true } : channel)
      return await this.deps.saveChannels(channels, revision)
    } finally { this.deleting.delete(id) }
  }
  assertDispatch(id: string): void {
    const channel = this.deps.readConfig().channels.find(channel => channel.id === id)
    if (this.deleting.has(id) || !channel || channel.archived) throw new BillingError('CHANNEL_REMOVED', '渠道已删除或正在删除，未派发请求')
  }
}
