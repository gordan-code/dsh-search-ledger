import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import type { RouteSnapshot } from '../contracts.ts'
import { normalizeFetchContent, type FetchAdapter, type RawResponse } from './common.ts'

type FetchRequest = { url: string }

/** 本地匿名抓取适配器，直接组合官方公共地址/SSRF 防护实现。 */
export class LocalHttpAdapter implements FetchAdapter {
  private readonly provider = new HttpFetchProvider({
    maxResponseBytes: 2 * 1024 * 1024,
    maxBodyChars: 2 * 1024 * 1024,
    timeoutMs: 30_000,
    maxRedirects: 0,
    userAgent: 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)',
  })

  async fetch(request: FetchRequest, _route: RouteSnapshot, _credential: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    const result = await this.provider.fetch(request, signal)
    return {
      status: result.statusCode,
      payload: { content: result.body.content, kind: result.body.kind, url: result.url, truncated: result.truncated },
    }
  }

  normalizeFetch(payload: unknown, request: FetchRequest, status: number): WebFetchResult {
    const content = normalizeFetchContent(payload)
    const bodyKind = typeof payload === 'object' && payload !== null && (payload as { kind?: unknown }).kind === 'html' ? 'html' : 'text'
    const finalUrl = typeof payload === 'object' && payload !== null && typeof (payload as { url?: unknown }).url === 'string' ? (payload as { url: string }).url : request.url
    const truncated = typeof payload === 'object' && payload !== null && typeof (payload as { truncated?: unknown }).truncated === 'boolean'
      ? (payload as { truncated: boolean }).truncated
      : false
    return { url: finalUrl, statusCode: status, body: { kind: bodyKind, content }, truncated }
  }
}

export { LocalHttpAdapter as LocalHttpProvider }
