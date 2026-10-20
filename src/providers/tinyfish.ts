import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { BillingEvidence, RouteSnapshot } from '../contracts.ts'
import { callJson, invalid, normalizeSearchSources, optionalText, preferredSnippet, requiredUrl, validateEndpoint, type FetchAdapter, type RawResponse, type SearchAdapter } from './common.ts'

type SearchRequest = { query: string; maxResults?: number }
type FetchRequest = { url: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function sameUrl(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false
  try { return new URL(left).toString() === new URL(right).toString() } catch { return false }
}

function matchesTarget(value: unknown, target: string): boolean {
  const item = record(value)
  return sameUrl(item?.url ?? item?.target_url, target)
}

function searchEvidence(status: number, payload: unknown): BillingEvidence {
  const parsed = record(payload)
  if (status !== 200) return { state: 'failed' }
  if (!parsed || !Array.isArray(parsed.results)) return { state: 'unknown' }
  try { for (const item of parsed.results) requiredUrl(record(item)?.url) } catch { return { state: 'unknown' } }
  return { state: 'success', resultCount: parsed.results.length, hasContent: parsed.results.length > 0 }
}

function fetchEvidence(status: number, payload: unknown, target: string): BillingEvidence {
  if (status !== 200) return { state: 'failed' }
  const parsed = record(payload)
  if (!parsed) return { state: 'unknown' }
  const errors = Array.isArray(parsed.errors) ? parsed.errors : []
  if (errors.some(error => matchesTarget(error, target))) return { state: 'failed' }
  const results = Array.isArray(parsed.results) ? parsed.results : []
  const targetResult = results.find(result => matchesTarget(result, target))
  if (targetResult === undefined) return { state: results.length > 0 ? 'failed' : 'unknown' }
  const item = record(targetResult)
  const content = item?.text ?? item?.content ?? item?.markdown
  if (typeof content !== 'string') return { state: 'unknown' }
  return { state: 'success', hasContent: content.trim().length > 0 }
}

/** TinyFish Search/Fetch适配器；两种操作保持不同官方origin，不接受配置改写。 */
export class TinyFishAdapter implements SearchAdapter, FetchAdapter {
  constructor(private readonly httpFetch: typeof fetch) {}

  async search(request: SearchRequest, route: RouteSnapshot, credential: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    const endpoint = validateEndpoint(route.channel, 'search')
    const url = new URL(endpoint!)
    url.searchParams.set('query', request.query)
    const raw = await callJson(this.httpFetch, url, {
      method: 'GET',
      headers: { accept: 'application/json', 'X-API-Key': credential ?? '' },
    }, signal)
    return { ...raw, billingEvidence: searchEvidence(raw.status, raw.payload) }
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
    const raw = await callJson(this.httpFetch, endpoint!, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'X-API-Key': credential ?? '' },
      body: JSON.stringify({ urls: [request.url], format: 'markdown', include_images: false, include_links: false }),
    }, signal)
    return { ...raw, billingEvidence: fetchEvidence(raw.status, raw.payload, request.url) }
  }

  normalizeFetch(payload: unknown, request: FetchRequest, status: number): WebFetchResult {
    const parsed = record(payload)
    const results = parsed && Array.isArray(parsed.results) ? parsed.results : []
    const item = results.find(result => matchesTarget(result, request.url))
    const entry = record(item)
    const content = entry?.text ?? entry?.content ?? entry?.markdown
    if (typeof content !== 'string') throw invalid('上游抓取响应格式无效', 'RESULT_INVALID')
    return { url: request.url, statusCode: status, body: { kind: 'text', content }, truncated: false }
  }
}

export { TinyFishAdapter as TinyFishProvider }
