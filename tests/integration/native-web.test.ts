import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import * as billingPlugin from '../../src/index.ts'

// LocalHttpAdapter 持有 HttpFetchProvider，而随包提供方会阻止回环地址。
// 测试传输层刻意使用合成响应：仍然覆盖真实的插件/路由/账本/原生工具链路，
// 但每个请求都由测试内的 fetch 接缝处理，不会离开当前进程。
vi.mock('@deepseek-ai/dsh-web-fetch-http', () => ({
  HttpFetchProvider: class {
    readonly id = 'http'

    available(): boolean { return true }

    async fetch(request: { url: string }, signal?: AbortSignal): Promise<{
      url: string
      statusCode: number
      body: { kind: 'text'; content: string }
      truncated: boolean
    }> {
      const response = await globalThis.fetch(request.url, { method: 'GET', signal })
      return {
        url: response.url || request.url,
        statusCode: response.status,
        body: { kind: 'text', content: await response.text() },
        truncated: false,
      }
    }
  },
}))

const require = createRequire(import.meta.url)
const dshRoot = dirname(require.resolve('@deepseek-ai/dsh/package.json'))
const loadDsh = (packageName: string): Promise<Record<string, any>> => {
  const manifest = require.resolve(`${packageName}/package.json`, { paths: [dshRoot] })
  expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe('0.2.1-rc.2')
  return import(pathToFileURL(require.resolve(packageName, { paths: [dshRoot] })).href) as Promise<Record<string, any>>
}

const [{ AgentRegistry }, { ToolRuntime }, { WebRuntime }, toolWeb, { TypertRegistry }] = await Promise.all([
  loadDsh('@deepseek-ai/dsh-agent'),
  loadDsh('@deepseek-ai/dsh-tools'),
  loadDsh('@deepseek-ai/dsh-web'),
  loadDsh('@deepseek-ai/dsh-tool-web'),
  loadDsh('@deepseek-ai/dsh-typert-registry'),
])

type Selection = { search?: string; fetch?: string }
type Provider = { id: string; available: () => boolean; search: (request: unknown, signal?: AbortSignal) => Promise<unknown> }
type Harness = { ctx: any; agents: any }
type RequestRecord = { url: string; method: string; body?: string }

let originalFetch: typeof globalThis.fetch
let requests: RequestRecord[]
let sequence = 0

