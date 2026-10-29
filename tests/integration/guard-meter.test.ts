import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BudgetSettings, Channel, Outcome, RoutingConfig } from '../../src/contracts.ts'
import { BillingDatabase } from '../../src/storage/database.ts'
import { MeteredWeb } from '../../src/accounting/meter.ts'

const channel = (id: string): Channel => ({ id, name: id, kind: 'deepseek-api', billingClass: 'relay', enabled: true, endpointBase: `https://${id}.example/v1/tools`, credentialRef: id.toUpperCase(), capabilities: ['search'], prices: { search: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' } } })
const success = () => new Response(JSON.stringify({ results: [{ url: 'https://result.example/' }], content: 'text' }))

/** 直接写账本终态，模拟"历史失败"；不走 meter，避免测试自身产生副作用。 */
function seed(db: BillingDatabase, channelId: string, outcome: Outcome, startedAt: string): void {
  const attemptId = randomUUID()
  db.prepare({
    attemptId, operationId: `op-${attemptId}`, ownerToken: 'seed', profileId: 'p', operation: 'search',
    channelId, channelName: channelId, channelKind: 'deepseek-api', endpointOrigin: `https://${channelId}.example`,
    price: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' },
    configRevision: 'r1', startedAt,
  })
  db.dispatch(attemptId, 'seed')
  db.finish(attemptId, 'seed', { outcome, completedAt: startedAt, status: outcome === 'failed' ? 500 : 200 })
}

function setup(httpFetch: typeof fetch, extra: Partial<RoutingConfig> = {}) {
  const db = new BillingDatabase(':memory:')
  const config: RoutingConfig = {
    channels: [channel('a'), channel('b'), channel('c')],
    providerBindings: {
      source: { search: 'a' },
    },
    globalOverrides: {},
    failover: { search: { enabled: true, attemptTimeoutMs: 1_000, totalTimeoutMs: 4_000 } },
    ...extra,
  }
  const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => 'synthetic-key', quotaSubject: () => 'fingerprint', httpFetch })
  return { db, config, meter }
}

function ageSeconds(seconds: number): string {
  return new Date(Date.now() - seconds * 1_000).toISOString()
}

const breaker = { enabled: true, failureThreshold: 2, windowMs: 300_000, cooldownMs: 600_000 }
const budget = (overrides: Partial<BudgetSettings> = {}): BudgetSettings => ({ enabled: true, window: 'day', limits: {}, requests: null, onExceed: 'warn', ...overrides })

afterEach(() => vi.useRealTimers())

describe('熔断闸门', () => {
  it('连续失败达到阈值的渠道不再参与派发', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { breaker })
    seed(db, 'a', 'failed', ageSeconds(5)); seed(db, 'a', 'failed', ageSeconds(10))
    try {
      await expect(meter.search({ query: 'q' })).resolves.toBeDefined()
      expect(http).toHaveBeenCalledTimes(1)
      expect(String(http.mock.calls[0]![0])).toContain('b.example')
    } finally { db.close() }
  })

  it('全部候选都在冷却时零派发并说明原因', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { breaker })
    for (const id of ['a', 'b', 'c']) { seed(db, id, 'failed', ageSeconds(5)); seed(db, id, 'failed', ageSeconds(10)) }
    try {
      await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'CHANNEL_COOLING_DOWN' })
      expect(http).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('冷却期结束后渠道重新可用', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { breaker })
    seed(db, 'a', 'failed', ageSeconds(700)); seed(db, 'a', 'failed', ageSeconds(710))
    try {
      await expect(meter.search({ query: 'q' })).resolves.toBeDefined()
      expect(String(http.mock.calls[0]![0])).toContain('a.example')
    } finally { db.close() }
  })

  it('单次失败不足以触发冷却，成功会打断连续计数', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { breaker })
    seed(db, 'a', 'failed', ageSeconds(5)); seed(db, 'a', 'billable', ageSeconds(10)); seed(db, 'a', 'failed', ageSeconds(15))
    try {
      await expect(meter.search({ query: 'q' })).resolves.toBeDefined()
      expect(String(http.mock.calls[0]![0])).toContain('a.example')
    } finally { db.close() }
  })

  it('熔断未启用时即使连续失败也照常派发', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { breaker: { ...breaker, enabled: false } })
    seed(db, 'a', 'failed', ageSeconds(5)); seed(db, 'a', 'failed', ageSeconds(10))
    try {
      await expect(meter.search({ query: 'q' })).resolves.toBeDefined()
      expect(String(http.mock.calls[0]![0])).toContain('a.example')
    } finally { db.close() }
  })

  it('复位标记让冷却中的渠道立即恢复', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const db = new BillingDatabase(':memory:')
    const config: RoutingConfig = { channels: [channel('a'), channel('b'), channel('c')], providerBindings: { source: { search: 'a' } }, globalOverrides: {}, failover: { search: { enabled: true, attemptTimeoutMs: 1_000, totalTimeoutMs: 4_000 } }, breaker }
    const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => 'synthetic-key', quotaSubject: () => 'fingerprint', httpFetch: http, breakerResets: { list: () => ({ a: new Date().toISOString() }) } })
    seed(db, 'a', 'failed', ageSeconds(5)); seed(db, 'a', 'failed', ageSeconds(10))
    try {
      await expect(meter.search({ query: 'q' })).resolves.toBeDefined()
      expect(String(http.mock.calls[0]![0])).toContain('a.example')
    } finally { db.close() }
  })
})

