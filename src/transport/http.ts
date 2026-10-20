/** 受控 JSON HTTP 传输；不记录 URL、请求体或凭证。 */

export const HTTP_TIMEOUT_MS = 30_000
export const HTTP_MAX_BODY_BYTES = 2 * 1024 * 1024

export type HttpTransportCode = 'TIMEOUT' | 'CANCELLED' | 'RESPONSE_TOO_LARGE' | 'STREAM_UNKNOWN' | 'NETWORK_UNKNOWN'

export class HttpTransportError extends Error {
  constructor(public readonly code: HttpTransportCode, message: string, public readonly status?: number) {
    super(message)
    this.name = 'HttpTransportError'
  }
}

export interface HttpResponseText {
  readonly status: number
  readonly body: string
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length')
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

async function readBody(response: Response): Promise<string> {
  const length = contentLength(response)
  if (length !== undefined && length > HTTP_MAX_BODY_BYTES) throw new HttpTransportError('RESPONSE_TOO_LARGE', '上游响应超过大小限制')

  try {
    if (response.body === null) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        const chunk = item.value
        total += chunk.byteLength
        if (total > HTTP_MAX_BODY_BYTES) {
          try { await reader.cancel() } catch { /* 忽略取消失败，保留大小错误。 */ }
          throw new HttpTransportError('RESPONSE_TOO_LARGE', '上游响应超过大小限制')
        }
        chunks.push(chunk)
      }
    } finally {
      try { reader.releaseLock() } catch { /* 兼容非标准测试 Response。 */ }
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(bytes)
  } catch (error) {
    if (error instanceof HttpTransportError) throw error
    throw new HttpTransportError('STREAM_UNKNOWN', '上游响应读取中断')
  }
}

/**
 * 发出一次且仅一次请求。超时、取消、重定向拒绝、读取中断均由调用方记为 unknown。
 */
export async function requestText(fetchImpl: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<HttpResponseText> {
  if (signal?.aborted) throw new HttpTransportError('CANCELLED', '请求已取消')
  const controller = new AbortController()
  let timeout = false
  let responseStatus: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  let abortReject: ((reason?: unknown) => void) | undefined
  const abortPromise = signal === undefined ? undefined : new Promise<never>((_, reject) => { abortReject = reject })

  if (signal !== undefined) {
    const onAbort = () => {
      controller.abort()
      abortReject?.(new HttpTransportError('CANCELLED', '请求已取消', responseStatus))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbort = () => signal.removeEventListener('abort', onAbort)
  }
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeout = true
      controller.abort()
      reject(new HttpTransportError('TIMEOUT', '上游请求超时', responseStatus))
    }, HTTP_TIMEOUT_MS)
  })
  const requestPromise = (async () => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' })
    responseStatus = response.status
    try {
      return { status: response.status, body: await readBody(response) }
    } catch (error) {
      if (error instanceof HttpTransportError) throw new HttpTransportError(error.code, error.message, response.status)
      throw error
    }
  })()

  try {
    const result = await Promise.race(abortPromise === undefined ? [requestPromise, timeoutPromise] : [requestPromise, timeoutPromise, abortPromise])
    return result as HttpResponseText
  } catch (error) {
    if (error instanceof HttpTransportError) throw error
    if (timeout) throw new HttpTransportError('TIMEOUT', '上游请求超时', responseStatus)
    if (signal?.aborted) throw new HttpTransportError('CANCELLED', '请求已取消', responseStatus)
    throw new HttpTransportError('NETWORK_UNKNOWN', '上游网络请求失败')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbort?.()
    // 防止一个晚到的 fetch rejection 形成未处理 Promise；不改变本次结果。
    void requestPromise.catch(() => undefined)
  }
}