beforeEach(() => {
  originalFetch = globalThis.fetch
  requests = []
  sequence = 0
  globalThis.fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input)
    const method = String(init?.method ?? 'GET')
    const body = typeof init?.body === 'string' ? init.body : undefined
    requests.push({ url, method, ...(body === undefined ? {} : { body }) })
    const allowed = new Set(['https://relay-search.synthetic.invalid/v1/tools/search', 'https://api.deepseek.com/v1/tools/search', 'https://api.deepseek.com/v1/tools/fetch', 'http://synthetic.invalid/page'])
    if (!allowed.has(url)) throw new Error('测试拒绝未获准的网络地址')

    if (method === 'GET' && url.includes('/page')) {
      return new Response('synthetic fetch body', { status: 200, headers: { 'content-type': 'text/plain' } })
    }

    let query = 'synthetic'
    try {
      const parsed = body === undefined ? undefined : JSON.parse(body) as { query?: string }
      query = parsed?.query ?? new URL(url).searchParams.get('q') ?? query
    } catch {
      query = new URL(url).searchParams.get('q') ?? query
    }
    return new Response(JSON.stringify({
      content: `synthetic answer for ${query}`,
      results: [{ url: `https://synthetic.invalid/${encodeURIComponent(query)}`, title: query, snippet: 'synthetic result' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function searchChannel(id: string, billingClass: 'official' | 'relay' = 'relay') {
  const official = billingClass === 'official'
  return {
    id,
    name: id,
    kind: 'deepseek-api' as const,
    billingClass,
    enabled: true,
    endpointBase: official ? 'https://api.deepseek.com/v1/tools' : `https://${id}.synthetic.invalid/v1/tools`,
    credentialRef: `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`,
    capabilities: official ? ['search' as const, 'fetch' as const] : ['search' as const],
    prices: { search: { perThousand: official ? '5' : '1', currency: 'CNY' as const, policy: official ? 'official-nonempty' as const : 'http-200' as const }, ...(official ? { fetch: { perThousand: '5', currency: 'CNY' as const, policy: 'official-nonempty' as const } } : {}) },
  }
}

function fetchChannel() {
  return {
    id: 'synthetic-fetch',
    name: 'synthetic-fetch',
    kind: 'local-http' as const,
    billingClass: 'free' as const,
    enabled: true,
    endpointBase: '',
    capabilities: ['fetch' as const],
    prices: { fetch: { perThousand: '0', currency: 'CNY' as const, policy: 'free' as const } },
  }
}

function configFor(channels: readonly unknown[], providerBindings: Record<string, unknown>, globalOverrides: Record<string, unknown> = {}, failover: Record<string, unknown> = {}) {
  return {
    channels: { get: () => channels },
    providerBindings: { get: () => providerBindings },
    globalOverrides: { get: () => globalOverrides },
    failover: { get: () => failover },
  }
}

async function createHarness(options: {
  selection: Selection
  channels?: readonly unknown[]
  providerBindings?: Record<string, unknown>
  withBilling?: boolean
  providers?: readonly Provider[]
  failover?: Record<string, unknown>
  credential?: (ref: unknown) => Promise<{ value: string } | undefined>
}): Promise<Harness> {
  const ctx = new Context()
  new TypertRegistry(ctx)
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    getSectionOrder: () => 0,
  })
  const agents = new AgentRegistry(ctx)
  new ToolRuntime(ctx, { mode: 'native' })
  new WebRuntime(ctx, {
    searchProvider: { get: () => options.selection.search },
    fetchProvider: { get: () => options.selection.fetch },
  })
  for (const provider of options.providers ?? []) ctx.web.registerSearchProvider(provider)

  if (options.withBilling !== false) {
    ctx.provide('profileContext', {
      name: `native-web-${++sequence}`,
      home: mkdtempSync(join(tmpdir(), 'native-web-billing-')),
    })
    const records = new Map()
    ctx.provide('credentials', {
      resolve: options.credential ?? (async () => ({ value: 'synthetic-key' })),
      describe: async () => ({ configured: true, writable: true }),
      describeRecord: async (key: string) => ({ configured: records.has(key), writable: true }),
      readRecord: async (key: string) => records.get(key),
      modifyRecord: async (key: string, mutate: (old: unknown) => Promise<unknown>) => { const next = await mutate(records.get(key)); if (next) records.set(key, next); return next },
      deleteRecord: async (key: string) => { records.delete(key) },
    })
    billingPlugin.apply(ctx, configFor(options.channels ?? [], options.providerBindings ?? {}, {}, options.failover) as never)
  }

  toolWeb.apply(ctx, {
    search: true,
    fetch: true,
    searchMaxResults: 8,
    searchMaxQueries: 4,
    fetchTimeoutMs: 30_000,
    searchTimeoutMs: 30_000,
    fetchMaxOutputChars: 200_000,
  })
  return { ctx, agents }
}

async function executeTool(harness: Harness, name: string, arguments_: Record<string, unknown>, provider: string) {
  const id = `native-agent-${++sequence}`
  const agent = {
    id,
    session: {
      id,
      requestContext: () => ({ provider, model: 'synthetic-model' }),
    },
  }
  const detach = harness.agents.enter(agent, undefined)
  try {
    return await harness.agents.withInitiator(agent, () => harness.ctx.tools.execute({
      callId: `native-call-${sequence}`,
      name,
      arguments: arguments_,
      agent,
      signal: new AbortController().signal,
    }))
  } finally {
    detach()
  }
}

describe('原生 dsh-tool-web → WebRuntime → 宿主计量插件', () => {
  it('通过渠道Key管理入口配置多Key，真实原生工具依次轮换并在失败后换Key', async () => {
    const relay = searchChannel('relay-search')
    const used: string[] = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const key = new Headers(init?.headers).get('authorization')!; used.push(key)
      return key.endsWith('pool-a') ? new Response('{}', { status: 401 }) : new Response('{"results":[{"url":"https://synthetic.invalid/result"}]}')
    })
    const harness = await createHarness({ selection: { search: 'web-search-metered' }, channels: [relay], providerBindings: { 'relay-model': { search: relay.id } } })
    const stored = await harness.ctx.webSearchBilling.setChannelCredential(relay.id, relay.credentialRef, ['synthetic-pool-a', 'synthetic-pool-b'])
    expect(stored).toMatchObject({ keyCount: 2, source: 'pool' })
    expect(JSON.stringify(stored)).not.toContain('synthetic-pool')
    expect((await executeTool(harness, 'web_search', { queries: ['q1'] }, 'relay-model')).isError).toBeFalsy()
    expect((await executeTool(harness, 'web_search', { queries: ['q2'] }, 'relay-model')).isError).toBeFalsy()
    expect(used).toEqual(['Bearer synthetic-pool-a', 'Bearer synthetic-pool-b', 'Bearer synthetic-pool-b'])
    expect(harness.ctx.webSearchBilling.listAttempts({}, null, 20).items).toHaveLength(3)
  })
  it('通过真实工具注册表执行单查询、多查询 web_search 及 web_fetch', async () => {
    const relay = searchChannel('relay-search')
    const official = searchChannel('official-search', 'official')
    const fetch = fetchChannel()
    const harness = await createHarness({
      selection: { search: 'web-search-metered', fetch: 'web-fetch-metered' },
      channels: [relay, official, fetch],
      providerBindings: {
        'relay-model': { search: 'relay-search' },
        'official-model': { search: 'official-search', fetch: 'official-search' },
        'fetch-model': { fetch: 'synthetic-fetch' },
      },
    })

    const single = await executeTool(harness, 'web_search', { queries: ['one'] }, 'relay-model')
    expect(single.isError).toBeFalsy()
    expect(single.value.sources).toHaveLength(1)

    const multi = await executeTool(harness, 'web_search', { queries: ['two', 'three'] }, 'relay-model')
    expect(multi.isError).toBeFalsy()
    expect(multi.value.sources).toHaveLength(2)

    const fetched = await executeTool(harness, 'web_fetch', { url: 'http://synthetic.invalid/page' }, 'fetch-model')
    expect(fetched.isError).toBeFalsy()
    expect(fetched.value.body.content).toBe('synthetic fetch body')

    const officialResult = await executeTool(harness, 'web_search', { queries: ['official'] }, 'official-model')
    expect(officialResult.isError).toBeFalsy()
    const officialFetch = await executeTool(harness, 'web_fetch', { url: 'https://synthetic.invalid/doc' }, 'official-model')
    expect(officialFetch.isError).toBeFalsy()

    expect(requests).toHaveLength(6)
    expect(requests.filter(request => request.method === 'POST' && request.url.endsWith('/search'))).toHaveLength(4)
    expect(requests.filter(request => request.url.endsWith('/page'))).toHaveLength(1)

    const summary = harness.ctx.webSearchBilling.getSummary({})
    expect(summary.find((row: any) => row.channelId === 'relay-search' && row.operation === 'search')).toMatchObject({ total: 3, billable: 3 })
    expect(summary.find((row: any) => row.channelId === 'official-search' && row.operation === 'search')).toMatchObject({ total: 1, billable: 1, amountMicros: '5000' })
    expect(summary.find((row: any) => row.channelId === 'official-search' && row.operation === 'fetch')).toMatchObject({ total: 1, billable: 1, amountMicros: '5000' })
    expect(summary.find((row: any) => row.channelId === 'synthetic-fetch' && row.operation === 'fetch')).toMatchObject({ total: 1, billable: 1 })

    const attempts = harness.ctx.webSearchBilling.listAttempts({}, undefined, 20).items
    expect(attempts.map((item: any) => item.sourceProviderId)).toEqual(expect.arrayContaining(['relay-model', 'official-model', 'fetch-model']))
    const before = requests.length
    expect(harness.ctx.webSearchBilling.getStatus().totalAttempts).toBe(6)
    harness.ctx.webSearchBilling.listChannelStates()
    harness.ctx.webSearchBilling.getSummary({})
    expect(requests).toHaveLength(before)
    expect(harness.ctx.webSearchBilling.listAttempts({}, undefined, 20).items).toHaveLength(6)
  })
})

describe('WebRuntime 选择失败时不得派发 HTTP', () => {
  it.each([
    ['配置的提供方缺失', 'missing-provider', [], 'WEB_PROVIDER_CONFIGURED_MISSING'],
    ['配置的提供方不可用', 'unavailable-provider', [{ id: 'unavailable-provider', available: () => false, search: async () => { throw new Error('不得调用') } }], 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE'],
    ['提供方选择歧义', undefined, [
      { id: 'provider-a', available: () => true, search: async () => { throw new Error('不得调用') } },
      { id: 'provider-b', available: () => true, search: async () => { throw new Error('不得调用') } },
    ], 'WEB_PROVIDER_AMBIGUOUS'],
  ] as const)('%s', async (_label, selection, providers, code) => {
    const harness = await createHarness({ selection: { search: selection }, withBilling: false, providers })
    const result = await executeTool(harness, 'web_search', { queries: ['zero-dispatch'] }, 'synthetic-model')
    expect(result.isError).toBe(true)
    expect(result.error.info).toMatchObject({ code })
    expect(requests).toHaveLength(0)
  })
})

it('未绑定的计量路由保持零 HTTP 请求和零账本记录', async () => {
  const harness = await createHarness({
    selection: { search: 'web-search-metered' },
    channels: [searchChannel('relay-search')],
    providerBindings: {},
  })
  const result = await executeTool(harness, 'web_search', { queries: ['unbound'] }, 'unbound-model')
  expect(result.isError).toBe(true)
  expect(result.error.message).toContain('当前provider未绑定渠道')
  expect(result.error.info).toMatchObject({ code: 'ROUTE_UNBOUND' })
  expect(requests).toHaveLength(0)
  expect(harness.ctx.webSearchBilling.getSummary({})).toEqual([])
})

it('原生Search/Fetch使用TinyFish、千帆、Tavily有序接力，实际HTTP逐次入账', async () => {
  const service = (id: string, kind: 'tinyfish' | 'qianfan' | 'tavily') => ({
    id, name: id, kind, billingClass: 'service', enabled: true,
    endpointBase: kind === 'tinyfish' ? 'https://api.search.tinyfish.ai' : kind === 'qianfan' ? 'https://qianfan.baidubce.com/v2/ai_search/web_search' : 'https://api.tavily.com',
    credentialRef: 'SYNTHETIC_KEY', capabilities: kind === 'qianfan' ? ['search'] : ['search', 'fetch'],
    prices: { search: { perThousand: null, currency: 'CNY', policy: 'provider-success' }, ...(kind === 'qianfan' ? {} : { fetch: { perThousand: null, currency: 'CNY', policy: 'provider-success' } }) },
  })
  const calls: string[] = []
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input); calls.push(url)
    if (url.startsWith('https://api.search.tinyfish.ai/')) return new Response('{}', { status: 429 })
    if (url === 'https://qianfan.baidubce.com/v2/ai_search/web_search') return new Response(JSON.stringify({ references: [{ url: 'https://synthetic.invalid/doc', title: '百度结果', content: '搜索摘要' }] }))
    if (url === 'https://api.fetch.tinyfish.ai/') return new Response(JSON.stringify({ results: [], errors: [{ url: 'https://synthetic.invalid/doc', error: 'timeout' }] }))
    if (url === 'https://api.tavily.com/extract') {
      expect(JSON.parse(String(init?.body))).toMatchObject({ urls: ['https://synthetic.invalid/doc'] })
      return new Response(JSON.stringify({ results: [{ url: 'https://synthetic.invalid/doc', raw_content: 'Tavily正文' }], failed_results: [] }))
    }
    throw new Error('禁止未预期网络请求')
  }) as typeof fetch
  const setting = { enabled: true, attemptTimeoutMs: 1000, totalTimeoutMs: 5000 }
  const harness = await createHarness({ selection: { search: 'web-search-metered', fetch: 'web-fetch-metered' }, channels: [service('tiny', 'tinyfish'), service('baidu', 'qianfan'), service('tav', 'tavily')], failover: { search: setting, fetch: setting } })
  const searched = await executeTool(harness, 'web_search', { queries: ['synthetic'] }, 'unchanged-model')
  expect(searched.isError, JSON.stringify(searched.error)).toBeFalsy()
  expect(searched.value.sources).toHaveLength(1)
  const fetched = await executeTool(harness, 'web_fetch', { url: 'https://synthetic.invalid/doc' }, 'unchanged-model')
  expect(fetched.isError, JSON.stringify(fetched.error)).toBeFalsy()
  expect(fetched.value.body.content).toBe('Tavily正文')
  expect(calls).toHaveLength(4)
  const attempts = harness.ctx.webSearchBilling.listAttempts({}, null, 20).items
  expect(attempts).toHaveLength(4)
  expect(attempts.every((row: any) => row.sourceProviderId === 'unchanged-model')).toBe(true)
  expect(new Set(attempts.map((row: any) => row.operationId)).size).toBe(2)
  expect(attempts.filter((row: any) => row.outcome === 'failed')).toHaveLength(2)
})

