import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import type { BillingEvidence, RouteSnapshot } from '../contracts.ts'
import { callJson, invalid, optionalText, preferredSnippet, requiredUrl, validateEndpoint, type RawResponse, type SearchAdapter } from './common.ts'

type SearchRequest = { query: string; maxResults?: number }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function references(payload: unknown): Record<string, unknown>[] | undefined {
  const parsed = record(payload)
  const refs = parsed?.references
  if (!Array.isArray(refs)) return undefined
  if (refs.some(item => typeof item !== 'object' || item === null || Array.isArray(item))) return undefined
  return refs as Record<string, unknown>[]
}

function evidence(status: number, payload: unknown): BillingEvidence {
  if (status !== 200) return { state: 'failed' }
  const refs = references(payload)
  if (refs === undefined) return { state: 'unknown' }
  try { for (const item of refs) requiredUrl(item.url) } catch { return { state: 'unknown' } }
  return { state: 'success', resultCount: refs.length, hasContent: refs.length > 0 }
}

/** 百度千帆 AppBuilder Web Search 适配器；只使用搜索接口，不调用聊天生成模型。 */
export class QianfanAdapter implements SearchAdapter {
  constructor(private readonly httpFetch: typeof fetch) {}

  async search(request: SearchRequest, route: RouteSnapshot, credential: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    const endpoint = validateEndpoint(route.channel, 'search')
    const raw = await callJson(this.httpFetch, endpoint!, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'X-Appbuilder-Authorization': `Bearer ${credential ?? ''}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: request.query }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: request.maxResults ?? 10 }],
      }),
    }, signal)
    return { ...raw, billingEvidence: evidence(raw.status, raw.payload) }
  }

  normalizeSearch(payload: unknown, request: SearchRequest): WebSearchResult {
    const refs = references(payload)
    if (refs === undefined) throw invalid('上游搜索响应格式无效', 'RESULT_INVALID')
    const sources = refs.map(item => ({
      url: requiredUrl(item.url),
      ...(optionalText(item.title) === undefined ? {} : { title: optionalText(item.title) }),
      ...(preferredSnippet(item) === undefined ? {} : { snippet: preferredSnippet(item) }),
      ...(optionalText(item.date) === undefined ? {} : { publishedAt: optionalText(item.date) }),
    }))
    const limit = request.maxResults ?? sources.length
    return { sources: sources.slice(0, limit), truncated: sources.length > limit }
  }
}

export { QianfanAdapter as QianfanProvider }
