import { it, expect } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { requestSource } from '../../src/routing/context.ts'
it('读取发起session的实际provider/model，并发上下文不串号，无会话不借用身份', async () => {
  const storage = new AsyncLocalStorage<{ session?: { id: string; requestContext(): { provider: string; model: string } } }>()
  const ctx = { get: (name: string) => name === 'agents' ? { currentInitiator: () => storage.getStore() } : undefined }
  const run = (id: string) => storage.run({ session: { id, requestContext: () => ({ provider: `provider-${id}`, model: `model-${id}` }) } }, async () => {
    await new Promise(resolve => setTimeout(resolve, id === 'a' ? 5 : 0))
    return requestSource(ctx as never, 'profile')
  })
  expect(await Promise.all([run('a'), run('b')])).toEqual([
    { profileId: 'profile', sessionId: 'a', sourceProviderId: 'provider-a', sourceModel: 'model-a' },
    { profileId: 'profile', sessionId: 'b', sourceProviderId: 'provider-b', sourceModel: 'model-b' },
  ])
  expect(requestSource(ctx as never, 'profile')).toEqual({ profileId: 'profile' })
})
