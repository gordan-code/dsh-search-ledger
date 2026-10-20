// 使用实际Typert Registry/Gateway验证生成贡献、严格参数和非owner拒绝。
import { it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { BillingController } from '../../src/host/controller.ts'
import { TYPERT } from '../../lib/typert.host.js'
it('真实Key测试仅owner可触发，数组/null、操作和数量严格校验', async () => {
  const ctx = new Context(); const registry = new TypertRegistry(ctx); new RemoteAccessService(ctx); registry.register(TYPERT)
  const test = vi.fn(async () => ({ operationId: 'batch', channelId: 'c', operation: 'search', source: 'input', results: [] }))
  new BillingController(ctx, { testChannelKeys: test } as never)
  const gateway = new TypertGatewayService(ctx, {})
  const peer = (kind: string) => ({ id: 'p', ctx, principal: { kind }, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} }) as never
  const args = { channelId: 'c', expectedCredentialRef: '', operation: 'search', keys: ['synthetic'], expectedKeyCount: 1, expectedChannelSignature: 'signature' }
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'testChannelKeys', args, peer: peer('guest') })).rejects.toThrow()
  expect(test).not.toHaveBeenCalled()
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'testChannelKeys', args: { ...args, keys: [42] }, peer: peer('owner') })).rejects.toThrow()
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'testChannelKeys', args: { ...args, operation: 'arbitrary' }, peer: peer('owner') })).rejects.toThrow()
  expect(await gateway.invoke({ namespace: 'webSearchBilling', method: 'testChannelKeys', args, peer: peer('owner') })).toMatchObject({ operationId: 'batch' })
  expect(test).toHaveBeenCalledWith('c', '', 'search', ['synthetic'], 1, 'signature', expect.any(AbortSignal))
})
it('Key管理RPC仅owner可访问，严格校验数组，成功结果无Key', async () => {
  const ctx = new Context(); const registry = new TypertRegistry(ctx); new RemoteAccessService(ctx); registry.register(TYPERT)
  const state = { channelId: 'c', credentialRef: '', configured: true, writable: true, keyCount: 2, source: 'pool' }
  const set = vi.fn(async () => state), get = vi.fn(async () => state), unset = vi.fn(async () => state)
  new BillingController(ctx, { getChannelCredential: get, setChannelCredential: set, unsetChannelCredential: unset } as never)
  const gateway = new TypertGatewayService(ctx, {})
  const peer = (kind: string) => ({ id: 'p', ctx, principal: { kind }, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} }) as never
  const args = { channelId: 'c', expectedCredentialRef: '', keys: ['synthetic-a', 'synthetic-b'] }
  for (const method of ['getChannelCredential', 'setChannelCredential', 'unsetChannelCredential']) {
    await expect(gateway.invoke({ namespace: 'webSearchBilling', method, args: method === 'setChannelCredential' ? args : { channelId: 'c', expectedCredentialRef: '' }, peer: peer('guest') })).rejects.toThrow()
  }
  expect(set).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(unset).not.toHaveBeenCalled()
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'setChannelCredential', args: { ...args, keys: [12] }, peer: peer('owner') })).rejects.toThrow()
  expect(set).not.toHaveBeenCalled()
  expect(await gateway.invoke({ namespace: 'webSearchBilling', method: 'setChannelCredential', args, peer: peer('owner') })).toEqual(state)
  expect(set).toHaveBeenCalledWith('c', '', ['synthetic-a', 'synthetic-b'])
})
it('严格贡献可被真实宿主网关调用，缺权限或畸形参数拒绝', async () => {
  const ctx = new Context(); const registry = new TypertRegistry(ctx); new RemoteAccessService(ctx)
  registry.register(TYPERT)
  new BillingController(ctx, { getStatus: () => ({ version: '0.1.0', profileId: 'p', namespace: 'web-search-billing', coverage: 'local', active: true, configError: null }), getSummary: () => [] } as never)
  const gateway = new TypertGatewayService(ctx, {})
  const peer = (kind: string) => ({ id: 'test-peer', ctx, principal: { kind }, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} }) as never
  const status = await gateway.invoke({ namespace: 'webSearchBilling', method: 'getStatus', args: {}, peer: peer('owner') })
  expect(status).toMatchObject({ profileId: 'p' })
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'getStatus', args: {}, peer: peer('guest') })).rejects.toMatchObject({ code: 'remote-access/denied' })
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'getSummary', args: { filter: 'bad' }, peer: peer('owner') })).rejects.toThrow()
})
it('渠道删除和身份查询均由owner-only Remote保护，并严格验证参数', async () => {
  const ctx = new Context(); const registry = new TypertRegistry(ctx); new RemoteAccessService(ctx)
  registry.register(TYPERT)
  const remove = vi.fn(async () => 8)
  new BillingController(ctx, { listChannelStates: () => [], deleteChannel: remove } as never)
  const gateway = new TypertGatewayService(ctx, {})
  const peer = (kind: string) => ({ id: 'test-peer', ctx, principal: { kind }, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} }) as never
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'deleteChannel', args: { channelId: 'channel', expectedRevision: 7 }, peer: peer('guest') })).rejects.toMatchObject({ code: 'remote-access/denied' })
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'listChannelStates', args: {}, peer: peer('guest') })).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(remove).not.toHaveBeenCalled()
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'deleteChannel', args: { channelId: 'channel', expectedRevision: 'bad' }, peer: peer('owner') })).rejects.toThrow()
  expect(await gateway.invoke({ namespace: 'webSearchBilling', method: 'deleteChannel', args: { channelId: 'channel', expectedRevision: 7 }, peer: peer('owner') })).toBe(8)
  expect(remove).toHaveBeenCalledWith('channel', 7)
})

it('候选就绪RPC严格校验并拒绝非owner读取凭证状态', async () => {
  const ctx = new Context(); const registry = new TypertRegistry(ctx); new RemoteAccessService(ctx); registry.register(TYPERT)
  const candidates = vi.fn(async () => [{ channelId: 't', capabilities: ['search'], credentialReady: false, reason: '未配置凭证' }])
  new BillingController(ctx, { getCandidateStates: candidates } as never)
  const gateway = new TypertGatewayService(ctx, {})
  const peer = (kind: string) => ({ id: 'p', ctx, principal: { kind }, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} }) as never
  const args = { operation: 'search', providerId: null, sessionId: null }
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'getCandidateStates', args, peer: peer('guest') })).rejects.toThrow()
  expect(candidates).not.toHaveBeenCalled()
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'getCandidateStates', args: { ...args, operation: 'arbitrary' }, peer: peer('owner') })).rejects.toThrow()
  await expect(gateway.invoke({ namespace: 'webSearchBilling', method: 'getCandidateStates', args, peer: peer('owner') })).resolves.toHaveLength(1)
})
