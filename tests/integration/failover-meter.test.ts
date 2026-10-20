import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Channel, RoutingConfig } from '../../src/contracts.ts'
import { BillingDatabase } from '../../src/storage/database.ts'
import { MeteredWeb } from '../../src/accounting/meter.ts'
import { LocalHttpAdapter } from '../../src/providers/local-http.ts'

const channel = (id: string): Channel => ({ id, name: id, kind: 'deepseek-api', billingClass: 'relay', enabled: true, endpointBase: `https://${id}.example/v1/tools`, credentialRef: id.toUpperCase(), capabilities: ['search', 'fetch'], prices: { search: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' }, fetch: { perThousand: '7', currency: 'CNY', policy: 'official-nonempty' } } })
const success = () => new Response(JSON.stringify({ results: [{ url: 'https://result.example/' }], content: 'text' }))
function setup(httpFetch: typeof fetch, resolveCredential = async (_ref: string): Promise<string | undefined> => 'synthetic-key', budget = 1000) {
  const db = new BillingDatabase(':memory:')
  const config: RoutingConfig = { channels: [channel('a'), channel('b'), channel('c')], providerBindings: { source: { search: 'a', fetch: 'a' } }, globalOverrides: {}, failover: { search: { enabled: true, attemptTimeoutMs: budget, totalTimeoutMs: budget * 4 }, fetch: { enabled: true, attemptTimeoutMs: budget, totalTimeoutMs: budget * 4 } } } as RoutingConfig
  const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential, quotaSubject: () => 'fingerprint', httpFetch })
  return { db, config, meter }
}
afterEach(() => vi.useRealTimers())
describe('有序渠道计量', () => {
  it.each(['WEB_PROVIDER_ERROR', 'WEB_FETCH_TIMEOUT', 'WEB_FETCH_TOO_LARGE', 'WEB_UNSUPPORTED_CONTENT_TYPE'])('本地抓取%s可切换，但安全策略拒绝不能绕过', async code => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter, config } = setup(http)
    config.channels[0] = { id: 'a', name: 'local', kind: 'local-http', billingClass: 'free', enabled: true, endpointBase: '', capabilities: ['fetch'], prices: { fetch: { perThousand: '0', currency: 'CNY', policy: 'free' } } }
    const local = vi.spyOn(LocalHttpAdapter.prototype, 'fetch').mockRejectedValue(Object.assign(new Error('synthetic'), { code }))
    try { await meter.fetch({ url: 'https://page.example/' }); expect(http).toHaveBeenCalledTimes(1); expect(db.list('p').items.find(r => r.channelId === 'a')?.outcome).toBe('unknown') }
    finally { local.mockRestore(); db.close() }
  })
  it('本地URL安全策略拒绝停止整链', async () => {
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter, config } = setup(http)
    config.channels[0] = { id: 'a', name: 'local', kind: 'local-http', billingClass: 'free', enabled: true, endpointBase: '', capabilities: ['fetch'], prices: { fetch: { perThousand: '0', currency: 'CNY', policy: 'free' } } }
    const local = vi.spyOn(LocalHttpAdapter.prototype, 'fetch').mockRejectedValue(Object.assign(new Error('synthetic blocked'), { code: 'WEB_BLOCKED_URL' }))
    try { await expect(meter.fetch({ url: 'https://page.example/' })).rejects.toBeDefined(); expect(http).not.toHaveBeenCalled() }
    finally { local.mockRestore(); db.close() }
  })
  it('跳过缺少Key渠道，只记录实际派发，并保留同一次operationId', async () => {
    const http = vi.fn<typeof fetch>(async url => String(url).includes('b.example') ? new Response('{}', { status: 401 }) : success())
    const { db, meter } = setup(http, async ref => ref === 'A' ? '  ' : 'key')
    try {
      await expect(meter.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://result.example/' }] })
      expect(http).toHaveBeenCalledTimes(2)
      const rows = db.list('p').items
      expect(rows.map(r => r.channelId).sort()).toEqual(['b', 'c'])
      expect(new Set(rows.map(r => (r as any).operationId)).size).toBe(1)
      expect((rows[0] as any).operationId).toBeTruthy()
    } finally { db.close() }
  })
  it.each([401, 429, 503])('HTTP %i切换，成功停止', async status => {
    const http = vi.fn<typeof fetch>(async () => http.mock.calls.length === 1 ? new Response('{}', { status }) : success())
    const { db, meter } = setup(http)
    try { await meter.search({ query: 'q' }); expect(http).toHaveBeenCalledTimes(2); expect(db.list('p').items.map(r => r.outcome).sort()).toEqual(['billable', 'failed']) } finally { db.close() }
  })
  it('合法空搜索停止，不因空结果继续付费', async () => {
    const http = vi.fn<typeof fetch>(async () => new Response('{"results":[]}'))
    const { db, meter } = setup(http)
    try { expect((await meter.search({ query: 'q' })).sources).toEqual([]); expect(http).toHaveBeenCalledTimes(1) } finally { db.close() }
  })
  it('全缺Key零派发、零账本，全失败不循环', async () => {
    const http = vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 }))
    const absent = setup(http, async () => undefined)
    try { await expect(absent.meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'NO_AVAILABLE_CHANNEL' }); expect(absent.db.list('p').items).toHaveLength(0); expect(http).not.toHaveBeenCalled() } finally { absent.db.close() }
    const all = setup(http)
    try { await expect(all.meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'ALL_CHANNELS_FAILED' }); expect(http).toHaveBeenCalledTimes(3) } finally { all.db.close() }
  })
  it('已派发超时保留unknown并接力，晚到响应不重复结算', async () => {
    vi.useFakeTimers()
    let late!: (response: Response) => void
    const http = vi.fn<typeof fetch>(async () => http.mock.calls.length === 1 ? await new Promise<Response>(resolve => { late = resolve }) : success())
    const { db, meter } = setup(http)
    try {
      const request = meter.search({ query: 'q' }); await vi.advanceTimersByTimeAsync(1001)
      await request; expect(http).toHaveBeenCalledTimes(2)
      late(success()); await vi.advanceTimersByTimeAsync(1)
      expect(db.list('p').items.map(r => r.outcome).sort()).toEqual(['billable', 'unknown'])
    } finally { db.close() }
  })
  it('父取消停止；迟到的凭证解析不能触发派发', async () => {
    const parent = new AbortController(); let key!: (v: string) => void
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, async () => await new Promise(resolve => { key = resolve }))
    try {
      const pending = meter.search({ query: 'q' }, parent.signal)
      await Promise.resolve(); parent.abort()
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
      key('late'); await Promise.resolve(); expect(http).not.toHaveBeenCalled(); expect(db.list('p').items).toHaveLength(0)
    } finally { db.close() }
  })
  it('总预算包括凭证等待，耗尽后不转投', async () => {
    vi.useFakeTimers()
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, meter } = setup(http, async () => await new Promise(() => {}))
    try {
      const result = meter.search({ query: 'q' }).catch(e => e)
      await vi.advanceTimersByTimeAsync(4001)
      expect(await result).toMatchObject({ code: 'TOTAL_TIMEOUT' }); expect(http).not.toHaveBeenCalled()
    } finally { db.close() }
  })
  it('失败后仍使用最初的来源、价格与顺序快照', async () => {
    let change!: () => void
    const http = vi.fn<typeof fetch>(async () => { if (http.mock.calls.length === 1) { change(); return new Response('{}', { status: 503 }) }; return success() })
    const { db, meter, config } = setup(http)
    change = () => { config.channels[1]!.prices.search!.perThousand = '999'; config.channels.reverse(); config.providerBindings.source!.search = 'c' }
    try { await meter.search({ query: 'q' }); expect(db.list('p').items.find(r => r.channelId === 'b')).toMatchObject({ pricePerThousand: '5', sourceProviderId: 'source' }) } finally { db.close() }
  })
  it.each(['prepare', 'dispatch', 'finish', 'finishUnknown'])('%s账本失败停止接力', async stage => {
    const http = vi.fn<typeof fetch>(async () => { if (stage === 'finishUnknown') throw new Error('network'); return success() })
    const { db, meter } = setup(http)
    const method = stage === 'finishUnknown' ? 'finish' : stage as 'prepare' | 'dispatch' | 'finish'
    vi.spyOn(db, method).mockImplementation(() => { throw new Error('synthetic database fault') })
    try { await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: expect.stringMatching(/^DB_/) }); expect(http.mock.calls.length).toBeLessThanOrEqual(1) } finally { db.close() }
  })
  it('Fetch也独立接力，不改聊天来源Provider', async () => {
    const http = vi.fn<typeof fetch>(async () => http.mock.calls.length === 1 ? new Response('{}', { status: 503 }) : success())
    const { db, meter } = setup(http)
    try { await expect(meter.fetch({ url: 'https://page.example/' })).resolves.toMatchObject({ body: { content: 'text' } }); expect(http).toHaveBeenCalledTimes(2); expect(db.list('p').items.every(r => r.operation === 'fetch' && r.sourceProviderId === 'source')).toBe(true) } finally { db.close() }
  })
  it('同步身份检查耗尽总预算后取消prepared，不能派发', async () => {
    let monotonic = 0
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, config } = setup(http)
    const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => 'key', quotaSubject: () => 'fp', httpFetch: http, afterPrepare: () => { monotonic = 99999 } })
    try { await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'TOTAL_TIMEOUT' }); expect(http).not.toHaveBeenCalled(); expect(db.list('p').items).toMatchObject([{ outcome: 'failed', quotaCredits: 0, status: null }]) }
    finally { vi.restoreAllMocks(); db.close() }
  })
  it('同步预检耗尽单项时间后不向该项派发，仍可尝试下一项', async () => {
    let monotonic = 0
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, config } = setup(http)
    const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => 'key', quotaSubject: () => 'fp', httpFetch: http, afterPrepare: route => { if (route.channel.id === 'a') monotonic = 1001 } })
    try { await meter.search({ query: 'q' }); expect(http).toHaveBeenCalledTimes(1); expect(String(http.mock.calls[0]![0])).toContain('b.example') }
    finally { vi.restoreAllMocks(); db.close() }
  })
  it('取消prepared写失败也停止接力，不留下预留后继续产生费用', async () => {
    let monotonic = 0
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const http = vi.fn<typeof fetch>(async () => success())
    const { db, config } = setup(http)
    vi.spyOn(db, 'cancelPrepared').mockImplementation(() => { throw new Error('synthetic cancel write fault') })
    const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => 'key', quotaSubject: () => 'fp', httpFetch: http, afterPrepare: route => { if (route.channel.id === 'a') monotonic = 1001 } })
    try { await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'DB_CANCEL_FAILED' }); expect(http).not.toHaveBeenCalled() }
    finally { vi.restoreAllMocks(); db.close() }
  })
  it('来源及会话覆盖也只读取一次，失败后不重读新归属', async () => {
    const http = vi.fn<typeof fetch>(async () => {
      if (http.mock.calls.length === 1) { source.sourceProviderId = 'changed'; source.sourceModel = 'changed-model'; db.setOverride('p', 's', 'search', 'c', 0); return new Response('{}', { status: 503 }) }
      return success()
    })
    const { db, config } = setup(http)
    const source = { profileId: 'p', sessionId: 's', sourceProviderId: 'source', sourceModel: 'original-model' }
    const readSource = vi.fn(() => source); const readConfig = vi.fn(() => config); const overrides = vi.spyOn(db, 'getOverrides')
    const meter = new MeteredWeb({ db, readConfig, source: readSource, resolveCredential: async () => 'key', quotaSubject: () => 'fp', httpFetch: http })
    // setOverride内部为返回新revision另读一次；候选循环本身只读初始覆盖。
    try { await meter.search({ query: 'q' }); expect(readSource).toHaveBeenCalledTimes(1); expect(readConfig).toHaveBeenCalledTimes(1); expect(overrides).toHaveBeenCalledTimes(2); expect(db.list('p').items.every(r => r.sourceProviderId === 'source' && r.sessionId === 's')).toBe(true); expect(db.list('p').items.some(r => r.channelId === 'b')).toBe(true) }
    finally { db.close() }
  })
})
