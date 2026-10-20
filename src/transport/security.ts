/** 不含网络副作用的 URL 安全校验，供渠道和请求边界复用。 */
import { BillingError } from '../contracts.ts'

export function parseSafeEndpoint(input: string, options: { allowHttp?: boolean; origin?: string } = {}): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new BillingError('ENDPOINT_INVALID', '渠道地址无效') }
  if (url.username || url.password || url.search || url.hash) throw new BillingError('ENDPOINT_INVALID', '渠道地址不得内嵌凭证、查询或片段')
  if (url.protocol !== 'https:' && !(options.allowHttp === true && url.protocol === 'http:')) throw new BillingError('ENDPOINT_INVALID', '渠道地址必须使用 HTTPS')
  if (options.origin !== undefined && url.origin !== options.origin) throw new BillingError('ENDPOINT_INVALID', '渠道地址来源不受信任')
  return url
}

export function parseSafeRequestUrl(input: string): URL {
  if (typeof input !== 'string' || input.length === 0 || [...input].length > 8192) throw new BillingError('INVALID_ARGUMENT', '抓取地址无效')
  let url: URL
  try { url = new URL(input) } catch { throw new BillingError('INVALID_ARGUMENT', '抓取地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BillingError('INVALID_ARGUMENT', '抓取地址必须使用 HTTP(S) 且不得内嵌凭证')
  return url
}