describe('预算闸门', () => {
  it('block 在超限后停止派发且不写新账本记录', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { budget: budget({ requests: 1, onExceed: 'block' }) })
    seed(db, 'a', 'failed', ageSeconds(5))
    let before = 0
    try {
      before = db.list('p').items.length
      await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
      expect(http).not.toHaveBeenCalled()
      expect(db.list('p').items).toHaveLength(before)
    } finally { db.close() }
  })

  it('warn 超限后仍然派发', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { budget: budget({ requests: 1, onExceed: 'warn' }) })
    seed(db, 'a', 'failed', ageSeconds(5))
    try {
      await expect(meter.search({ query: 'q' })).resolves.toBeDefined()
      expect(http).toHaveBeenCalledTimes(1)
    } finally { db.close() }
  })

  it('fallback 在没有免费候选时停止派发', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { budget: budget({ requests: 1, onExceed: 'fallback' }) })
    seed(db, 'a', 'failed', ageSeconds(5))
    try {
      await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
      expect(http).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('金额上限按币种独立生效', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { budget: budget({ limits: { CNY: '0.001' }, onExceed: 'block' }) })
    seed(db, 'a', 'billable', ageSeconds(5))
    try {
      await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
      expect(http).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('未超限时放行', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { budget: budget({ requests: 5, onExceed: 'block' }) })
    seed(db, 'a', 'failed', ageSeconds(5))
    try {
      await expect(meter.search({ query: 'q' })).resolves.toBeDefined()
      expect(http).toHaveBeenCalledTimes(1)
    } finally { db.close() }
  })

  it('预算未启用时不做判定', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { budget: budget({ enabled: false, requests: 1, onExceed: 'block' }) })
    seed(db, 'a', 'failed', ageSeconds(5))
    try {
      await expect(meter.search({ query: 'q' })).resolves.toBeDefined()
      expect(http).toHaveBeenCalledTimes(1)
    } finally { db.close() }
  })
})

describe('两道闸门的顺序', () => {
  it('先熔断剔渠道，再由预算判定；冷却渠道不计入免费候选', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, { breaker, budget: budget({ requests: 1, onExceed: 'block' }) })
    for (const id of ['a', 'b', 'c']) { seed(db, id, 'failed', ageSeconds(5)); seed(db, id, 'failed', ageSeconds(10)) }
    try {
      await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'CHANNEL_COOLING_DOWN' })
      expect(http).not.toHaveBeenCalled()
    } finally { db.close() }
  })
})
