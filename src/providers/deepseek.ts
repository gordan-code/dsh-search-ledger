import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { RouteSnapshot } from '../contracts.ts'
import { callJson, normalizeFetchContent, normalizeSearchSources, optionalText, preferredSnippet, requiredUrl, validateEndpoint, type FetchAdapter, type RawResponse, type SearchAdapter } from './common.ts'

type SearchRequest = { query: string; maxResults?: number }
type FetchRequest = { url: string }

/** DeepSeek 官方/兼容 API 适配器；调用方负责在 prepare 阶段校验凭证。 */
export class DeepSeekAdapter implements SearchAdapter, FetchAdapter {
  constructor(private readonly httpFetch: typeof fetch) {}

  async search(request: SearchRequest, route: RouteSnapshot, credential: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    const endpoint = validateEndpoint(route.channel, 'search')
    const url = endpoint!
    return callJson(this.httpFetch, url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credential ?? ''}` },
      body: JSON.stringify({ query: request.query, count: request.maxResults ?? 10 }),
    }, signal)
  }

  normalizeSearch(payload: unknown, request: SearchRequest): WebSearchResult {
    const parsed = normalizeSearchSources(payload)
    const sources = parsed.results.map(item => ({
      url: requiredUrl(item.url),
      ...(optionalText(item.title) === undefined ? {} : { title: optionalText(item.title) }),
      ...(preferredSnippet(item) === undefined ? {} : { snippet: preferredSnippet(item) }),
      ...(optionalText(item.date) === undefined ? {} : { publishedAt: optionalText(item.date) }),
    }))
    const limit = request.maxResults ?? sources.length
    return { ...(parsed.content === undefined ? {} : { content: parsed.content }), sources: sources.slice(0, limit), truncated: sources.length > limit }
  }

  async fetch(request: FetchRequest, route: RouteSnapshot, credential: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    const endpoint = validateEndpoint(route.channel, 'fetch')
    const url = endpoint!
    return callJson(this.httpFetch, url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credential ?? ''}` },
      body: JSON.stringify({ url: request.url }),
    }, signal)
  }

  normalizeFetch(payload: unknown, request: FetchRequest, status: number): WebFetchResult {
    return { url: request.url, statusCode: status, body: { kind: 'text', content: normalizeFetchContent(payload) }, truncated: false }
  }
}

export { DeepSeekAdapter as DeepSeekProvider }
