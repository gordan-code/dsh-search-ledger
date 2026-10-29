import { describe, expect, it } from 'vitest'
import { breakerViews, coolingChannels } from '../../src/accounting/breaker.ts'
import type { BreakerObservation } from '../../src/accounting/breaker.ts'
import type { BreakerSettings, Outcome } from '../../src/contracts.ts'

const channels = [{ id: 'a', name: '渠道A' }, { id: 'b', name: '渠道B' }]
const now = Date.parse('2026-10-28T02:00:00.000Z')

function settings(overrides: Partial<BreakerSettings> = {}): BreakerSettings {
  return { enabled: true, failureThreshold: 3, windowMs: 300_000, cooldownMs: 600_000, ...overrides }
}

function observation(channelId: string, outcome: Outcome, secondsAgo: number): BreakerObservation {
  return { channelId, outcome, startedAt: new Date(now - secondsAgo * 1000).toISOString() }
}

function view(observations: BreakerObservation[], overrides: Partial<BreakerSettings> = {}, resets: Record<string, string> = {}) {
  return breakerViews(observations, channels, settings(overrides), resets, now).get('a')!
}

describe('breakerViews', () => {
  it('未达阈值时不开启', () => {
    const result = view([observation('a', 'failed', 10), observation('a', 'failed', 20)])
    expect(result.open).toBe(false)
    expect(result.failures).toBe(2)
    expect(result.cooldownUntil).toBeNull()
  })

  it('连续失败达到阈值后开启并给出冷却结束时间', () => {
    const result = view([observation('a', 'failed', 10), observation('a', 'unknown', 20), observation('a', 'failed', 30)])
    expect(result.open).toBe(true)
    expect(result.failures).toBe(3)
    expect(result.cooldownUntil).toBe(new Date(now - 10_000 + 600_000).toISOString())
    expect(result.lastFailureAt).toBe(new Date(now - 10_000).toISOString())
  })

  it('成功记录打断连续计数', () => {
    const result = view([
      observation('a', 'failed', 10),
      observation('a', 'failed', 20),
      observation('a', 'billable', 30),
      observation('a', 'failed', 40),
    ])
    expect(result.failures).toBe(2)
    expect(result.open).toBe(false)
  })

  it('空结果不算失败', () => {
    const result = view([observation('a', 'empty', 10), observation('a', 'empty', 20), observation('a', 'empty', 30)])
    expect(result.failures).toBe(0)
    expect(result.open).toBe(false)
  })

  it('窗口之外的失败不计入', () => {
    const result = view([
      observation('a', 'failed', 10),
      observation('a', 'failed', 1_000),
      observation('a', 'failed', 2_000),
    ])
    expect(result.failures).toBe(1)
    expect(result.open).toBe(false)
  })

  it('冷却结束后自动闭合，但保留失败计数证据', () => {
    const result = view(
      [observation('a', 'failed', 700), observation('a', 'failed', 710), observation('a', 'failed', 720)],
      { windowMs: 3_600_000 },
    )
    expect(result.failures).toBe(3)
    expect(result.open).toBe(false)
    expect(result.cooldownUntil).toBeNull()
    expect(result.lastFailureAt).toBe(new Date(now - 700_000).toISOString())
  })

  it('复位标记之前的失败不再计入', () => {
    const result = view(
      [observation('a', 'failed', 10), observation('a', 'failed', 20), observation('a', 'failed', 30)],
      {},
      { a: new Date(now - 15_000).toISOString() },
    )
    expect(result.failures).toBe(1)
    expect(result.open).toBe(false)
    expect(result.resetAt).toBe(new Date(now - 15_000).toISOString())
  })

  it('未启用时不开启，但仍报告失败次数', () => {
    const result = view([observation('a', 'failed', 10), observation('a', 'failed', 20), observation('a', 'failed', 30)], { enabled: false })
    expect(result.failures).toBe(3)
    expect(result.open).toBe(false)
  })

  it('只统计本渠道的记录', () => {
    const map = breakerViews(
      [observation('a', 'failed', 10), observation('b', 'failed', 20), observation('b', 'failed', 30), observation('b', 'failed', 40)],
      channels, settings(), {}, now,
    )
    expect(map.get('a')!.failures).toBe(1)
    expect(map.get('b')!.failures).toBe(3)
    expect(map.get('b')!.open).toBe(true)
  })

  it('时间不可解析的记录不参与判定', () => {
    const result = view([{ channelId: 'a', outcome: 'failed', startedAt: 'not-a-time' }])
    expect(result.failures).toBe(0)
    expect(result.open).toBe(false)
  })
})

describe('coolingChannels', () => {
  it('只返回冷却中的渠道', () => {
    const map = breakerViews([
      observation('a', 'failed', 10), observation('a', 'failed', 20), observation('a', 'failed', 30),
      observation('b', 'failed', 10),
    ], channels, settings(), {}, now)
    expect([...coolingChannels(map)]).toEqual(['a'])
  })
})
