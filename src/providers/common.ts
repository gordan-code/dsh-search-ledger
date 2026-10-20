import type { BillingEvidence, Channel, Operation, RouteSnapshot } from '../contracts.ts'
import { BillingError } from '../contracts.ts'
import { requestText, type HttpTransportError } from '../transport/http.ts'
import { requiresCredential as requiresCredentialForKind } from '../channel-kinds.ts'

export interface RawResponse {
  readonly status: number
  readonly payload?: unknown
  readonly billingEvidence?: BillingEvidence
}

export interface SearchAdapter {
  search(request: { query: string; maxResults?: number }, route: RouteSnapshot, credential: string | undefined, signal?: AbortSignal): Promise<RawResponse>
  normalizeSearch(payload: unknown, request: { query: string; maxResults?: number }): { content?: string; sources: readonly { url: string; title?: string; snippet?: string; publishedAt?: string }[]; truncated: boolean }
}

export interface FetchAdapter {
  fetch(request: { url: string }, route: RouteSnapshot, credential: string | undefined, signal?: AbortSignal): Promise<RawResponse>
  normalizeFetch(payload: unknown, request: { url: string }, status: number): { url: string; statusCode: number; body: { kind: 'html' | 'text'; content: string }; truncated: boolean }
}

export function invalid(message: string, code = 'INVALID_ARGUMENT'): BillingError {
  return new BillingError(code, message)
}

export function validateQuery(query: unknown, maxResults: unknown): { query: string; maxResults: number } {
  if (typeof query !== 'string' || query.trim().length === 0) throw invalid('搜索词不能为空')
  const count = [...query].length
  if (count < 1 || count > 128) throw invalid('搜索词长度必须在 1 到 128 个字符之间')
  const resultCount = maxResults === undefined ? 10 : maxResults
  if (typeof resultCount !== 'number' || !Number.isSafeInteger(resultCount) || resultCount < 1 || resultCount > 50) throw invalid('结果数量必须在 1 到 50 之间')
  return { query, maxResults: resultCount }
}

export function validateFetchUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > 8192) throw invalid('抓取地址无效')
  let url: URL
  try { url = new URL(value) } catch { throw invalid('抓取地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid('抓取地址必须使用 HTTP(S) 且不得内嵌凭证')
  return url
}

export function validateEndpoint(channel: Channel, operation: Operation): URL | undefined {
  if (channel.kind === 'local-http') return undefined
  return new URL(endpointFor(channel, operation))
}

function configuredEndpoint(channel: Channel): URL {
  let url: URL
  try { url = new URL(channel.endpointBase) } catch { throw invalid('渠道地址无效', 'ENDPOINT_INVALID') }
  if (url.username || url.password || url.search || url.hash) throw invalid('渠道地址不得内嵌凭证、查询或片段', 'ENDPOINT_INVALID')
  if (url.protocol !== 'https:' && !(channel.kind === 'searxng' && channel.allowHttp === true && url.protocol === 'http:')) throw invalid('渠道地址必须使用 HTTPS', 'ENDPOINT_INVALID')
  return url
}

/** 统一得到某渠道/操作真实派发地址；TinyFish Search/Fetch刻意使用两个固定origin。 */
export function endpointFor(channel: Channel, operation: Operation): string {
  if (channel.kind === 'local-http') return ''
  const configured = configuredEndpoint(channel)
  if (channel.kind === 'deepseek-api') {
    if (channel.billingClass === 'official' && configured.origin !== 'https://api.deepseek.com') throw invalid('官方渠道地址不受信任', 'ENDPOINT_INVALID')
    return appendPath(configured, operation).toString()
  }
  if (channel.kind === 'searxng') return appendPath(configured, 'search').toString()
  if (channel.kind === 'tavily') {
    if (configured.origin !== 'https://api.tavily.com') throw invalid('Tavily 仅允许官方地址', 'ENDPOINT_INVALID')
    return operation === 'search' ? 'https://api.tavily.com/search' : 'https://api.tavily.com/extract'
  }
  if (channel.kind === 'tinyfish') {
    if (configured.origin !== 'https://api.search.tinyfish.ai' || configured.pathname !== '/') throw invalid('TinyFish地址不受信任', 'ENDPOINT_INVALID')
    return operation === 'search' ? 'https://api.search.tinyfish.ai/' : 'https://api.fetch.tinyfish.ai/'
  }
  if (channel.kind === 'qianfan') {
    if (operation !== 'search' || configured.origin !== 'https://qianfan.baidubce.com' || !['/v2/ai_search', '/v2/ai_search/web_search'].includes(configured.pathname)) throw invalid('千帆地址不受信任', 'ENDPOINT_INVALID')
    return 'https://qianfan.baidubce.com/v2/ai_search/web_search'
  }
  throw invalid('渠道类型不支持', 'ENDPOINT_INVALID')
}

export function requiresCredential(channel: Channel): boolean {
  return requiresCredentialForKind(channel)
}

export function appendPath(base: URL, suffix: string): URL {
  const url = new URL(base.toString())
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = `${path}/${suffix}`
  return url
}

export function parseJson(body: string): unknown {
  try { return JSON.parse(body) as unknown } catch { return undefined }
}

export async function callJson(fetchImpl: typeof fetch, url: URL | string, init: RequestInit, signal?: AbortSignal): Promise<RawResponse> {
  const response = await requestText(fetchImpl, String(url), init, signal)
  const payload = parseJson(response.body)
  return { status: response.status, payload }
}

export function isTransportError(error: unknown): error is HttpTransportError {
  return error instanceof Error && error.name === 'HttpTransportError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function requiredUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid('上游来源缺少有效 URL', 'RESULT_INVALID')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw invalid('上游来源缺少有效 URL', 'RESULT_INVALID') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw invalid('上游来源缺少有效 URL', 'RESULT_INVALID')
  return parsed.toString()
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 统一使用摘要，其次才是 snippet/content，避免丢失后端更适合模型的摘要。 */
export function preferredSnippet(value: Record<string, unknown>): string | undefined {
  return optionalText(value.summary) ?? optionalText(value.snippet) ?? optionalText(value.content)
}

export function normalizeSearchSources(payload: unknown): { results: Record<string, unknown>[]; content?: string } {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw invalid('上游搜索响应格式无效', 'RESULT_INVALID')
  const content = typeof payload.content === 'string' ? payload.content : undefined
  const results = payload.results.map(item => {
    if (!isRecord(item)) throw invalid('上游搜索来源格式无效', 'RESULT_INVALID')
    return item
  })
  return { results, content }
}

export function normalizeFetchContent(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.content !== 'string') throw invalid('上游抓取响应格式无效', 'RESULT_INVALID')
  return payload.content
}
