import { describe, expect, it, vi } from 'vitest'
import { BillingDatabase } from '../../src/storage/database.ts'
import type { Channel, RoutingConfig } from '../../src/contracts.ts'
import { MeteredWeb } from '../../src/accounting/meter.ts'
import { DeepSeekAdapter } from '../../src/providers/deepseek.ts'
import { LocalHttpAdapter } from '../../src/providers/local-http.ts'
import { SearXNGAdapter } from '../../src/providers/searxng.ts'
import { TavilyAdapter } from '../../src/providers/tavily.ts'
import { parseSafeRequestUrl } from '../../src/transport/security.ts'

const deepseek: Channel = {
  id: 'deepseek', name: 'DeepSeek', kind: 'deepseek-api', billingClass: 'official', enabled: true,
  endpointBase: 'https://api.deepseek.com/v1/tools', credentialRef: 'DEEPSEEK_KEY', capabilities: ['search', 'fetch'],
  prices: {
    search: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' },
    fetch: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' },
  },
}
const config: RoutingConfig = { channels: [deepseek], providerBindings: { source: { search: 'deepseek', fetch: 'deepseek' } }, globalOverrides: {} }

function makeMeter(fetchImpl: typeof fetch) {
  const db = new BillingDatabase(':memory:')
  const meter = new MeteredWeb({
    db,
    readConfig: () => config,
    source: () => ({ profileId: 'profile-a', sourceProviderId: 'source' }),
    resolveCredential: async () => 'secret-key',
    quotaSubject: key => `hash:${key}`,
    httpFetch: fetchImpl,
  })
  return { db, meter }
}

