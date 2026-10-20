import { describe, expect, it, vi } from 'vitest'
import { BillingDatabase } from '../../src/storage/database.ts'
import type { Channel, RoutingConfig } from '../../src/contracts.ts'
import { MeteredWeb } from '../../src/accounting/meter.ts'

const searx: Channel = {
  id: 'searx', name: '自建 SearXNG', kind: 'searxng', billingClass: 'free', enabled: true,
  endpointBase: 'http://searx.internal/', allowHttp: true, capabilities: ['search'],
  prices: { search: { perThousand: '0', currency: 'CNY', policy: 'free' } },
}
const tavily: Channel = {
  id: 'tavily', name: 'Tavily', kind: 'tavily', billingClass: 'free', enabled: true,
  endpointBase: 'https://api.tavily.com', credentialRef: 'TAVILY_KEY', capabilities: ['search'], monthlyCredits: 1,
  prices: { search: { perThousand: '0', currency: 'CNY', policy: 'free' } },
}

describe('计量 HTTP 安全边界', () => {
  it('SearXNG 只访问配置地址并使用 JSON 查询，不携带 Bearer', async () => {
    const db = new BillingDatabase(':memory:')
    const httpFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('http://searx.internal')
      expect(url.pathname).toBe('/search')
      expect(url.searchParams.get('q')).toBe('a b')
      expect(url.searchParams.get('format')).toBe('json')
      expect((init?.headers as Record<string, string>)?.authorization).toBeUndefined()
      return new Response(JSON.stringify({ results: [{ url: 'https://example.test', title: 'x' }] }), { status: 200 })
    })
    const meter = new MeteredWeb({
      db, readConfig: () => ({ channels: [searx], providerBindings: { source: { search: 'searx' } }, globalOverrides: {} }),
      source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => 'must-not-use', quotaSubject: key => key, httpFetch,
    })
    await expect(meter.search({ query: 'a b' })).resolves.toMatchObject({ sources: [{ url: 'https://example.test/' }] })
    db.close()
  })

  it('Tavily 固定 basic 参数并跨 profile 共享额度主体', async () => {
    const db = new BillingDatabase(':memory:')
    let profile = 'a'
    const httpFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer tavily-secret')
      expect(JSON.parse(String(init?.body))).toMatchObject({ search_depth: 'basic', auto_parameters: false, max_results: 20 })
      return new Response(JSON.stringify({ results: [{ url: 'https://example.test' }] }), { status: 200 })
    })
    const meter = new MeteredWeb({
      db, readConfig: () => ({ channels: [tavily], providerBindings: { source: { search: 'tavily' } }, globalOverrides: {} }),
      source: () => ({ profileId: profile, sourceProviderId: 'source' }), resolveCredential: async () => 'tavily-secret', quotaSubject: key => `fingerprint:${key}`,
      httpFetch, now: () => new Date('2026-10-19T00:00:00.000Z'),
    })
    await expect(meter.search({ query: 'q', maxResults: 20 })).resolves.toBeDefined()
    profile = 'b'
    await expect(meter.search({ query: 'q', maxResults: 20 })).rejects.toMatchObject({ code: 'QUOTA_LOCAL_LIMIT' })
    expect(httpFetch).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('派发前取消不触碰网络并释放 prepared 额度', async () => {
    const db = new BillingDatabase(':memory:')
    const httpFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    const controller = new AbortController(); controller.abort()
    const meter = new MeteredWeb({
      db, readConfig: () => ({ channels: [tavily], providerBindings: { source: { search: 'tavily' } }, globalOverrides: {} }),
      source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => 'secret', quotaSubject: key => key, httpFetch,
    })
    await expect(meter.search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(httpFetch).not.toHaveBeenCalled()
    expect(db.list('p').items[0]).toMatchObject({ outcome: 'failed' })
    db.close()
  })

  it('拒绝带凭证的渠道地址并且不会调用 fetch', async () => {
    const db = new BillingDatabase(':memory:')
    const httpFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    const bad: Channel = { ...searx, id: 'bad', endpointBase: 'https://user:password@example.test' }
    const meter = new MeteredWeb({
      db, readConfig: () => ({ channels: [bad], providerBindings: { source: { search: 'bad' } }, globalOverrides: {} }),
      source: () => ({ profileId: 'p', sourceProviderId: 'source' }), resolveCredential: async () => undefined, quotaSubject: key => key, httpFetch,
    })
    await expect(meter.search({ query: 'q' })).rejects.toMatchObject({ code: 'ENDPOINT_INVALID' })
    expect(httpFetch).not.toHaveBeenCalled()
    db.close()
  })
})
