import { afterEach, expect, it, vi } from 'vitest'
import type { Channel, RoutingConfig } from '../../src/contracts.ts'
import { MeteredWeb } from '../../src/accounting/meter.ts'
import { BillingDatabase } from '../../src/storage/database.ts'
import { candidateStates } from '../../src/host/candidate-status.ts'
import { createHash } from 'node:crypto'
afterEach(() => vi.useRealTimers())
const channel = (id: string): Channel => ({ id, name: id, enabled: true, kind: 'deepseek-api', billingClass: 'relay', endpointBase: `https://${id}.example/v1/tools`, capabilities: ['search', 'fetch'], prices: { search: { perThousand: '5', currency: 'CNY', policy: 'http-200' }, fetch: { perThousand: '5', currency: 'CNY', policy: 'http-200' } } })
function setup(http: typeof fetch, ordered = true) {
  const db = new BillingDatabase(':memory:')
  const config: RoutingConfig = { channels: [channel('a'), channel('b')], providerBindings: { source: { search: 'a', fetch: 'a' } }, globalOverrides: {}, failover: { search: { enabled: ordered, attemptTimeoutMs: 10, totalTimeoutMs: 1000 }, fetch: { enabled: ordered, attemptTimeoutMs: 10, totalTimeoutMs: 1000 } } }
  const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), quotaSubject: key => key, resolveCredential: async () => undefined, resolveChannelCredentials: async c => c.id === 'a' ? ['synthetic-a', 'synthetic-b'] : ['synthetic-c'], httpFetch: http })
  return { db, meter, config }
}
const success = () => new Response('{"results":[{"url":"https://example.com/"}],"content":"body"}')
it('先遍历渠道内Key再跨渠道，逐次独立入账不存Key，共享operationId', async () => {
  const http = vi.fn<typeof fetch>(async () => http.mock.calls.length < 3 ? new Response('{}', { status: 401 }) : success())
  const { db, meter } = setup(http)
  try {
    await meter.search({ query: 'q' })
    expect(http.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['a.example', 'a.example', 'b.example'])
    expect(http.mock.calls.map(([, options]) => new Headers(options?.headers).get('authorization'))).toEqual(['Bearer synthetic-a', 'Bearer synthetic-b', 'Bearer synthetic-c'])
    const rows = db.list('p').items
    expect(rows).toHaveLength(3); expect(new Set(rows.map(row => row.operationId)).size).toBe(1)
    expect(JSON.stringify(rows)).not.toContain('synthetic-')
  } finally { db.close() }
})
it.each(['search', 'fetch'] as const)('未启用跨渠道时%s仍可换Key，池耗尽不访问其他渠道', async operation => {
  const http = vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 }))
  const { db, meter } = setup(http, false)
  try {
    await expect(operation === 'search' ? meter.search({ query: 'q' }) : meter.fetch({ url: 'https://target.example/' })).rejects.toBeDefined()
    expect(http).toHaveBeenCalledTimes(2); expect(db.list('p').items.every(row => row.channelId === 'a')).toBe(true)
  } finally { db.close() }
})
it('Key超时接力，晚响应不重复入账', async () => {
  vi.useFakeTimers()
  let late!: (value: Response) => void
  const http = vi.fn<typeof fetch>(async () => http.mock.calls.length === 1 ? new Promise(resolve => { late = resolve }) : success())
  const { db, meter } = setup(http, false)
  try {
    const result = meter.search({ query: 'q' }); await vi.advanceTimersByTimeAsync(11); await result
    late(success()); await vi.advanceTimersByTimeAsync(1)
    expect(db.list('p').items.map(row => row.outcome).sort()).toEqual(['billable', 'unknown'])
  } finally { db.close() }
})
it('合法空结果不换Key', async () => {
  const http = vi.fn<typeof fetch>(async () => new Response('{"results":[]}'))
  const { db, meter } = setup(http)
  try { await meter.search({ query: 'q' }); expect(http).toHaveBeenCalledTimes(1) } finally { db.close() }
})
it('父取消不能继续其他Key或渠道', async () => {
  const parent = new AbortController()
  const http = vi.fn<typeof fetch>(async () => { parent.abort(); return success() })
  const { db, meter } = setup(http)
  try { await expect(meter.search({ query: 'q' }, parent.signal)).rejects.toMatchObject({ code: 'CANCELLED' }); expect(http).toHaveBeenCalledTimes(1) } finally { db.close() }
})
it('候选无引用但有池仍就绪，预览不需要读取旧引用', async () => {
  const { db, config } = setup(vi.fn())
  const legacy = vi.fn(async () => undefined)
  try {
    expect(await candidateStates(config, 'search', null, {}, legacy, async () => ['synthetic'])).toMatchObject([{ credentialReady: true }, { credentialReady: true }])
    expect(legacy).not.toHaveBeenCalled()
  } finally { db.close() }
})
it('关闭跨渠道时总预算也包含池读取，迟到Key不能派发', async () => {
  vi.useFakeTimers()
  const http = vi.fn<typeof fetch>(async () => success())
  const { db, config } = setup(http, false)
  let complete!: (keys: string[]) => void
  const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), quotaSubject: () => 'fp', resolveCredential: async () => undefined, resolveChannelCredentials: async () => new Promise(resolve => { complete = resolve }), httpFetch: http })
  try {
    const result = meter.search({ query: 'q' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toMatchObject({ code: 'TOTAL_TIMEOUT' })
    complete(['late-key']); await vi.advanceTimersByTimeAsync(1)
    expect(http).not.toHaveBeenCalled(); expect(db.list('p').items).toHaveLength(0)
  } finally { db.close() }
})
it('无凭证SearXNG不被Key池默认20秒预算改变', async () => {
  vi.useFakeTimers()
  const { db } = setup(vi.fn(), false)
  const config: RoutingConfig = { channels: [{ id: 's', name: 's', kind: 'searxng', billingClass: 'free', enabled: true, endpointBase: 'https://s.example', capabilities: ['search'], prices: { search: { perThousand: '0', currency: 'CNY', policy: 'free' } } }], providerBindings: {}, globalOverrides: { search: 's' } }
  let resolve!: (response: Response) => void
  const http = vi.fn<typeof fetch>(async () => new Promise(done => { resolve = done }))
  const pool = vi.fn(async () => [])
  const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p' }), quotaSubject: () => 'fp', resolveCredential: async () => undefined, resolveChannelCredentials: pool, httpFetch: http })
  try {
    const result = meter.search({ query: 'q' })
    await vi.advanceTimersByTimeAsync(20_001)
    expect(http.mock.calls[0]?.[1]?.signal?.aborted).not.toBe(true)
    resolve(success()); await result
    expect(pool).not.toHaveBeenCalled()
  } finally { db.close() }
})
it('Tavily池内额度按实际Key独立保护，耗尽换Key但不会重置额度', async () => {
  const db = new BillingDatabase(':memory:')
  const tavily: Channel = { id: 't', name: 't', kind: 'tavily', billingClass: 'service', enabled: true, endpointBase: 'https://api.tavily.com', capabilities: ['search'], monthlyCredits: 1, prices: { search: { perThousand: null, currency: 'CNY', policy: 'provider-success' } } }
  const config: RoutingConfig = { channels: [tavily], providerBindings: {}, globalOverrides: { search: 't' } }
  const http = vi.fn<typeof fetch>(async () => http.mock.calls.length === 1 ? new Response('{}', { status: 401 }) : success())
  const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p' }), resolveCredential: async () => undefined, resolveChannelCredentials: async () => ['synthetic-a', 'synthetic-b'], quotaSubject: key => createHash('sha256').update(key).digest('hex'), httpFetch: http })
  try {
    await meter.search({ query: 'q' })
    expect(http).toHaveBeenCalledTimes(2)
    expect(db.list('p').items.map(row => row.quotaCredits)).toEqual([1, 1])
    await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'QUOTA_LOCAL_LIMIT' })
    expect(http).toHaveBeenCalledTimes(2)
  } finally { db.close() }
})
