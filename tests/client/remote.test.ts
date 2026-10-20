// 生成的Remote返回Result封套，界面必须先解包才能使用领域数据。
import { it, expect, vi } from 'vitest'
import { billingApi, unwrap } from '../../src/client/remote.ts'
it('正确解包成功值并拒绝失败Result', () => {
  expect(unwrap({ ok: true, value: { active: true } })).toEqual({ active: true })
  expect(() => unwrap({ ok: false, error: { code: 'denied', message: '拒绝访问', details: {} } })).toThrow('拒绝访问')
})

it('候选状态RPC透传操作、Provider和会话参数并解包', async () => {
  const remote = {
    getCandidateStates: vi.fn(async () => ({ ok: true, value: [{ channelId: 'c', capabilities: ['search'], credentialReady: false, reason: '未配置凭证' }] })),
  } as never
  const api = billingApi(remote)
  await expect(api.getCandidateStates?.('search', null, null)).resolves.toEqual([{ channelId: 'c', capabilities: ['search'], credentialReady: false, reason: '未配置凭证' }])
  expect((remote as any).getCandidateStates).toHaveBeenCalledWith('search', null, null)
})
it('Key管理RPC只解包状态，写入参数不混入配置', async () => {
  const state = { channelId: 'c', credentialRef: '', configured: true, writable: true, keyCount: 2, source: 'pool' }
  const remote = { getChannelCredential: vi.fn(async () => ({ ok: true, value: state })), setChannelCredential: vi.fn(async () => ({ ok: true, value: state })), unsetChannelCredential: vi.fn(async () => ({ ok: true, value: state })) }
  const api = billingApi(remote as never)
  expect(await api.getChannelCredential!('c', '')).toEqual(state)
  expect(await api.setChannelCredential!('c', '', ['synthetic-a', 'synthetic-b'])).toEqual(state)
  expect(await api.unsetChannelCredential!('c', '')).toEqual(state)
  expect(remote.setChannelCredential).toHaveBeenCalledWith('c', '', ['synthetic-a', 'synthetic-b'])
})
