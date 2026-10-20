import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import type { RouteSnapshot } from '../contracts.ts'
import { callJson, normalizeSearchSources, optionalText, preferredSnippet, requiredUrl, validateEndpoint, type RawResponse, type SearchAdapter } from './common.ts'

type SearchRequest = { query: string; maxResults?: number }

/** 自建 SearXNG 适配器；地址始终来自已解析配置，不接受请求改写。 */
export class SearXNGAdapter implements SearchAdapter {
  constructor(private readonly httpFetch: typeof fetch) {}

  async search(request: SearchRequest, route: RouteSnapshot, _credential: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    const endpoint = validateEndpoint(route.channel, 'search')
    const url = new URL(endpoint!.toString())
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    return callJson(this.httpFetch, url, { method: 'GET', headers: { accept: 'application/json' } }, signal)
  }

  normalizeSearch(payload: unknown, request: SearchRequest): WebSearchResult {
    const parsed = normalizeSearchSources(payload)
    const sources = parsed.results.map(item => ({
      url: requiredUrl(item.url),
      ...(optionalText(item.title) === undefined ? {} : { title: optionalText(item.title) }),
      ...(preferredSnippet(item) === undefined ? {} : { snippet: preferredSnippet(item) }),
      ...(optionalText(item.publishedDate) === undefined && optionalText(item.date) === undefined ? {} : { publishedAt: optionalText(item.publishedDate) ?? optionalText(item.date) }),
    }))
    const limit = request.maxResults ?? sources.length
    return { ...(parsed.content === undefined ? {} : { content: parsed.content }), sources: sources.slice(0, limit), truncated: sources.length > limit }
  }
}

export { SearXNGAdapter as SearXNGProvider }
