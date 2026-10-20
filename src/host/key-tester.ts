// 真实Key测试复用计量接缝；结果仅序号/状态，绝不返回Key或上游内容。
import { randomUUID } from 'node:crypto'
import { BillingError } from '../contracts.ts'
import type { Channel, KeyTestBatch, KeyTestResult, Operation, RoutingConfig } from '../contracts.ts'
import type { MeteredWeb } from '../accounting/meter.ts'
import type { BillingDatabase } from '../storage/database.ts'
import { abortable, OperationBudget } from '../accounting/failover.ts'
import { resolveRoute } from '../routing/resolver.ts'
import { requiresCredential } from '../channel-kinds.ts'
import { channelTestSignature } from '../channel-test.ts'

interface Deps { db: BillingDatabase; web: MeteredWeb; profileId: string; readConfig(): RoutingConfig; resolveKeys(channel: Channel): Promise<string[]> }
const retryable = new Set(['UPSTREAM_FAILED', 'UPSTREAM_UNKNOWN', 'RESULT_INVALID', 'ATTEMPT_TIMEOUT', 'QUOTA_LOCAL_LIMIT'])
const safeCodes = new Set([...retryable, 'CANCELLED', 'TOTAL_TIMEOUT', 'DB_PREPARE_FAILED', 'DB_DISPATCH_FAILED', 'DB_FINISH_FAILED', 'DB_CANCEL_FAILED', 'DB_READ_FAILED', 'ATTEMPT_EXISTS', 'ATTEMPT_DISPATCH_FAILED', 'CHANNEL_IDENTITY_INVALID', 'KEY_TEST_CONFIG_CHANGED', 'CONFIG_INVALID', 'QUOTA_CONFIG_CONFLICT', 'QUOTA_INVALID', 'ENDPOINT_INVALID', 'HTTP_UNAVAILABLE', 'INTERNAL_ERROR'])
function validKeys(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(key => typeof key === 'string' && key.length > 0 && key.length <= 8192 && !/[\s\x00-\x1f\x7f]/u.test(key))
}
export class KeyTester {
  private running = false
  private readonly lifetime = new AbortController()
  constructor(private readonly deps: Deps) {}
  close() { this.lifetime.abort() }
  private channel(id: string, ref: string, operation: Operation): Channel {
    let config: RoutingConfig
    try { config = this.deps.readConfig() } catch { throw new BillingError('CONFIG_INVALID', '渠道配置不可读取') }
    const channel = config.channels.find(item => item.id === id && !item.archived)
    if (!channel || !requiresCredential(channel) || !channel.capabilities.includes(operation) || !channel.prices[operation]) throw new BillingError('CHANNEL_UNAVAILABLE', '该渠道不存在、已归档或不支持该测试操作')
    if (typeof ref !== 'string' || ref !== (channel.credentialRef ?? '')) throw new BillingError('CREDENTIAL_STALE', '渠道引用已改变，请保存并刷新')
    return channel
  }
  async test(id: string, ref: string, operation: Operation, input: string[] | null, expectedCount: number, signal?: AbortSignal, expectedSignature?: string): Promise<KeyTestBatch> {
    if (this.lifetime.signal.aborted) throw new BillingError('KEY_TEST_CLOSED', '插件已卸载，不能测试')
    if (this.running) throw new BillingError('KEY_TEST_BUSY', '已有Key测试正在进行，请勿重复提交')
    if (!['search', 'fetch'].includes(operation) || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 32 || (input !== null && !validKeys(input))) throw new BillingError('CREDENTIAL_INPUT_INVALID', '测试参数或Key格式无效')
    const snapshot = structuredClone(this.channel(id, ref, operation))
    if (expectedSignature !== undefined && channelTestSignature(snapshot, operation) !== expectedSignature) throw new BillingError('KEY_TEST_CONFIG_CHANGED', '渠道地址、价格或能力已改变，请刷新后重新确认测试')
    const original = JSON.stringify(snapshot)
    const unchanged = () => {
      try { if (JSON.stringify(this.channel(id, ref, operation)) === original) return } catch { /* 陈旧/归档也归为配置变化，不泄漏底层异常。 */ }
      throw new BillingError('KEY_TEST_CONFIG_CHANGED', '渠道配置已改变，停止剩余测试')
    }
    const budget = new OperationBudget(60_000, AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]))
    this.running = true
    try {
      let keys: string[]
      if (input !== null) keys = [...new Set(input)]
      else {
        try { keys = await abortable(this.deps.resolveKeys(snapshot), budget.controller.signal) }
        catch { budget.check(); throw new BillingError('CREDENTIAL_UNAVAILABLE', '无法读取已保存的Key池') }
      }
      budget.check(); unchanged()
      if (!validKeys(keys)) throw new BillingError('CREDENTIAL_UNAVAILABLE', '没有可测试的有效Key池')
      keys = [...new Set(keys)]
      if (keys.length !== expectedCount) throw new BillingError('KEY_POOL_CHANGED', 'Key数量与确认时不一致，请刷新后再测试')
      // 明确的手动测试可检测停用渠道，但不改变原配置或聊天Provider来源。
      const config: RoutingConfig = { channels: [{ ...snapshot, enabled: true }], providerBindings: {}, globalOverrides: { [operation]: id } }
      const route = resolveRoute(config, { profileId: this.deps.profileId }, operation)
      const operationId = randomUUID()
      const results: KeyTestResult[] = []
      let stopped: string | null = null
      for (let index = 0; index < keys.length; index++) {
        const attemptId = randomUUID()
        if (!stopped) {
          try { budget.check(); unchanged() }
          catch (error) { stopped = this.code(error) }
        }
        if (stopped) { results.push({ index: index + 1, state: 'not-tested', status: null, attemptId: null, code: stopped }); continue }
        let code: string | null = null
        try { await budget.attempt(10_000, (child, check) => this.deps.web.probe(route, keys[index]!, operationId, attemptId, child, () => { check(); unchanged() })) }
        catch (error) { code = this.code(error); if (!retryable.has(code)) stopped = code }
        let row
        try { row = this.deps.db.getAttempt(this.deps.profileId, attemptId) }
        catch { code = stopped = 'DB_READ_FAILED' }
        if (!code && !row) code = stopped = 'DB_READ_FAILED'
        const status = row?.status ?? null
        const state = code === null ? 'success' : code === 'ATTEMPT_TIMEOUT' || code === 'TOTAL_TIMEOUT' ? 'timeout'
          : status === 401 || status === 403 ? 'auth-rejected' : status === 429 || code === 'QUOTA_LOCAL_LIMIT' ? 'limited'
            : code === 'UPSTREAM_FAILED' || code === 'RESULT_INVALID' ? 'failed' : 'unknown'
        results.push({ index: index + 1, state, status, attemptId: row?.attemptId ?? null, code })
      }
      return { operationId, channelId: id, operation, source: input === null ? 'saved' : 'input', results }
    } finally { budget.close(); this.running = false }
  }
  private code(error: unknown): string {
    return error instanceof BillingError && safeCodes.has(error.code) ? error.code : 'INTERNAL_ERROR'
  }
}
