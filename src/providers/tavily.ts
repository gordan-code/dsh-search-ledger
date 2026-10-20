import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { BillingEvidence, RouteSnapshot } from '../contracts.ts'
import { callJson, normalizeSearchSources, normalizeFetchContent, optionalText, preferredSnippet, requiredUrl, validateEndpoint, type RawResponse, type FetchAdapter, type SearchAdapter } from './common.ts'

type SearchRequest = { query: string; maxResults?: number }
type FetchRequest = { url: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function sameUrl(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false
  try { return new URL(left).toString() === new URL(right).toString() } catch { return false }
}

function searchEvidence(status: number, payload: unknown): BillingEvidence {
  const parsed = record(payload)
  if (status !== 200) return { state: 'failed' }
  if (!parsed || !Array.isArray(parsed.results)) return { state: 'unknown' }
  try { for (const item of parsed.results) requiredUrl(record(item)?.url) } catch { return { state: 'unknown' } }
  return { state: 'success', resultCount: parsed.results.length, hasContent: parsed.results.length > 0 }
}

function extractEvidence(status: number, payload: unknown, target: string): BillingEvidence {
  if (status !== 200) return { state: 'failed' }
  const parsed = record(payload)
  if (!parsed) return { state: 'unknown' }
  const results = Array.isArray(parsed.results) ? parsed.results : []
  const failed = Array.isArray(parsed.failed_results) ? parsed.failed_results : []
  if (failed.some(item => sameUrl(record(item)?.url, target))) return { state: 'failed' }
  const targetResult = results.find(item => sameUrl(record(item)?.url, target))
  if (targetResult === undefined) return { state: results.length === 0 && failed.length === 0 ? 'unknown' : 'failed' }
  const entry = record(targetResult)
  const content = entry?.raw_content ?? entry?.content
  if (typeof content !== 'string') return { state: 'unknown' }
  return { state: 'success', hasContent: content.trim().length > 0 }
}

/** Tavily Search/Extract 官方适配器。Search的输入上限为50，但单次请求最多发20条。 */
export class TavilyAdapter implements SearchAdapter, FetchAdapter {
  constructor(private readonly httpFetch: typeof fetch) {}

  async search(request: SearchRequest, route: RouteSnapshot, credential: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    const endpoint = validateEndpoint(route.channel, 'search')
    const raw = await callJson(this.httpFetch, endpoint!, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credential ?? ''}` },
      body: JSON.stringify({ query: request.query, search_depth: 'basic', auto_parameters: false, max_results: Math.min(request.maxResults ?? 10, 20) }),
    }, signal)
    return { ...raw, billingEvidence: searchEvidence(raw.status, raw.payload) }
  }

  normalizeSearch(payload: unknown, request: SearchRequest): WebSearchResult {
    const parsed = normalizeSearchSources(payload)
    const sources = parsed.results.map(item => ({
      url: requiredUrl(item.url),
      ...(optionalText(item.title) === undefined ? {} : { title: optionalText(item.title) }),
      ...(preferredSnippet(item) === undefined ? {} : { snippet: preferredSnippet(item) }),
      ...(optionalText(item.published_date) === undefined && optionalText(item.date) === undefined ? {} : { publishedAt: optionalText(item.published_date) ?? optionalText(item.date) }),
    }))
    const limit = request.maxResults ?? sources.length
    return { ...(parsed.content === undefined ? {} : { content: parsed.content }), sources: sources.slice(0, limit), truncated: sources.length > limit }
  }

  async fetch(request: FetchRequest, route: RouteSnapshot, credential: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    const endpoint = validateEndpoint(route.channel, 'fetch')
    const raw = await callJson(this.httpFetch, endpoint!, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credential ?? ''}` },
      body: JSON.stringify({ urls: [request.url], extract_depth: 'basic', format: 'markdown' }),
    }, signal)
    return { ...raw, billingEvidence: extractEvidence(raw.status, raw.payload, request.url) }
  }

  normalizeFetch(payload: unknown, request: FetchRequest, status: number): WebFetchResult {
    const parsed = record(payload)
    const results = parsed && Array.isArray(parsed.results) ? parsed.results : []
    const entry = results.find(item => sameUrl(record(item)?.url, request.url))
    const content = record(entry)?.raw_content ?? record(entry)?.content
    if (typeof content !== 'string') {
      // 保持统一的 RESULT_INVALID 错误码，不将非目标或畸形条目投影成成功正文。
      normalizeFetchContent({ content })
    }
    return { url: request.url, statusCode: status, body: { kind: 'text', content: content as string }, truncated: false }
  }
}

export { TavilyAdapter as TavilyProvider }
