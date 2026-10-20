import { describe, expect, it, vi } from 'vitest'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ChannelCredentials } from '../../src/host/channel-credentials.ts'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'

function setup(profileId = 'test') {
  const channels = structuredClone(DEFAULT_CONFIG.channels)
  const records = new Map<string, CredentialRecord>()
  const credentials = {
    describe: vi.fn(async () => ({ configured: false, writable: true })), resolve: vi.fn(async () => undefined as { value: string; source: string } | undefined),
    describeRecord: vi.fn(async () => ({ configured: false, writable: true })),
    readRecord: vi.fn(async (key: string) => records.get(key)),
    modifyRecord: vi.fn(async (key: string, mutate: (old: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const next = await mutate(records.get(key)); if (next) records.set(key, next); return next
    }),
    deleteRecord: vi.fn(async (key: string) => { records.delete(key) }),
  }
  const manager = new ChannelCredentials({ profileId, readChannels: () => channels, credentials })
  return { channels, credentials, manager, records }
}
const id = 'deepseek-official-api', ref = 'DEEPSEEK_API_KEY'
describe('渠道多Key凭证安全边界', () => {
  it('未配置状态不含值，不 resolve 引用', async () => {
    const { manager, credentials } = setup()
    expect(await manager.get(id, ref)).toEqual({ channelId: id, credentialRef: ref, configured: false, writable: true, keyCount: 0, source: 'none' })
    expect(credentials.resolve).not.toHaveBeenCalled()
  })
  it('原子保存去重Key池，只返回数量，不能污染共享模型引用', async () => {
    const { manager, credentials } = setup()
    expect(await manager.set(id, ref, ['synthetic-a', 'synthetic-b', 'synthetic-a'])).toMatchObject({ configured: true, keyCount: 2, source: 'pool' })
    expect(credentials.modifyRecord).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await manager.get(id, ref))).not.toContain('synthetic-')
    expect(credentials.resolve).not.toHaveBeenCalled()
  })
  it('轮换请求起点，当前池每Key一次，预览不移动游标', async () => {
    const { manager, channels } = setup()
    await manager.set(id, ref, ['key-a', 'key-b', 'key-c'])
    expect(await manager.resolve(channels[0]!)).toEqual(['key-a', 'key-b', 'key-c'])
    expect(await manager.resolve(channels[0]!)).toEqual(['key-b', 'key-c', 'key-a'])
    expect(await manager.resolve(channels[0]!, false)).toEqual(['key-a', 'key-b', 'key-c'])
    expect(await manager.resolve(channels[0]!)).toEqual(['key-c', 'key-a', 'key-b'])
  })
  it('移除池后兼容旧引用回退，不删除共享引用', async () => {
    const { manager, credentials, channels } = setup()
    await manager.set(id, ref, ['synthetic-key'])
    credentials.describe.mockResolvedValue({ configured: true, writable: true })
    credentials.resolve.mockResolvedValue({ value: 'fallback-key', source: 'env' })
    expect(await manager.unset(id, ref)).toMatchObject({ keyCount: 1, source: 'reference' })
    expect(await manager.resolve(channels[0]!)).toEqual(['fallback-key'])
  })
  it.each(['missing', 'local-http'])('拒绝不存在或无需凭证的渠道 %s', async channelId => {
    const { manager, credentials } = setup()
    await expect(manager.set(channelId, ref, ['synthetic-key'])).rejects.toThrow()
    expect(credentials.modifyRecord).not.toHaveBeenCalled()
  })
  it('拒绝归档渠道和陈旧引用', async () => {
    const { manager, channels, credentials } = setup()
    await expect(manager.set(id, 'OTHER_KEY', ['synthetic-key'])).rejects.toMatchObject({ code: 'CREDENTIAL_STALE' })
    channels[0]!.archived = true
    await expect(manager.unset(id, ref)).rejects.toThrow()
    expect(credentials.modifyRecord).not.toHaveBeenCalled(); expect(credentials.deleteRecord).not.toHaveBeenCalled()
  })
  it.each([[], [''], ['  '], ['abc\nsecret'], ['x'.repeat(8193)], Array.from({ length: 33 }, (_, i) => `key-${i}`)])('拒绝无效池，错误不回显输入 #%#', async keys => {
    const { manager, credentials } = setup()
    await expect(manager.set(id, ref, keys)).rejects.toMatchObject({ code: 'CREDENTIAL_INPUT_INVALID' })
    expect(credentials.modifyRecord).not.toHaveBeenCalled()
  })
  it('只读拒绝写入', async () => {
    const { manager, credentials } = setup()
    credentials.describeRecord.mockResolvedValue({ configured: false, writable: false })
    await expect(manager.set(id, ref, ['synthetic'])).rejects.toMatchObject({ code: 'CREDENTIAL_READONLY' })
    await expect(manager.unset(id, ref)).rejects.toMatchObject({ code: 'CREDENTIAL_READONLY' })
    expect(credentials.modifyRecord).not.toHaveBeenCalled(); expect(credentials.deleteRecord).not.toHaveBeenCalled()
  })
  it('等待写能力时引用改变不能错绑', async () => {
    const { manager, channels, credentials } = setup()
    credentials.describeRecord.mockImplementation(async () => { channels[0]!.credentialRef = 'CHANGED_KEY'; return { configured: false, writable: true } })
    await expect(manager.set(id, ref, ['synthetic'])).rejects.toMatchObject({ code: 'CREDENTIAL_STALE' })
    expect(credentials.modifyRecord).not.toHaveBeenCalled()
  })
  it('底层读写异常脱敏', async () => {
    const { manager, credentials } = setup()
    credentials.modifyRecord.mockRejectedValue(new Error('synthetic-key C:/private/credentials'))
    await expect(manager.set(id, ref, ['synthetic-key'])).rejects.toMatchObject({ message: '宿主凭据写入失败，请重试；不会显示底层密钥详情' })
    credentials.readRecord.mockRejectedValue(new Error('synthetic-key'))
    await expect(manager.get(id, ref)).rejects.toMatchObject({ message: '无法读取凭证状态，请刷新或检查宿主凭据服务' })
  })
  it('写入成功但重读失败要明确已提交', async () => {
    const { manager, credentials } = setup()
    credentials.readRecord.mockRejectedValue(new Error('private'))
    await expect(manager.set(id, ref, ['synthetic-key'])).rejects.toMatchObject({ code: 'CREDENTIAL_POST_WRITE_UNKNOWN' })
    expect(credentials.modifyRecord).toHaveBeenCalledTimes(1)
  })
  it('同渠道不同profile存储隔离；缺失引用也能建立池', async () => {
    const a = setup('a'), b = setup('b')
    delete a.channels[0]!.credentialRef
    await a.manager.set(id, '', ['synthetic-a']); await b.manager.set(id, ref, ['synthetic-b'])
    expect([...a.records.keys()][0]).not.toBe([...b.records.keys()][0])
  })
  it('坏池与读取失败不能退回共享模型凭证', async () => {
    const { manager, credentials, channels, records } = setup()
    await manager.set(id, ref, ['synthetic'])
    const key = [...records.keys()][0]!
    for (const record of [{ kind: 'grant', payload: { version: 1, keys: [] } }, { kind: 'grant', payload: { version: 9, keys: ['secret'] } }]) {
      records.set(key, record as CredentialRecord)
      await expect(manager.resolve(channels[0]!)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    }
    expect(credentials.resolve).not.toHaveBeenCalled()
  })
  it('Key池优先于兼容引用，并发轮换无重复起点', async () => {
    const { manager, credentials, channels } = setup()
    await manager.set(id, ref, ['key-a', 'key-b', 'key-c'])
    const resolved = await Promise.all([manager.resolve(channels[0]!), manager.resolve(channels[0]!), manager.resolve(channels[0]!)])
    expect(resolved.map(keys => keys[0])).toEqual(['key-a', 'key-b', 'key-c'])
    expect(credentials.resolve).not.toHaveBeenCalled()
    channels[0]!.credentialRef = 'NEW_REF'
    expect(await manager.resolve(channels[0]!, false)).toEqual(['key-a', 'key-b', 'key-c'])
  })
})
