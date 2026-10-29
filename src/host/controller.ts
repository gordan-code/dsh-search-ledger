// 面板仅使用宿主受控Remote；未授权Peer不能读取用量或修改会话覆盖。
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-agent'
import type { RemoteAccessResourceOf } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRemoteService, Remote, RemoteError, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type { AttemptFilter, AttemptPage, BreakerView, BudgetState, CandidateState, ChannelState, ChannelCredentialState, ExportFormat, KeyTestBatch, LedgerExport, Operation, PluginStatus, ProviderView, SessionOverrides, SummaryRow } from '../contracts.ts'
export interface ControllerBackend {
  getStatus(): PluginStatus; listProviders(): ProviderView[]; getSummary(filter: AttemptFilter): SummaryRow[]
  listAttempts(filter: AttemptFilter, cursor: string | null, limit: number): AttemptPage
  getSessionOverride(sessionId: string): SessionOverrides
  setSessionOverride(sessionId: string, operation: Operation, channelId: string | null, expectedRevision: number): SessionOverrides
  listChannelStates(): ChannelState[]
  deleteChannel(channelId: string, expectedRevision: number): Promise<number>
  getCandidateStates(operation: Operation, providerId: string | null, sessionId: string | null): Promise<CandidateState[]>
  getChannelCredential(channelId: string, expectedCredentialRef: string): Promise<ChannelCredentialState>
  setChannelCredential(channelId: string, expectedCredentialRef: string, keys: string[]): Promise<ChannelCredentialState>
  unsetChannelCredential(channelId: string, expectedCredentialRef: string): Promise<ChannelCredentialState>
  testChannelKeys(channelId: string, expectedCredentialRef: string, operation: Operation, keys: string[] | null, expectedKeyCount: number, expectedChannelSignature: string, signal?: AbortSignal): Promise<KeyTestBatch>
  listBreakerStates(): BreakerView[]
  resetBreaker(channelId: string): BreakerView[]
  getBudgetState(): BudgetState
  exportLedger(filter: AttemptFilter, format: ExportFormat): LedgerExport
}
declare module '@deepseek-ai/cordis' { interface Context { searchLedger: BillingController } }
export class BillingController extends TypertRemoteService {
  constructor(ctx: Context, private readonly backend: ControllerBackend) { super(ctx, 'searchLedger') }
  private owner(): void { if (principalOf(this.ctx.invocation) !== undefined) throw new RemoteError('remote-access/denied', '仅宿主所有者可访问搜索计费管理', { action: 'searchLedger', reason: 'owner-only' }) }
  @Remote
  getStatus(): PluginStatus { this.owner(); return this.backend.getStatus() }
  @Remote
  listProviders(): ProviderView[] { this.owner(); return this.backend.listProviders() }
  @Remote
  listChannelStates(): ChannelState[] { this.owner(); return this.backend.listChannelStates() }
  @Remote
  getChannelCredential(channelId: string, expectedCredentialRef: string): Promise<ChannelCredentialState> { this.owner(); return this.backend.getChannelCredential(channelId, expectedCredentialRef) }
  @Remote
  setChannelCredential(channelId: string, expectedCredentialRef: string, keys: string[]): Promise<ChannelCredentialState> { this.owner(); return this.backend.setChannelCredential(channelId, expectedCredentialRef, keys) }
  @Remote
  unsetChannelCredential(channelId: string, expectedCredentialRef: string): Promise<ChannelCredentialState> { this.owner(); return this.backend.unsetChannelCredential(channelId, expectedCredentialRef) }
  @Remote
  testChannelKeys(channelId: string, expectedCredentialRef: string, operation: Operation, keys: string[] | null, expectedKeyCount: number, expectedChannelSignature: string): Promise<KeyTestBatch> {
    this.owner()
    return this.backend.testChannelKeys(channelId, expectedCredentialRef, operation, keys, expectedKeyCount, expectedChannelSignature, this.ctx.invocation?.signal)
  }
  @Remote
  getCandidateStates(operation: Operation, providerId: string | null, sessionId: string | null): Promise<CandidateState[]> { this.owner(); return this.backend.getCandidateStates(operation, providerId, sessionId) }
  @Remote
  deleteChannel(channelId: string, expectedRevision: number): Promise<number> { this.owner(); return this.backend.deleteChannel(channelId, expectedRevision) }
  @Remote
  listBreakerStates(): BreakerView[] { this.owner(); return this.backend.listBreakerStates() }
  @Remote
  resetBreaker(channelId: string): BreakerView[] { this.owner(); return this.backend.resetBreaker(channelId) }
  @Remote
  getBudgetState(): BudgetState { this.owner(); return this.backend.getBudgetState() }
  @Remote
  exportLedger(filter: AttemptFilter, format: ExportFormat): LedgerExport { this.owner(); return this.backend.exportLedger(filter, format) }
  @Remote
  getSummary(filter: AttemptFilter): SummaryRow[] { this.owner(); return this.backend.getSummary(filter) }
  @Remote
  listAttempts(filter: AttemptFilter, cursor: string | null, limit: number): AttemptPage { this.owner(); return this.backend.listAttempts(filter, cursor, limit) }
  @Remote({ resources: { session: (sessionId: string) => sessionId as RemoteAccessResourceOf<'session'>['id'] } })
  getSessionOverride(sessionId: string): SessionOverrides { this.owner(); return this.backend.getSessionOverride(sessionId) }
  @Remote({ resources: { session: (sessionId: string) => sessionId as RemoteAccessResourceOf<'session'>['id'] } })
  setSessionOverride(sessionId: string, operation: Operation, channelId: string | null, expectedRevision: number): SessionOverrides { this.owner(); return this.backend.setSessionOverride(sessionId, operation, channelId, expectedRevision) }
}
