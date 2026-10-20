import { expect, it, vi } from 'vitest'
import { ChannelManagement } from '../../src/host/channel-management.ts'
import { DEFAULT_CONFIG, parseRoutingConfig } from '../../src/config-schema.ts'
import { BillingDatabase } from '../../src/storage/database.ts'

function fixture(options: { used?: boolean; sessions?: number; conflict?: boolean } = {}) {
  let config = structuredClone(DEFAULT_CONFIG)
  const save = vi.fn(async (channels, revision) => {
    if (options.conflict) throw new Error('revision 冲突')
    expect(revision).toBe(7)
    config = { ...config, channels }
    return 8
  })
  const manager = new ChannelManagement({ readConfig: () => config, isUsed: () => !!options.used, sessionReferenceCount: () => options.sessions ?? 0, saveChannels: save })
  return { manager, save, getConfig: () => config, setConfig: next => { config = next } }
}
it('未使用未绑定渠道可删除，归档保留身份和其他配置', async () => {
  const { manager, save, getConfig } = fixture()
  expect(manager.list()[0]).toMatchObject({ used: false, canDelete: true })
  expect(await manager.deleteChannel('deepseek-official-api', 7)).toBe(8)
  expect(save).toHaveBeenCalledTimes(1)
  expect(getConfig().channels[0]).toMatchObject({ id: 'deepseek-official-api', archived: true, enabled: false })
  expect(getConfig().channels[1]).toEqual(DEFAULT_CONFIG.channels[1])
  expect(() => manager.assertDispatch('deepseek-official-api')).toThrow(/已删除/)
})
it('归档配置不能启用，账本/会话引用查询按profile隔离且不清除历史', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.channels[0]!.archived = true
  expect(() => parseRoutingConfig(config)).toThrow(/已删除渠道/)
  config.channels[0]!.enabled = false
  expect(parseRoutingConfig(config).channels[0]?.archived).toBe(true)
  const db = new BillingDatabase(':memory:')
  db.prepare({ attemptId: 'a', operationId: 'o', ownerToken: 'owner', operation: 'search', profileId: 'p', channelId: 'deepseek-official-api', channelName: '原名称', channelKind: 'deepseek-api', endpointOrigin: 'https://api.deepseek.com', price: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' }, configRevision: 'r', startedAt: new Date().toISOString() })
  expect(db.hasChannelAttempts('p', 'deepseek-official-api')).toBe(true)
  expect(db.hasChannelAttempts('other', 'deepseek-official-api')).toBe(false)
  db.setOverride('p', 's', 'fetch', 'deepseek-official-api', 0)
  expect(db.channelSessionReferences('p', 'deepseek-official-api')).toBe(1)
  expect(db.channelSessionReferences('other', 'deepseek-official-api')).toBe(0)
  expect(db.list('p').items[0]).toMatchObject({ channelName: '原名称', channelId: 'deepseek-official-api' })
  db.close()
})
it('有历史/在途请求的渠道禁止删除，未触碰设置', async () => {
  const { manager, save, getConfig } = fixture({ used: true })
  expect(manager.list()[0]).toMatchObject({ used: true, canDelete: false })
  expect(manager.list()[0]!.reason).toContain('仍可正常使用')
  expect(getConfig().channels[0]!.enabled).toBe(true)
  expect(() => manager.assertDispatch('deepseek-official-api')).not.toThrow()
  await expect(manager.deleteChannel('deepseek-official-api', 7)).rejects.toMatchObject({ code: 'CHANNEL_IN_USE' })
  expect(save).not.toHaveBeenCalled()
})
it('Provider、全局或会话引用必须先解绑，不能制造悬空引用', async () => {
  for (const kind of ['provider', 'global', 'session']) {
    const f = fixture({ sessions: kind === 'session' ? 1 : 0 })
    const config = f.getConfig()
    if (kind === 'provider') config.providerBindings.source = { search: 'deepseek-official-api' }
    if (kind === 'global') config.globalOverrides.fetch = 'deepseek-official-api'
    expect(f.manager.list()[0]?.references.length).toBeGreaterThan(0)
    await expect(f.manager.deleteChannel('deepseek-official-api', 7)).rejects.toMatchObject({ code: 'CHANNEL_REFERENCED' })
    expect(f.save).not.toHaveBeenCalled()
  }
})
it('revision冲突可见，不返回伪成功；非法revision拒绝', async () => {
  const { manager } = fixture({ conflict: true })
  await expect(manager.deleteChannel('deepseek-official-api', 7)).rejects.toThrow('revision 冲突')
  expect(() => manager.assertDispatch('deepseek-official-api')).not.toThrow()
  await expect(manager.deleteChannel('deepseek-official-api', -1)).rejects.toMatchObject({ code: 'INPUT_INVALID' })
})
it('删除保存期间阻止陈旧快照派发，失败后释放本地护栏', async () => {
  let reject!: (error: Error) => void
  const pending = new Promise<number>((_resolve, rejecter) => { reject = rejecter })
  const manager = new ChannelManagement({ readConfig: () => DEFAULT_CONFIG, isUsed: () => false, sessionReferenceCount: () => 0, saveChannels: () => pending })
  const deletion = manager.deleteChannel('deepseek-official-api', 7)
  expect(() => manager.assertDispatch('deepseek-official-api')).toThrow(/删除/)
  reject(new Error('保存失败'))
  await expect(deletion).rejects.toThrow('保存失败')
  expect(() => manager.assertDispatch('deepseek-official-api')).not.toThrow()
})
