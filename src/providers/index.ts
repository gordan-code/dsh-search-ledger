export { DeepSeekAdapter, DeepSeekProvider } from './deepseek.ts'
export { SearXNGAdapter, SearXNGProvider } from './searxng.ts'
export { TavilyAdapter, TavilyProvider } from './tavily.ts'
export { LocalHttpAdapter, LocalHttpProvider } from './local-http.ts'
export { TinyFishAdapter, TinyFishProvider } from './tinyfish.ts'
export { QianfanAdapter, QianfanProvider } from './qianfan.ts'
import type { Channel } from '../contracts.ts'
import { invalid } from './common.ts'
import { DeepSeekAdapter } from './deepseek.ts'
import { SearXNGAdapter } from './searxng.ts'
import { TavilyAdapter } from './tavily.ts'
import { LocalHttpAdapter } from './local-http.ts'
import { TinyFishAdapter } from './tinyfish.ts'
import { QianfanAdapter } from './qianfan.ts'
export type { RawResponse } from './common.ts'
export { endpointFor, requiresCredential } from './common.ts'

export type ProviderAdapter = DeepSeekAdapter | SearXNGAdapter | TavilyAdapter | LocalHttpAdapter | TinyFishAdapter | QianfanAdapter

/** 统一provider factory；只接收已通过配置校验的Channel。 */
export function adapterFor(channel: Channel, httpFetch?: typeof fetch): ProviderAdapter {
  if (channel.kind === 'local-http') return new LocalHttpAdapter()
  if (httpFetch === undefined) throw invalid('HTTP 请求能力不可用', 'HTTP_UNAVAILABLE')
  if (channel.kind === 'deepseek-api') return new DeepSeekAdapter(httpFetch)
  if (channel.kind === 'searxng') return new SearXNGAdapter(httpFetch)
  if (channel.kind === 'tavily') return new TavilyAdapter(httpFetch)
  if (channel.kind === 'tinyfish') return new TinyFishAdapter(httpFetch)
  if (channel.kind === 'qianfan') return new QianfanAdapter(httpFetch)
  throw invalid('渠道类型不支持', 'CHANNEL_KIND_INVALID')
}
