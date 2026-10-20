import { describe, expect, it, vi } from 'vitest'
import type { Channel, RouteSnapshot } from '../../src/contracts.ts'
import { endpointFor } from '../../src/providers/common.ts'
import { QianfanAdapter } from '../../src/providers/qianfan.ts'
import { TinyFishAdapter } from '../../src/providers/tinyfish.ts'
import { TavilyAdapter } from '../../src/providers/tavily.ts'

const route = (channel: Channel, operation: 'search' | 'fetch'): RouteSnapshot => ({
  profileId: 'p', operation, channel, price: channel.prices[operation]!, configRevision: 'r', routeSource: 'binding',
})

const tinyfish: Channel = {
  id: 'tiny', name: 'TinyFish', kind: 'tinyfish', billingClass: 'service', enabled: true,
  endpointBase: 'https://api.search.tinyfish.ai', credentialRef: 'TINY_KEY', capabilities: ['search', 'fetch'],
  prices: { search: { perThousand: null, currency: 'USD', policy: 'provider-success' }, fetch: { perThousand: null, currency: 'USD', policy: 'provider-success' } },
}

describe('provider protocol contracts', () => {
  it('新服务商畸形结果数组不能作为成功或合法空结果计量', async () => {
    const qianfan: Channel = { ...tinyfish, kind: 'qianfan', endpointBase: 'https://qianfan.baidubce.com/v2/ai_search/web_search', capabilities: ['search'] }
    const tavily: Channel = { ...tinyfish, kind: 'tavily', endpointBase: 'https://api.tavily.com' }
    for (const [adapter, channel, key] of [[new TinyFishAdapter(null as never), tinyfish, 'results'], [new QianfanAdapter(null as never), qianfan, 'references'], [new TavilyAdapter(null as never), tavily, 'results']] as const) {
      for (const entries of [[null], [{ title: 'missing URL' }]]) {
        const http = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ [key]: entries })))
        const instance = new (adapter.constructor as any)(http)
        const raw = await instance.search({ query: 'q' }, route(channel, 'search'), 'synthetic')
        expect(raw.billingEvidence?.state).toBe('unknown')
      }
    }
  })
  it('resolves TinyFish Search and Fetch to their distinct official origins', () => {
    expect(endpointFor(tinyfish, 'search')).toBe('https://api.search.tinyfish.ai/')
    expect(endpointFor(tinyfish, 'fetch')).toBe('https://api.fetch.tinyfish.ai/')
  })

  it('uses TinyFish API key and marks a valid empty Search response as provider success', async () => {
    const http = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain('https://api.search.tinyfish.ai/')
      expect(new URL(String(input)).searchParams.get('query')).toBe('q')
      expect(init?.method).toBe('GET')
      expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('secret')
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    })
    const raw = await new TinyFishAdapter(http).search({ query: 'q', maxResults: 50 }, route(tinyfish, 'search'), 'secret')
    expect(raw.billingEvidence).toMatchObject({ state: 'success', resultCount: 0, hasContent: false })
  })

  it('does not treat a TinyFish Fetch HTTP 200 target error as success', async () => {
    const http = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({ urls: ['https://example.test/a'], format: 'markdown' }))
      return new Response(JSON.stringify({ results: [], errors: [{ url: 'https://example.test/a', error: 'blocked' }] }), { status: 200 })
    })
    const raw = await new TinyFishAdapter(http).fetch({ url: 'https://example.test/a' }, route(tinyfish, 'fetch'), 'secret')
    expect(raw.billingEvidence?.state).toBe('failed')
    expect(raw.status).toBe(200)
  })

  it('sends Qianfan Search without a chat generation model and normalizes references', async () => {
    const qianfan: Channel = { ...tinyfish, id: 'qianfan', kind: 'qianfan', endpointBase: 'https://qianfan.baidubce.com/v2/ai_search/web_search', capabilities: ['search'], prices: { search: { perThousand: null, currency: 'CNY', policy: 'provider-success' } } }
    const http = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>)['X-Appbuilder-Authorization']).toBe('Bearer secret')
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ search_source: 'baidu_search_v2', resource_type_filter: [{ type: 'web', top_k: 3 }], messages: [{ content: 'q' }] })
      expect(body.max_results).toBeUndefined()
      expect(body.model).toBeUndefined()
      return new Response(JSON.stringify({ references: [{ url: 'https://example.test/a', title: 'A', content: 'snippet' }] }), { status: 200 })
    })
    const raw = await new QianfanAdapter(http).search({ query: 'q', maxResults: 3 }, route(qianfan, 'search'), 'secret')
    expect(raw.billingEvidence).toMatchObject({ state: 'success', resultCount: 1 })
    expect(new QianfanAdapter(http).normalizeSearch(raw.payload, { query: 'q', maxResults: 3 }).sources[0]).toMatchObject({ url: 'https://example.test/a', title: 'A', snippet: 'snippet' })
  })

  it('uses Tavily Extract and limits Search request to 20 while accepting maxResults 50', async () => {
    const tavily: Channel = { ...tinyfish, id: 'tavily', kind: 'tavily', billingClass: 'service', endpointBase: 'https://api.tavily.com', credentialRef: 'TAVILY_KEY', prices: { search: { perThousand: null, currency: 'USD', policy: 'provider-success' }, fetch: { perThousand: null, currency: 'USD', policy: 'provider-success' } } }
    const http = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body))
      if (url.endsWith('/search')) {
        expect(body.max_results).toBe(20)
        return new Response(JSON.stringify({ results: [] }), { status: 200 })
      }
      expect(url).toBe('https://api.tavily.com/extract')
      expect(body).toMatchObject({ urls: ['https://example.test/a'], extract_depth: 'basic', format: 'markdown' })
      return new Response(JSON.stringify({ results: [{ url: 'https://example.test/a', raw_content: 'body' }] }), { status: 200 })
    })
    const adapter = new TavilyAdapter(http)
    await adapter.search({ query: 'q', maxResults: 50 }, route(tavily, 'search'), 'secret')
    const raw = await adapter.fetch({ url: 'https://example.test/a' }, route(tavily, 'fetch'), 'secret')
    expect(raw.billingEvidence).toMatchObject({ state: 'success', hasContent: true })
    expect(adapter.normalizeFetch(raw.payload, { url: 'https://example.test/a' }, 200)).toMatchObject({ body: { content: 'body' } })
  })
})
