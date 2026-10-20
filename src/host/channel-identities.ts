// 与账本同目录、同安装持久化；防止重启后复用渠道ID混合不同中转账目。
import { DatabaseSync } from 'node:sqlite'
import type { Channel, Operation, RouteSnapshot } from '../contracts.ts'
import { BillingError } from '../contracts.ts'
import { endpointFor } from '../providers/common.ts'
export class ChannelIdentities {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channel_identities (
        profile_id TEXT NOT NULL, channel_id TEXT NOT NULL, identity TEXT NOT NULL,
        PRIMARY KEY(profile_id, channel_id));
      CREATE TABLE IF NOT EXISTS channel_retirements (
        profile_id TEXT NOT NULL, channel_id TEXT NOT NULL, identity TEXT NOT NULL,
        PRIMARY KEY(profile_id, channel_id))`)
  }
  private identity(channel: Channel): string {
    return JSON.stringify([channel.kind, channel.billingClass, channel.endpointBase])
  }
  assertConfig(profileId: string, channels: Channel[]): void {
    const rows = this.db.prepare('SELECT channel_id, identity FROM channel_identities WHERE profile_id=?').all(profileId)
    for (const row of rows) {
      const channel = channels.find(c => c.id === row.channel_id)
      if (!channel || this.identity(channel) !== row.identity) throw new BillingError('CHANNEL_IDENTITY_CHANGED', '已有请求的渠道不能删除或改变地址/分类，请停用旧渠道并新建ID')
    }
    const retirements = this.db.prepare('SELECT channel_id, identity FROM channel_retirements WHERE profile_id=?').all(profileId)
    for (const row of retirements) {
      const channel = channels.find(c => c.id === row.channel_id)
      if (!channel?.archived || channel.enabled || this.identity(channel) !== row.identity) throw new BillingError('CHANNEL_IDENTITY_CHANGED', '已归档渠道的ID不能移除、重新启用或复用')
    }
    // 兼容有旧账本而无身份行的记录：只用原本保存的kind/origin核对，再冻结当前完整身份。
    // 旧账本不包含endpoint路径，不能声称恢复了未知的历史路径。
    const hasAttempts = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attempts'").get()
    if (hasAttempts) {
      const legacy = this.db.prepare('SELECT DISTINCT a.channel_id, a.channel_kind, a.operation, a.endpoint_origin FROM attempts a LEFT JOIN channel_identities i ON i.profile_id=a.profile_id AND i.channel_id=a.channel_id WHERE a.profile_id=? AND i.channel_id IS NULL').all(profileId)
      for (const row of legacy) {
        const channel = channels.find(c => c.id === row.channel_id)
        let origin: string | undefined
        try {
          origin = channel?.kind === 'local-http' ? undefined : new URL(endpointFor(channel!, row.operation as Operation)).origin
        } catch { /* 无效地址不匹配。 */ }
        if (!channel || channel.kind !== row.channel_kind || (channel.kind !== 'local-http' && origin !== row.endpoint_origin)) throw new BillingError('CHANNEL_IDENTITY_CHANGED', '旧账本渠道缺失或服务归属改变，请保留原ID并使用新渠道')
      }
      for (const row of legacy) {
        const channel = channels.find(c => c.id === row.channel_id)!
        this.db.prepare('INSERT OR IGNORE INTO channel_identities(profile_id,channel_id,identity) VALUES(?,?,?)').run(profileId, channel.id, this.identity(channel))
      }
    }
    for (const channel of channels.filter(c => c.archived)) this.db.prepare('INSERT OR IGNORE INTO channel_retirements(profile_id,channel_id,identity) VALUES(?,?,?)').run(profileId, channel.id, this.identity(channel))
  }
  remember(route: RouteSnapshot): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('SELECT 1 FROM channel_retirements WHERE profile_id=? AND channel_id=?').get(route.profileId, route.channel.id)) throw new BillingError('CHANNEL_REMOVED', '已归档渠道不能派发请求')
      this.db.prepare('INSERT OR IGNORE INTO channel_identities(profile_id, channel_id, identity) VALUES(?,?,?)').run(route.profileId, route.channel.id, this.identity(route.channel))
      const row = this.db.prepare('SELECT identity FROM channel_identities WHERE profile_id=? AND channel_id=?').get(route.profileId, route.channel.id)
      if (row?.identity !== this.identity(route.channel)) throw new BillingError('CHANNEL_IDENTITY_CHANGED', '该渠道ID已用于不同服务地址，请使用新渠道ID')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  isUsed(profileId: string, channelId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM channel_identities WHERE profile_id=? AND channel_id=?').get(profileId, channelId)
  }
  close(): void { this.db.close() }
}
