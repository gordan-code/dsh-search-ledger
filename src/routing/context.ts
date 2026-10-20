import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { RequestSource } from '../contracts.ts'
// 同步捕获发起会话，不使用全局活动面板或默认模型作为请求身份。
export function requestSource(ctx: Context, profileId: string): RequestSource {
  const session = ctx.get('agents')?.currentInitiator()?.session
  const request = session?.requestContext()
  return { profileId, ...(session ? { sessionId: String(session.id) } : {}), ...(request ? { sourceProviderId: request.provider, sourceModel: request.model } : {}) }
}
