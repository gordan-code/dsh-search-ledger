import { afterEach, expect, it, vi } from 'vitest'
import { BillingDatabase } from '../../src/storage/database.ts'
import { MeteredWeb } from '../../src/accounting/meter.ts'
import { KeyTester } from '../../src/host/key-tester.ts'
import type { Channel, RoutingConfig } from '../../src/contracts.ts'
import { channelTestSignature } from '../../src/channel-test.ts'
afterEach(() => vi.useRealTimers())
function setup(http: typeof fetch) {
  const channel: Channel = { id: 'relay', name: 'Relay', enabled: false, kind: 'deepseek-api', billingClass: 'relay', endpointBase: 'https://relay.example/v1/tools', credentialRef: 'RELAY_KEY', capabilities: ['search', 'fetch'], prices: { search: { perThousand: '5', currency: 'CNY', policy: 'http-200' }, fetch: { perThousand: '5', currency: 'CNY', policy: 'http-200' } } }
  const config: RoutingConfig = { channels: [channel, { ...channel, id: 'other', endpointBase: 'https://other.example/v1/tools' }], providerBindings: {}, globalOverrides: {}, failover: { search: { enabled: true, attemptTimeoutMs: 10, totalTimeoutMs: 1000 } } }
  const db = new BillingDatabase(':memory:')
  const resolveKeys = vi.fn(async () => ['saved-a', 'saved-b'])
  const web = new MeteredWeb({ db, source: () => ({ profileId: 'p', sessionId: 'chat', sourceProviderId: 'model' }), readConfig: () => config, resolveCredential: async () => undefined, quotaSubject: () => 'fp', httpFetch: http })
  const tester = new KeyTester({ db, web, profileId: 'p', readConfig: () => config, resolveKeys })
  return { tester, db, config, resolveKeys }
}
const success = () => new Response('{"results":[{"url":"https://example.com/"}],"content":"test"}')
it('确认绑定地址/价格/能力快照，初次派发前配置已变更则拒绝', async () => {
  const http = vi.fn<typeof fetch>(async () => success()); const { tester, config, db } = setup(http)
  const signature = channelTestSignature(config.channels[0]!, 'search')
  config.channels[0]!.prices.search!.perThousand = '999'
  try {
    await expect(tester.test('relay', 'RELAY_KEY', 'search', ['key'], 1, undefined, signature)).rejects.toMatchObject({ code: 'KEY_TEST_CONFIG_CHANGED' })
    expect(http).not.toHaveBeenCalled(); expect(db.list('p').items).toHaveLength(0)
  } finally { db.close() }
})
it('逐个测试输入Key，不自动保存/转渠道，所有实际尝试入账且无聊天归属', async () => {
  const http = vi.fn<typeof fetch>(async () => http.mock.calls.length === 1 ? new Response('{}', { status: 401 }) : success())
  const { tester, db, config, resolveKeys } = setup(http)
  try {
    const result = await tester.test('relay', 'RELAY_KEY', 'search', ['synthetic-a', 'synthetic-b', 'synthetic-a'], 2)
    expect(result.results.map(row => row.state)).toEqual(['auth-rejected', 'success'])
    expect(http.mock.calls.every(([url]) => String(url).startsWith('https://relay.example/'))).toBe(true)
    expect(http).toHaveBeenCalledTimes(2); expect(resolveKeys).not.toHaveBeenCalled()
    const rows = db.list('p').items
    expect(rows).toHaveLength(2); expect(rows.every(row => row.sourceProviderId === null && row.sessionId === null)).toBe(true)
    expect(new Set(rows.map(row => row.operationId))).toEqual(new Set([result.operationId]))
    expect(JSON.stringify(result)).not.toMatch(/synthetic-|Bearer|test\"/)
    expect(config.channels[0]!.enabled).toBe(false)
    expect(db.getAttempt('other-profile', rows[0]!.attemptId)).toBeNull()
  } finally { db.close() }
})
it('已保存池只在Host读取，确认数量变更时零请求', async () => {
  const http = vi.fn<typeof fetch>(async () => success()); const { tester, db, resolveKeys } = setup(http)
  try {
    await expect(tester.test('relay', 'RELAY_KEY', 'search', null, 1)).rejects.toMatchObject({ code: 'KEY_POOL_CHANGED' })
    expect(http).not.toHaveBeenCalled()
    const result = await tester.test('relay', 'RELAY_KEY', 'search', null, 2)
    expect(result.source).toBe('saved'); expect(result.results).toHaveLength(2); expect(resolveKeys).toHaveBeenCalledTimes(2)
  } finally { db.close() }
})
it('千帆无Fetch、陈旧引用/归档/无效Key均拒绝，零请求', async () => {
  const http = vi.fn<typeof fetch>(async () => success()); const { tester, db, config } = setup(http)
  try {
    await expect(tester.test('relay', 'WRONG', 'search', ['key'], 1)).rejects.toThrow()
    await expect(tester.test('relay', 'RELAY_KEY', 'search', ['bad key'], 1)).rejects.toThrow()
    config.channels[0]!.capabilities = ['search']
    await expect(tester.test('relay', 'RELAY_KEY', 'fetch', ['key'], 1)).rejects.toThrow()
    config.channels[0]!.archived = true
    await expect(tester.test('relay', 'RELAY_KEY', 'search', ['key'], 1)).rejects.toThrow()
    expect(http).not.toHaveBeenCalled()
  } finally { db.close() }
})
it('限流与超时不被说成Key无效，超时晚响应不重复计费', async () => {
  vi.useFakeTimers(); let late!: (response: Response) => void
  const http = vi.fn<typeof fetch>(async () => http.mock.calls.length === 1 ? new Response('{}', { status: 429 }) : http.mock.calls.length === 2 ? new Promise(resolve => { late = resolve }) : success())
  const { tester, db } = setup(http)
  try {
    const pending = tester.test('relay', 'RELAY_KEY', 'search', ['a', 'b', 'c'], 3)
    await vi.advanceTimersByTimeAsync(10_001)
    const result = await pending
    expect(result.results.map(row => row.state)).toEqual(['limited', 'timeout', 'success'])
    late(success()); await vi.advanceTimersByTimeAsync(1)
    expect(db.list('p').items).toHaveLength(3)
    expect(db.list('p').items.filter(row => row.outcome === 'unknown')).toHaveLength(1)
  } finally { db.close() }
})
it('总预算包括读池，重复点击被宿主锁拒绝，结束后释放', async () => {
  vi.useFakeTimers()
  const http = vi.fn<typeof fetch>(async () => success()); const { tester, db, resolveKeys } = setup(http)
  resolveKeys.mockImplementationOnce(async () => new Promise(() => {}))
  try {
    const pending = tester.test('relay', 'RELAY_KEY', 'search', null, 2).catch(error => error)
    await expect(tester.test('relay', 'RELAY_KEY', 'search', ['key'], 1)).rejects.toMatchObject({ code: 'KEY_TEST_BUSY' })
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await pending).toMatchObject({ code: 'TOTAL_TIMEOUT' }); expect(http).not.toHaveBeenCalled()
    expect((await tester.test('relay', 'RELAY_KEY', 'search', ['key'], 1)).results[0]!.state).toBe('success')
  } finally { db.close() }
})
it('配置变化停止剩余Key，保留已发生计费', async () => {
  const http = vi.fn<typeof fetch>(async () => { config.channels[0]!.endpointBase = 'https://changed.example/v1/tools'; return success() })
  const { tester, db, config } = setup(http)
  try {
    const result = await tester.test('relay', 'RELAY_KEY', 'search', ['a', 'b'], 2)
    expect(result.results.map(row => row.state)).toEqual(['success', 'not-tested']); expect(result.results[1]!.code).toBe('KEY_TEST_CONFIG_CHANGED')
    expect(http).toHaveBeenCalledTimes(1); expect(db.list('p').items).toHaveLength(1)
  } finally { db.close() }
})
it('取消/插件卸载停止后续Key，不重试', async () => {
  const parent = new AbortController()
  const http = vi.fn<typeof fetch>(async () => { parent.abort(); return success() })
  const { tester, db } = setup(http)
  try {
    const result = await tester.test('relay', 'RELAY_KEY', 'search', ['a', 'b'], 2, parent.signal)
    expect(result.results[1]!.state).toBe('not-tested'); expect(http).toHaveBeenCalledTimes(1)
    tester.close()
    await expect(tester.test('relay', 'RELAY_KEY', 'search', ['a'], 1)).rejects.toThrow()
  } finally { db.close() }
})
it('账本失败停止整批，错误不回显底层敏感文本', async () => {
  const http = vi.fn<typeof fetch>(async () => success()); const { tester, db } = setup(http)
  vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('secret-key private-path') })
  try {
    const result = await tester.test('relay', 'RELAY_KEY', 'search', ['a', 'b'], 2)
    expect(result.results[1]!.state).toBe('not-tested'); expect(http).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('secret-key')
  } finally { db.close() }
})
it('Fetch固定测试目标，不向目标网站发送Key', async () => {
  const http = vi.fn<typeof fetch>(async () => success()); const { tester, db } = setup(http)
  try {
    expect((await tester.test('relay', 'RELAY_KEY', 'fetch', ['synthetic'], 1)).results[0]!.state).toBe('success')
    expect(JSON.parse(String(http.mock.calls[0]![1]!.body))).toMatchObject({ url: 'https://example.com/' })
    expect(String(http.mock.calls[0]![0])).toBe('https://relay.example/v1/tools/fetch')
  } finally { db.close() }
})
