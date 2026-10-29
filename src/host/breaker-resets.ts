// 只保存人工复位标记；熔断状态本身始终由账本终态推导，避免两份状态互相漂移。
import { DatabaseSync } from 'node:sqlite'
import { BillingError } from '../contracts.ts'
export class BreakerResets {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS breaker_resets (
        profile_id TEXT NOT NULL, channel_id TEXT NOT NULL, reset_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, channel_id))`)
  }
  list(profileId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT channel_id, reset_at FROM breaker_resets WHERE profile_id=?').all(profileId)
    const resets: Record<string, string> = {}
    for (const row of rows) resets[String(row.channel_id)] = String(row.reset_at)
    return resets
  }
  /** 复位后只统计该时刻之后的终态；写入必须早于后续派发，否则新失败会被旧标记吞掉。 */
  reset(profileId: string, channelId: string, resetAt: string): void {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(channelId)) throw new BillingError('INVALID_ARGUMENT', '渠道ID无效')
    if (!Number.isFinite(Date.parse(resetAt))) throw new BillingError('INVALID_ARGUMENT', '复位时间无效')
    this.db.prepare('INSERT INTO breaker_resets(profile_id, channel_id, reset_at) VALUES(?,?,?) ON CONFLICT(profile_id, channel_id) DO UPDATE SET reset_at=excluded.reset_at').run(profileId, channelId, resetAt)
  }
  close(): void { this.db.close() }
}
