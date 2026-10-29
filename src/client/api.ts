// 浏览器只依赖脱敏协议，不引入任何Host服务或Node模块。
import type { AttemptFilter, AttemptPage, BreakerView, BudgetState, CandidateState, ChannelState, ChannelCredentialState, ExportFormat, KeyTestBatch, LedgerExport, Operation, PluginStatus, ProviderView, SessionOverrides, SummaryRow } from '../contracts.ts'
export interface BillingApi {
  getStatus(): Promise<PluginStatus>; listProviders(): Promise<ProviderView[]>
  listChannelStates(): Promise<ChannelState[]>
  /** 0.6.0 新增；旧宿主可暂不提供，面板据此隐藏相关卡片。 */
  listBreakerStates?(): Promise<BreakerView[]>
  resetBreaker?(channelId: string): Promise<BreakerView[]>
  getBudgetState?(): Promise<BudgetState>
  exportLedger?(filter: AttemptFilter, format: ExportFormat): Promise<LedgerExport>
  getChannelCredential?(channelId: string, expectedCredentialRef: string): Promise<ChannelCredentialState>
  setChannelCredential?(channelId: string, expectedCredentialRef: string, keys: string[]): Promise<ChannelCredentialState>
  unsetChannelCredential?(channelId: string, expectedCredentialRef: string): Promise<ChannelCredentialState>
  testChannelKeys?(channelId: string, expectedCredentialRef: string, operation: Operation, keys: string[] | null, expectedKeyCount: number, expectedChannelSignature: string): Promise<KeyTestBatch>
  /** 仅读取候选渠道与脱敏就绪原因；旧宿主可暂不提供此方法。 */
  getCandidateStates?(operation: Operation, providerId: string | null, sessionId: string | null): Promise<CandidateState[]>
  deleteChannel(channelId: string, expectedRevision: number): Promise<number>
  getSummary(filter: AttemptFilter): Promise<SummaryRow[]>
  listAttempts(filter: AttemptFilter, cursor: string | null, limit: number): Promise<AttemptPage>
  getSessionOverride(sessionId: string): Promise<SessionOverrides>
  setSessionOverride(sessionId: string, operation: Operation, channelId: string | null, expectedRevision: number): Promise<SessionOverrides>
}
export function amount(value: string): string {
  const n = BigInt(value); const sign = n < 0n ? '-' : ''; const abs = n < 0n ? -n : n
  return `${sign}${abs / 1000000n}.${(abs % 1000000n).toString().padStart(6, '0')}`
}
