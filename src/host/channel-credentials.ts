// Key池由宿主凭据服务持久化，插件配置、日志和账本中不保存Key。
import { createHash } from 'node:crypto'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { BillingError } from '../contracts.ts'
import type { Channel, ChannelCredentialState } from '../contracts.ts'
import { requiresCredential } from '../channel-kinds.ts'

interface Deps {
  profileId: string
  readChannels(): Channel[]
  credentials: Pick<CredentialProvider, 'describe' | 'resolve' | 'readRecord' | 'describeRecord' | 'modifyRecord' | 'deleteRecord'>
}
function validKeys(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every(key => typeof key === 'string' && key.length > 0 && key.length <= 8192 && !/[\s\x00-\x1f\x7f]/u.test(key))
}
function pool(record: CredentialRecord | undefined): string[] | undefined {
  if (!record) return undefined
  const payload = record.kind === 'grant' ? record.payload as { version?: unknown; keys?: unknown } | null : null
  if (!payload || payload.version !== 1 || !validKeys(payload.keys)) throw new BillingError('CREDENTIAL_INVALID', '渠道Key池格式无效，请重新设置')
  return [...new Set(payload.keys)]
}
export class ChannelCredentials {
  private readonly cursors = new Map<string, number>()
  constructor(private readonly deps: Deps) {}
  private key(channelId: string) {
    const id = createHash('sha256').update(JSON.stringify([this.deps.profileId, channelId])).digest('hex')
    return credentialKey('dsh-search-ledger', `channel-${id}`)
  }
  private channel(id: string, expectedRef: string): Channel {
    let channels: Channel[]
    try { channels = this.deps.readChannels() } catch { throw new BillingError('CONFIG_INVALID', '渠道配置不可读取，请重新打开面板') }
    const channel = channels.find(item => item.id === id && !item.archived)
    if (!channel || !requiresCredential(channel)) throw new BillingError('CHANNEL_UNAVAILABLE', '渠道不存在、已归档或无需API Key')
    if (typeof expectedRef !== 'string' || expectedRef !== (channel.credentialRef ?? '')) throw new BillingError('CREDENTIAL_STALE', '渠道凭证引用已改变，请保存配置并刷新状态')
    return channel
  }
  async get(id: string, expectedRef: string): Promise<ChannelCredentialState> {
    this.channel(id, expectedRef)
    try {
      const info = await this.deps.credentials.describeRecord(this.key(id))
      const keys = pool(await this.deps.credentials.readRecord(this.key(id)))
      const legacy = keys ? false : expectedRef ? (await this.deps.credentials.describe(credentialRef(expectedRef))).configured : false
      this.channel(id, expectedRef)
      return { channelId: id, credentialRef: expectedRef, configured: !!keys || legacy, writable: info.writable === true, keyCount: keys?.length ?? (legacy ? 1 : 0), source: keys ? 'pool' : legacy ? 'reference' : 'none' }
    } catch (error) {
      if (error instanceof BillingError && error.code === 'CREDENTIAL_STALE') throw error
      throw new BillingError('CREDENTIAL_STATUS_UNAVAILABLE', '无法读取凭证状态，请刷新或检查宿主凭据服务')
    }
  }
  private async writable(id: string, expectedRef: string) {
    this.channel(id, expectedRef)
    let writable: boolean
    try { writable = (await this.deps.credentials.describeRecord(this.key(id))).writable } catch { throw new BillingError('CREDENTIAL_STATUS_UNAVAILABLE', '无法读取凭证状态，请刷新或检查宿主凭据服务') }
    this.channel(id, expectedRef)
    if (!writable) throw new BillingError('CREDENTIAL_READONLY', '宿主凭据存储只读，未修改Key')
  }
  async set(id: string, expectedRef: string, keys: string[]): Promise<ChannelCredentialState> {
    if (!validKeys(keys)) throw new BillingError('CREDENTIAL_INPUT_INVALID', '请填写1–32个API Key；每个不能为空、包含空白或超过8192字符')
    const unique = [...new Set(keys)]
    await this.writable(id, expectedRef)
    try {
      await this.deps.credentials.modifyRecord(this.key(id), async () => {
        this.channel(id, expectedRef)
        return { kind: 'grant', payload: { version: 1, keys: unique } }
      })
    } catch { throw new BillingError('CREDENTIAL_WRITE_FAILED', '宿主凭据写入失败，请重试；不会显示底层密钥详情') }
    this.cursors.delete(id)
    return this.afterWrite(id, expectedRef)
  }
  async unset(id: string, expectedRef: string): Promise<ChannelCredentialState> {
    await this.writable(id, expectedRef)
    this.channel(id, expectedRef)
    try { await this.deps.credentials.deleteRecord(this.key(id)) } catch { throw new BillingError('CREDENTIAL_WRITE_FAILED', '宿主凭据移除失败，请刷新后重试') }
    this.cursors.delete(id)
    return this.afterWrite(id, expectedRef)
  }
  private async afterWrite(id: string, expectedRef: string) {
    try { return await this.get(id, expectedRef) } catch { throw new BillingError('CREDENTIAL_POST_WRITE_UNKNOWN', '凭据操作已提交，但状态读取失败；请刷新确认，不要重复提交') }
  }
  /** 仅派发时移动游标；预览不改变下一次使用顺序。重启后轮换从第一项开始。 */
  async resolve(channel: Channel, rotate = true): Promise<string[]> {
    if (!requiresCredential(channel)) return []
    let keys: string[] | undefined
    try {
      keys = pool(await this.deps.credentials.readRecord(this.key(channel.id)))
      if (!keys && channel.credentialRef) {
        const fallback = (await this.deps.credentials.resolve(credentialRef(channel.credentialRef)))?.value
        if (typeof fallback === 'string' && fallback.trim()) keys = [fallback]
      }
    } catch { throw new BillingError('CREDENTIAL_UNAVAILABLE', '渠道凭证不可用') }
    if (!keys) return []
    if (!rotate) return keys
    const cursor = (this.cursors.get(channel.id) ?? 0) % keys.length
    this.cursors.set(channel.id, (cursor + 1) % keys.length)
    return [...keys.slice(cursor), ...keys.slice(0, cursor)]
  }
}
