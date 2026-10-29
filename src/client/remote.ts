// 单一位置解包宿主的RemoteResult；失败值不能被当成空账本或零费用。
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../../lib/typert.remote-client.js'
import type { Context } from '@deepseek-ai/cordis'
import type { BillingApi } from './api.ts'
export function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
export function billingApi(remote: Context['remote']['searchLedger']): BillingApi {
  const getCandidateStates = typeof remote.getCandidateStates === 'function'
    ? async (operation: Parameters<NonNullable<BillingApi['getCandidateStates']>>[0], providerId: string | null, sessionId: string | null) => unwrap(await remote.getCandidateStates(operation, providerId, sessionId))
    : undefined
  return {
    getStatus: async () => unwrap(await remote.getStatus()),
    listProviders: async () => unwrap(await remote.listProviders()),
    listChannelStates: async () => unwrap(await remote.listChannelStates()),
    ...(typeof remote.getChannelCredential === 'function' ? {
      getChannelCredential: async (id: string, ref: string) => unwrap(await remote.getChannelCredential(id, ref)),
      setChannelCredential: async (id: string, ref: string, keys: string[]) => unwrap(await remote.setChannelCredential(id, ref, keys)),
      unsetChannelCredential: async (id: string, ref: string) => unwrap(await remote.unsetChannelCredential(id, ref)),
    } : {}),
    ...(typeof remote.testChannelKeys === 'function' ? {
      testChannelKeys: async (id: string, ref: string, operation: 'search' | 'fetch', keys: string[] | null, count: number, signature: string) => unwrap(await remote.testChannelKeys(id, ref, operation, keys, count, signature)),
    } : {}),
    ...(getCandidateStates ? { getCandidateStates } : {}),
    ...(typeof remote.listBreakerStates === 'function' ? {
      listBreakerStates: async () => unwrap(await remote.listBreakerStates()),
      resetBreaker: async (channelId: string) => unwrap(await remote.resetBreaker(channelId)),
    } : {}),
    ...(typeof remote.getBudgetState === 'function' ? { getBudgetState: async () => unwrap(await remote.getBudgetState()) } : {}),
    ...(typeof remote.exportLedger === 'function' ? { exportLedger: async (filter: Parameters<NonNullable<BillingApi['exportLedger']>>[0], format: Parameters<NonNullable<BillingApi['exportLedger']>>[1]) => unwrap(await remote.exportLedger(filter, format)) } : {}),
    deleteChannel: async (id, revision) => unwrap(await remote.deleteChannel(id, revision)),
    getSummary: async filter => unwrap(await remote.getSummary(filter)),
    listAttempts: async (filter, cursor, limit) => unwrap(await remote.listAttempts(filter, cursor, limit)),
    getSessionOverride: async sessionId => unwrap(await remote.getSessionOverride(sessionId)),
    setSessionOverride: async (sessionId, operation, id, revision) => unwrap(await remote.setSessionOverride(sessionId, operation, id, revision)),
  }
}