describe('计量 Web provider', () => {
  it('暴露稳定且与凭证无关的 provider 可用性', () => {
    const meter = new MeteredWeb({
      db: {} as never,
      readConfig: () => config,
      source: () => ({ profileId: 'profile-a' }),
      resolveCredential: async () => undefined,
      quotaSubject: key => key,
    })
    expect(meter.searchProvider.id).toBe('web-search-metered')
    expect(meter.fetchProvider.id).toBe('web-fetch-metered')
    expect(meter.searchProvider.available()).toBe(true)
    expect(meter.fetchProvider.available()).toBe(true)
  })

  it('DeepSeek 200 非空结果只调用一次并规范化来源', async () => {
    const httpFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer secret-key')
      expect(JSON.parse(String(init?.body))).toEqual({ query: '天气', count: 3 })
      return new Response(JSON.stringify({ results: [{ title: '标题', url: 'https://example.test/a', snippet: '摘要', date: '2026-10-19' }] }), { status: 200 })
    })
    const { db, meter } = makeMeter(httpFetch)
    await expect(meter.search({ query: '天气', maxResults: 3 })).resolves.toMatchObject({ sources: [{ title: '标题', url: 'https://example.test/a', snippet: '摘要', publishedAt: '2026-10-19' }], truncated: false })
    expect(httpFetch).toHaveBeenCalledTimes(1)
    expect(db.list('profile-a').items[0]).toMatchObject({ outcome: 'billable', status: 200 })
    db.close()
  })

  it('原始结果可计费但规范化失败时仍保留 billable 账本', async () => {
    const httpFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [{ url: 'not-a-url' }] }), { status: 200 }))
    const { db, meter } = makeMeter(httpFetch)
    await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'RESULT_INVALID' })
    expect(db.list('profile-a').items[0]).toMatchObject({ outcome: 'billable', status: 200 })
    db.close()
  })

  it('200 空结果记为 empty，非 200 记为 failed，坏 JSON 记为 unknown', async () => {
    const responses = [
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
      new Response('bad gateway', { status: 502 }),
      new Response('{', { status: 200 }),
    ]
    const httpFetch = vi.fn<typeof fetch>(async () => responses.shift()!)
    const { db, meter } = makeMeter(httpFetch)
    await expect(meter.search({ query: 'empty' })).resolves.toMatchObject({ sources: [] })
    await expect(meter.search({ query: 'failed' })).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    await expect(meter.search({ query: 'unknown' })).rejects.toMatchObject({ code: 'UPSTREAM_UNKNOWN' })
    expect(db.list('profile-a').items.map(item => item.outcome).sort()).toEqual(['empty', 'failed', 'unknown'])
    expect(httpFetch).toHaveBeenCalledTimes(3)
    db.close()
  })

  it('503/429 响应中途断开优先记 unknown，不按非 2xx failed 结算且不重发', async () => {
    const brokenResponse = (status: number) => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        controller.error(new Error('connection closed'))
      },
    }), { status })
    const responses = [brokenResponse(503), brokenResponse(429)]
    const httpFetch = vi.fn<typeof fetch>(async () => responses.shift()!)
    const { db, meter } = makeMeter(httpFetch)
    await expect(meter.search({ query: 'stream-503' })).rejects.toMatchObject({ code: 'UPSTREAM_UNKNOWN' })
    await expect(meter.search({ query: 'stream-429' })).rejects.toMatchObject({ code: 'UPSTREAM_UNKNOWN' })
    expect(httpFetch).toHaveBeenCalledTimes(2)
    expect(db.list('profile-a').items.map(item => item.outcome).sort()).toEqual(['unknown', 'unknown'])
    db.close()
  })

  it('fetch 200 空正文按官方口径记 empty，代理渠道使用独立价格', async () => {
    const officialFetch: Channel = {
      ...deepseek, id: 'official-fetch', name: '官方抓取', capabilities: ['fetch'],
      prices: { fetch: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' } },
    }
    const relayFetch: Channel = {
      ...deepseek, id: 'relay-fetch', name: '代理抓取', billingClass: 'relay', endpointBase: 'https://relay.example/v1/tools', capabilities: ['fetch'],
      prices: { fetch: { perThousand: '17', currency: 'USD', policy: 'official-nonempty' } },
    }
    let provider = 'official'
    const responses = [
      new Response(JSON.stringify({ content: '' }), { status: 200 }),
      new Response(JSON.stringify({ content: '正文' }), { status: 200 }),
    ]
    const httpFetch = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/v1/tools/fetch')
      return responses.shift()!
    })
    const db = new BillingDatabase(':memory:')
    const meter = new MeteredWeb({
      db,
      readConfig: () => ({ channels: [officialFetch, relayFetch], providerBindings: { official: { fetch: 'official-fetch' }, relay: { fetch: 'relay-fetch' } }, globalOverrides: {} }),
      source: () => ({ profileId: 'p', sourceProviderId: provider }),
      resolveCredential: async () => 'secret', quotaSubject: key => key, httpFetch,
    })
    await expect(meter.fetch({ url: 'https://example.test/empty' })).resolves.toMatchObject({ statusCode: 200, body: { content: '' } })
    provider = 'relay'
    await expect(meter.fetch({ url: 'https://example.test/body' })).resolves.toMatchObject({ statusCode: 200, body: { content: '正文' } })
    expect(db.list('p').items.find(item => item.channelId === 'official-fetch')).toMatchObject({ outcome: 'empty', currency: 'CNY', pricePerThousand: '5', amountMicros: null })
    expect(db.list('p').items.find(item => item.channelId === 'relay-fetch')).toMatchObject({ outcome: 'billable', currency: 'USD', pricePerThousand: '17', amountMicros: '17000' })
    expect(httpFetch).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('派发后取消只产生一次未知结算', async () => {
    const controller = new AbortController()
    const httpFetch = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      setTimeout(() => controller.abort(), 0)
    }))
    const { db, meter } = makeMeter(httpFetch)
    await expect(meter.search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(db.list('profile-a').items[0]).toMatchObject({ outcome: 'unknown' })
    expect(httpFetch).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('缺少凭证在 prepare 前失败且不发网络请求', async () => {
    const httpFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    const db = new BillingDatabase(':memory:')
    const meter = new MeteredWeb({
      db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }),
      resolveCredential: async () => undefined, quotaSubject: key => key, httpFetch,
    })
    await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' })
    expect(httpFetch).not.toHaveBeenCalled()
    expect(db.list('p').items).toHaveLength(0)
    db.close()
  })

  it('SearXNG 解析 JSON、保留空结果并把限流记为 failed', async () => {
    const channel: Channel = {
      id: 'searx', name: 'SearXNG', kind: 'searxng', billingClass: 'free', enabled: true,
      endpointBase: 'https://search.example/base', capabilities: ['search'],
      prices: { search: { perThousand: '0', currency: 'CNY', policy: 'free' } },
    }
    const responses = [
      new Response(JSON.stringify({ results: [{ url: 'https://example.test/a', title: '标题', summary: '优先摘要', snippet: '次级摘要', publishedDate: '2026-10-19' }] }), { status: 200 }),
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
      new Response('rate limited', { status: 429 }),
    ]
    const httpFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/base/search')
      expect(url.searchParams.get('format')).toBe('json')
      expect(init?.method).toBe('GET')
      return responses.shift()!
    })
    const db = new BillingDatabase(':memory:')
    const meter = new MeteredWeb({
      db, readConfig: () => ({ channels: [channel], providerBindings: { source: { search: 'searx' } }, globalOverrides: {} }),
      source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => undefined, quotaSubject: key => key, httpFetch,
    })
    await expect(meter.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ snippet: '优先摘要', publishedAt: '2026-10-19' }] })
    await expect(meter.search({ query: 'empty' })).resolves.toMatchObject({ sources: [] })
    await expect(meter.search({ query: 'limit' })).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    expect(httpFetch).toHaveBeenCalledTimes(3)
    expect(db.list('p').items.map(item => item.outcome).sort()).toEqual(['billable', 'empty', 'failed'])
    db.close()
  })

  it('Tavily 固定 basic 参数、额度跨 channel/profile 共享且失败不退还 credit', async () => {
    const tavilyA: Channel = {
      id: 'tavily-a', name: 'Tavily A', kind: 'tavily', billingClass: 'free', enabled: true,
      endpointBase: 'https://api.tavily.com', credentialRef: 'KEY_A', capabilities: ['search'], monthlyCredits: 2,
      prices: { search: { perThousand: '0', currency: 'CNY', policy: 'free' } },
    }
    const tavilyB: Channel = { ...tavilyA, id: 'tavily-b', name: 'Tavily B', credentialRef: 'KEY_B' }
    let profile = 'profile-a'; let provider = 'one'
    const httpFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toMatchObject({ search_depth: 'basic', auto_parameters: false, max_results: 2 })
      return new Response('upstream failure', { status: 503 })
    })
    const db = new BillingDatabase(':memory:')
    const meter = new MeteredWeb({
      db,
      readConfig: () => ({ channels: [tavilyA, tavilyB], providerBindings: { one: { search: 'tavily-a' }, two: { search: 'tavily-b' } }, globalOverrides: {} }),
      source: () => ({ profileId: profile, sourceProviderId: provider }), resolveCredential: async () => 'same-secret', quotaSubject: key => `fingerprint:${key}`,
      httpFetch, now: () => new Date('2026-10-19T00:00:00.000Z'),
    })
    await expect(meter.search({ query: 'a', maxResults: 2 })).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    profile = 'profile-b'; provider = 'two'
    await expect(meter.search({ query: 'b', maxResults: 2 })).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    profile = 'profile-c'; provider = 'one'
    await expect(meter.search({ query: 'c', maxResults: 2 })).rejects.toMatchObject({ code: 'QUOTA_LOCAL_LIMIT' })
    expect(httpFetch).toHaveBeenCalledTimes(2)
    expect(db.list('profile-a').items[0]).toMatchObject({ outcome: 'failed', quotaCredits: 1 })
    db.close()
  })

  it('本地 HTTP 组合官方 Provider，回环地址在网络前拒绝', async () => {
    const adapter = new LocalHttpAdapter()
    await expect(adapter.fetch({ url: 'http://127.0.0.1:9/private' }, {} as never)).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })

  it('各搜索适配器都按 maxResults 截断并标记 truncated', () => {
    const payload = {
      results: [
        { url: 'https://example.test/one', title: '一' },
        { url: 'https://example.test/two', title: '二' },
      ],
    }
    const adapters = [
      new DeepSeekAdapter(vi.fn<typeof fetch>()),
      new SearXNGAdapter(vi.fn<typeof fetch>()),
      new TavilyAdapter(vi.fn<typeof fetch>()),
    ]
    for (const adapter of adapters) {
      expect(adapter.normalizeSearch(payload, { query: 'q', maxResults: 1 })).toMatchObject({
        sources: [{ url: 'https://example.test/one' }], truncated: true,
      })
    }
  })

  it('本地 HTTP 非 2xx 仍返回标准结果、透传截断并独立记 failed', async () => {
    const local: Channel = {
      id: 'local', name: '本地 HTTP', kind: 'local-http', billingClass: 'free', enabled: true,
      endpointBase: '', capabilities: ['fetch'],
      prices: { fetch: { perThousand: '0', currency: 'CNY', policy: 'free' } },
    }
    const db = new BillingDatabase(':memory:')
    const localFetch = vi.spyOn(LocalHttpAdapter.prototype, 'fetch').mockResolvedValue({
      status: 404,
      payload: { content: 'not found', kind: 'text', url: 'https://example.test/missing', truncated: true },
    })
    try {
      const meter = new MeteredWeb({
        db,
        readConfig: () => ({ channels: [local], providerBindings: { source: { fetch: 'local' } }, globalOverrides: {} }),
        source: () => ({ profileId: 'p', sourceProviderId: 'source' }),
        resolveCredential: async () => undefined,
        quotaSubject: key => key,
      })
      await expect(meter.fetch({ url: 'https://example.test/missing' })).resolves.toEqual({
        url: 'https://example.test/missing', statusCode: 404,
        body: { kind: 'text', content: 'not found' }, truncated: true,
      })
      expect(db.list('p').items[0]).toMatchObject({ outcome: 'failed', status: 404 })
      expect(localFetch).toHaveBeenCalledTimes(1)
    } finally {
      localFetch.mockRestore()
      db.close()
    }
  })

  it('本地 HTTP WEB_ABORTED 映射为取消并只结算未知一次', async () => {
    const local: Channel = {
      id: 'local-abort', name: '本地 HTTP', kind: 'local-http', billingClass: 'free', enabled: true,
      endpointBase: '', capabilities: ['fetch'],
      prices: { fetch: { perThousand: '0', currency: 'CNY', policy: 'free' } },
    }
    const db = new BillingDatabase(':memory:')
    const aborted = Object.assign(new Error('aborted'), { name: 'WebError', code: 'WEB_ABORTED' })
    const localFetch = vi.spyOn(LocalHttpAdapter.prototype, 'fetch').mockRejectedValue(aborted)
    try {
      const meter = new MeteredWeb({
        db,
        readConfig: () => ({ channels: [local], providerBindings: { source: { fetch: 'local-abort' } }, globalOverrides: {} }),
        source: () => ({ profileId: 'p', sourceProviderId: 'source' }),
        resolveCredential: async () => undefined,
        quotaSubject: key => key,
      })
      await expect(meter.fetch({ url: 'https://example.test/abort' })).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(db.list('p').items[0]).toMatchObject({ outcome: 'unknown' })
      expect(localFetch).toHaveBeenCalledTimes(1)
    } finally {
      localFetch.mockRestore()
      db.close()
    }
  })

  it('prepare 失败或身份回调拒绝时绝不发网络，finish 失败也不重发', async () => {
    const httpFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [{ url: 'https://example.test' }] }), { status: 200 }))
    const db = new BillingDatabase(':memory:')
    const originalPrepare = db.prepare.bind(db)
    let failPrepare = true
    db.prepare = ((start: never) => { if (failPrepare) throw new Error('prepare-fault'); return originalPrepare(start) }) as typeof db.prepare
    const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => 'key', quotaSubject: key => key, httpFetch })
    await expect(meter.search({ query: 'prepare' })).rejects.toMatchObject({ code: 'DB_PREPARE_FAILED' })
    expect(httpFetch).not.toHaveBeenCalled()
    failPrepare = false
    const originalFinish = db.finish.bind(db)
    db.finish = (() => { throw new Error('finish-fault') }) as typeof db.finish
    await expect(meter.search({ query: 'finish' })).rejects.toMatchObject({ code: 'DB_FINISH_FAILED' })
    expect(httpFetch).toHaveBeenCalledTimes(1)
    db.finish = originalFinish
    db.close()
  })

  it('配置快照并发隔离，并在 prepare 后执行一次身份锁定回调', async () => {
    const channelA: Channel = { ...deepseek, id: 'deep-a', name: 'Deep A' }
    const channelB: Channel = { ...deepseek, id: 'deep-b', name: 'Deep B' }
    let source = { profileId: 'a', sourceProviderId: 'a' }
    const httpFetch = vi.fn<typeof fetch>(async input => new Response(JSON.stringify({ results: [{ url: `${String(input)}/result` }] }), { status: 200 }))
    const db = new BillingDatabase(':memory:')
    const locks: string[] = []
    const meter = new MeteredWeb({
      db, readConfig: () => ({ channels: [channelA, channelB], providerBindings: { a: { search: 'deep-a' }, b: { search: 'deep-b' } }, globalOverrides: {} }),
      source: () => source, resolveCredential: async () => 'key', quotaSubject: key => key, httpFetch,
      afterPrepare: route => {
        locks.push(`${route.profileId}:${route.channel.id}`)
        expect(db.list(route.profileId).items).toHaveLength(1)
      },
    })
    const first = meter.search({ query: 'one' })
    source = { profileId: 'b', sourceProviderId: 'b' }
    const second = meter.search({ query: 'two' })
    await Promise.all([first, second])
    expect(locks.sort()).toEqual(['a:deep-a', 'b:deep-b'])
    expect(db.list('a').items[0]).toMatchObject({ channelId: 'deep-a', profileId: 'a' })
    expect(db.list('b').items[0]).toMatchObject({ channelId: 'deep-b', profileId: 'b' })
    db.close()
  })

  it('身份锁定回调拒绝时取消 prepared、不派发且不触碰网络', async () => {
    const httpFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }))
    const db = new BillingDatabase(':memory:')
    const meter = new MeteredWeb({
      db,
      readConfig: () => config,
      source: () => ({ profileId: 'p', sourceProviderId: 'source' }),
      resolveCredential: async () => 'key', quotaSubject: key => key, httpFetch,
      afterPrepare: () => { throw new Error('identity rejected') },
    })
    await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'CHANNEL_IDENTITY_INVALID' })
    expect(httpFetch).not.toHaveBeenCalled()
    expect(db.list('p').items).toMatchObject([{ outcome: 'failed', quotaCredits: 0 }])
    db.close()
  })

  it('prepare 失败不执行身份回调', async () => {
    const httpFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }))
    const db = new BillingDatabase(':memory:')
    const prepare = db.prepare.bind(db)
    const afterPrepare = vi.fn()
    db.prepare = (() => { throw new Error('prepare fault') }) as typeof db.prepare
    const meter = new MeteredWeb({
      db, readConfig: () => config,
      source: () => ({ profileId: 'p', sourceProviderId: 'source' }),
      resolveCredential: async () => 'key', quotaSubject: key => key, httpFetch, afterPrepare,
    })
    await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'DB_PREPARE_FAILED' })
    expect(afterPrepare).not.toHaveBeenCalled()
    expect(httpFetch).not.toHaveBeenCalled()
    db.prepare = prepare
    db.close()
  })

  it('身份回调失败释放 Tavily prepared 额度，后续请求可再次派发', async () => {
    const tavily: Channel = {
      id: 'tavily-after-prepare', name: 'Tavily', kind: 'tavily', billingClass: 'free', enabled: true,
      endpointBase: 'https://api.tavily.com', credentialRef: 'TAVILY_KEY', capabilities: ['search'], monthlyCredits: 1,
      prices: { search: { perThousand: '0', currency: 'CNY', policy: 'free' } },
    }
    const httpFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [{ url: 'https://example.test' }] }), { status: 200 }))
    const db = new BillingDatabase(':memory:')
    let reject = true
    const meter = new MeteredWeb({
      db,
      readConfig: () => ({ channels: [tavily], providerBindings: { source: { search: 'tavily-after-prepare' } }, globalOverrides: {} }),
      source: () => ({ profileId: 'p', sourceProviderId: 'source' }),
      resolveCredential: async () => 'same-key', quotaSubject: key => `subject:${key}`, httpFetch,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
      afterPrepare: () => { if (reject) throw new Error('identity rejected') },
    })
    await expect(meter.search({ query: 'first' })).rejects.toMatchObject({ code: 'CHANNEL_IDENTITY_INVALID' })
    expect(httpFetch).not.toHaveBeenCalled()
    expect(db.list('p').items[0]).toMatchObject({ outcome: 'failed', quotaCredits: 0 })
    reject = false
    await expect(meter.search({ query: 'second' })).resolves.toBeDefined()
    expect(httpFetch).toHaveBeenCalledTimes(1)
    expect(db.list('p').items.filter(item => item.channelId === 'tavily-after-prepare')).toHaveLength(2)
    db.close()
  })

  it('安全 URL 允许官方 8192 字符上限', () => {
    expect(parseSafeRequestUrl(`https://example.test/${'a'.repeat(8170)}`).hostname).toBe('example.test')
  })
})