it.each([['tinyfish', 'search'], ['tinyfish', 'fetch'], ['qianfan', 'search'], ['tavily', 'search'], ['tavily', 'fetch']] as const)('原生工具通过%s %s成功适配并按真实请求计量', async (kind, operation) => {
  const endpointBase = kind === 'tinyfish' ? 'https://api.search.tinyfish.ai' : kind === 'qianfan' ? 'https://qianfan.baidubce.com/v2/ai_search/web_search' : 'https://api.tavily.com'
  let count = 0
  globalThis.fetch = vi.fn(async () => {
    count++
    const payload = operation === 'search'
      ? { [kind === 'qianfan' ? 'references' : 'results']: [{ url: 'https://synthetic.invalid/doc', title: '合成结果' }] }
      : { results: [{ url: 'https://synthetic.invalid/doc', text: '合成正文', raw_content: '合成正文' }], failed_results: [], errors: [] }
    return new Response(JSON.stringify(payload))
  }) as typeof fetch
  const channel = { id: 'synthetic-service', name: kind, kind, billingClass: 'service', enabled: true, endpointBase, credentialRef: 'SYNTHETIC_KEY', capabilities: [operation], prices: { [operation]: { perThousand: null, currency: 'CNY', policy: 'provider-success' } } }
  const harness = await createHarness({ selection: { search: 'web-search-metered', fetch: 'web-fetch-metered' }, channels: [channel], providerBindings: { origin: { [operation]: channel.id } } })
  const result = await executeTool(harness, operation === 'search' ? 'web_search' : 'web_fetch', operation === 'search' ? { queries: ['synthetic'] } : { url: 'https://synthetic.invalid/doc' }, 'origin')
  expect(result.isError, JSON.stringify(result.error)).toBeFalsy()
  expect(count).toBe(1)
  const rows = harness.ctx.webSearchBilling.listAttempts({}, null, 10).items
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ operation, sourceProviderId: 'origin', outcome: 'billable', amountMicros: null })
})
