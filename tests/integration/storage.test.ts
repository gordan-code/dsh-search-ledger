import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttemptResult, AttemptStart } from '../../src/contracts.ts'
import { BillingDatabase } from '../../src/storage/database.ts'

const roots: string[] = []
const makeDb = () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-billing-test-'))
  roots.push(root)
  return new BillingDatabase(join(root, 'billing.sqlite'))
}
const start = (overrides: Partial<AttemptStart> = {}): AttemptStart => ({
  attemptId: `attempt-${Math.random()}`,
  operationId: 'operation-1',
  ownerToken: 'owner-1',
  operation: 'search',
  profileId: 'profile-a',
  sessionId: 'session-a',
  sourceProviderId: 'provider-a',
  sourceModel: 'model-a',
  channelId: 'channel-a',
  channelName: '测试渠道',
  channelKind: 'deepseek-api',
  endpointOrigin: 'https://example.test',
  price: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' },
  configRevision: 'r1',
  startedAt: new Date().toISOString(),
  ...overrides,
})
const result = (overrides: Partial<AttemptResult> = {}): AttemptResult => ({
  outcome: 'billable',
  status: 200,
  resultCount: 1,
  hasContent: true,
  completedAt: new Date().toISOString(),
  ...overrides,
})

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('账本数据库', () => {
  it('按 owner 条件派发和结算一次，并冻结开始时价格', () => {
    const db = makeDb()
    const first = start()
    db.prepare(first)
    expect(db.dispatch(first.attemptId, 'wrong-owner')).toBe(false)
    expect(db.dispatch(first.attemptId, first.ownerToken)).toBe(true)
    expect(db.finish(first.attemptId, 'wrong-owner', result())).toBe(false)
    expect(db.finish(first.attemptId, first.ownerToken, result())).toBe(true)
    expect(db.finish(first.attemptId, first.ownerToken, result())).toBe(false)
    const [item] = db.list(first.profileId).items
    expect(item.outcome).toBe('billable')
    expect(item.amountMicros).toBe('5000')
    expect(item.status).toBe(200)
    expect(db.summary(first.profileId)).toEqual([expect.objectContaining({ billable: 1, amountMicros: '5000', quotaCredits: 0 })])
    db.close()
  })

  it('将 prepared/dispatching 投影为未知且不自动抢占', () => {
    const db = makeDb()
    const first = start({ attemptId: 'prepared' })
    db.prepare(first)
    expect(db.list(first.profileId).items[0].outcome).toBe('unknown')
    expect(db.dispatch(first.attemptId, 'other-owner')).toBe(false)
    expect(db.list(first.profileId).items[0].outcome).toBe('unknown')
    db.close()
  })

  it('按 subject/window 跨 profile 和 channel 共享额度，取消 prepared 释放预留', () => {
    const db = makeDb()
    const quota = { subject: 'same-key', window: '2026-10', limit: 2, credits: 1 }
    const a = start({ attemptId: 'quota-a', quota })
    const b = start({ attemptId: 'quota-b', profileId: 'profile-b', channelId: 'channel-b', ownerToken: 'owner-b', quota })
    const c = start({ attemptId: 'quota-c', profileId: 'profile-c', ownerToken: 'owner-c', quota })
    db.prepare(a)
    db.prepare(b)
    expect(() => db.prepare(c)).toThrow()
    expect(db.cancelPrepared(a.attemptId, a.ownerToken)).toBe(true)
    db.prepare(c)
    expect(() => db.prepare(start({ attemptId: 'quota-conflict', ownerToken: 'owner-x', quota: { ...quota, limit: 3 } }))).toThrow()
    db.close()
  })

  it('使用 revision 保护会话覆盖且按 profile 隔离', () => {
    const db = makeDb()
    expect(db.getOverrides('profile-a', 'session-a')).toEqual({ revision: 0, search: null, fetch: null })
    expect(db.setOverride('profile-a', 'session-a', 'search', 'channel-a', 0)).toEqual({ revision: 1, search: 'channel-a', fetch: null })
    expect(() => db.setOverride('profile-a', 'session-a', 'fetch', 'channel-b', 0)).toThrow()
    expect(db.getOverrides('profile-b', 'session-a')).toEqual({ revision: 0, search: null, fetch: null })
    db.close()
  })

  it('同毫秒按 attemptId 稳定分页，并按币种分别汇总未知价格', () => {
    const db = makeDb()
    const startedAt = '2026-10-19T00:00:00.000Z'
    const a = start({ attemptId: 'same-a', ownerToken: 'owner-a', startedAt, price: { perThousand: null, currency: 'USD', policy: 'official-nonempty' } })
    const b = start({ attemptId: 'same-b', ownerToken: 'owner-b', startedAt, price: { perThousand: '0', currency: 'USD', policy: 'official-nonempty' } })
    db.prepare(a); db.prepare(b)
    db.dispatch(a.attemptId, a.ownerToken); db.dispatch(b.attemptId, b.ownerToken)
    db.finish(a.attemptId, a.ownerToken, result({ completedAt: startedAt }))
    db.finish(b.attemptId, b.ownerToken, result({ completedAt: startedAt }))
    const first = db.list(a.profileId, {}, undefined, 1)
    expect(first.items[0].attemptId).toBe('same-b')
    expect(first.nextCursor).not.toBeNull()
    const second = db.list(a.profileId, {}, first.nextCursor!, 1)
    expect(second.items[0].attemptId).toBe('same-a')
    expect(second.nextCursor).toBeNull()
    const summary = db.summary(a.profileId)
    expect(summary).toEqual([expect.objectContaining({ currency: 'USD', amountMicros: '0', priceUnknown: 1, billable: 2 })])
    db.close()
  })

  it('同一 channelId 改名后汇总仍合并，并显示最新快照名称', () => {
    const db = makeDb()
    const oldAttempt = start({ attemptId: 'rename-old', ownerToken: 'rename-owner-old', channelName: '旧渠道名', startedAt: '2026-10-19T00:00:00.000Z' })
    const newAttempt = start({ attemptId: 'rename-new', ownerToken: 'rename-owner-new', channelName: '新渠道名', startedAt: '2026-10-19T00:00:01.000Z' })
    db.prepare(oldAttempt); db.prepare(newAttempt)
    db.dispatch(oldAttempt.attemptId, oldAttempt.ownerToken); db.dispatch(newAttempt.attemptId, newAttempt.ownerToken)
    db.finish(oldAttempt.attemptId, oldAttempt.ownerToken, result({ completedAt: oldAttempt.startedAt }))
    db.finish(newAttempt.attemptId, newAttempt.ownerToken, result({ completedAt: newAttempt.startedAt }))
    expect(db.summary(oldAttempt.profileId)).toEqual([expect.objectContaining({ channelId: 'channel-a', channelName: '新渠道名', total: 2, billable: 2 })])
    db.close()
  })

  it('额度窗口必须是 startedAt 对应的可信 UTC 月份', () => {
    const db = makeDb()
    const valid = start({ attemptId: 'month-valid', ownerToken: 'month-owner-valid', startedAt: '2026-10-19T23:59:59.000Z', quota: { subject: 'month-key', window: '2026-10', limit: 2, credits: 1 } })
    db.prepare(valid)
    expect(() => db.prepare(start({ attemptId: 'month-arbitrary', ownerToken: 'month-owner-arbitrary', startedAt: '2026-10-19T23:59:59.000Z', quota: { subject: 'month-key', window: 'not-a-month', limit: 2, credits: 1 } }))).toThrow()
    expect(() => db.prepare(start({ attemptId: 'month-mismatch', ownerToken: 'month-owner-mismatch', startedAt: '2026-10-19T23:59:59.000Z', quota: { subject: 'month-key', window: '2026-11', limit: 2, credits: 1 } }))).toThrow()
    expect(() => db.prepare(start({ attemptId: 'month-invalid-start', ownerToken: 'month-owner-invalid-start', startedAt: 'not-an-iso-time', quota: { subject: 'month-key', window: '2026-10', limit: 2, credits: 1 } }))).toThrow()
    db.close()
  })
})
