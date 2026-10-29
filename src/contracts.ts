// Host与Client之间只传递这些脱敏的JSON契约，不传递宿主对象或凭证。
export type Operation = 'search' | 'fetch'
export type Currency = 'CNY' | 'USD'
export type ChannelKind = 'deepseek-api' | 'searxng' | 'tavily' | 'local-http' | 'tinyfish' | 'qianfan'
export type BillingClass = 'official' | 'relay' | 'free' | 'service'
export type BillingPolicy = 'official-nonempty' | 'http-200' | 'free' | 'provider-success'
export type Outcome = 'billable' | 'empty' | 'failed' | 'unknown'
export interface Price { perThousand: string | null; currency: Currency; policy: BillingPolicy }
export interface Channel {
  id: string; name: string; kind: ChannelKind
  billingClass: BillingClass; enabled: boolean
  /** 删除后的身份记录保留，防止历史归属和陈旧页面复用ID。 */
  archived?: boolean
  endpointBase: string; credentialRef?: string; allowHttp?: boolean
  capabilities: Operation[]; prices: Partial<Record<Operation, Price>>
  monthlyCredits?: number
}
export interface FailoverSettings {
  enabled: boolean
  attemptTimeoutMs: number
  totalTimeoutMs: number
}
/** 熔断只描述判定参数；渠道是否冷却由账本终态与复位标记推导。 */
export interface BreakerSettings {
  enabled: boolean
  failureThreshold: number
  windowMs: number
  cooldownMs: number
}
/** 预算按自然日或自然月统计，币种互不折算。 */
export interface BudgetSettings {
  enabled: boolean
  window: 'day' | 'month'
  /** 未设置的币种不设限额。 */
  limits: Partial<Record<Currency, string>>
  /** 跨币种合计的请求次数上限；null 表示不限。 */
  requests: number | null
  onExceed: 'warn' | 'block' | 'fallback'
}
export interface RoutingConfig {
  channels: Channel[]
  providerBindings: Record<string, Partial<Record<Operation, string>>>
  globalOverrides: Partial<Record<Operation, string | null>>
  failover?: Partial<Record<Operation, FailoverSettings>>
  breaker?: BreakerSettings
  budget?: BudgetSettings
}
export interface RequestSource { profileId: string; sessionId?: string; sourceProviderId?: string; sourceModel?: string }
export interface RouteSnapshot extends RequestSource {
  operation: Operation; channel: Channel; price: Price; configRevision: string
  routeSource: 'session' | 'global' | 'binding' | 'ordered'
}
export type BillingEvidenceState = 'success' | 'empty' | 'failed' | 'unknown'
export interface BillingEvidence {
  state: BillingEvidenceState
  resultCount?: number
  hasContent?: boolean
}
export interface Evidence { status?: number; payload?: unknown; transportUnknown?: boolean; billingEvidence?: BillingEvidence }
export interface Decision { outcome: Outcome; resultCount?: number; hasContent?: boolean }
export interface AttemptStart extends RequestSource {
  attemptId: string; operationId: string; ownerToken: string; operation: Operation
  channelId: string; channelName: string; channelKind: Channel['kind']; endpointOrigin: string
  price: Price; configRevision: string; startedAt: string
  quota?: { subject: string; window: string; limit: number; credits: number }
}
export interface AttemptResult {
  outcome: Outcome; status?: number; resultCount?: number; hasContent?: boolean; errorCode?: string; completedAt: string
}
export interface AttemptView {
  attemptId: string; operationId?: string; profileId: string; sessionId: string | null; sourceProviderId: string | null
  channelId: string; channelName: string; operation: Operation; outcome: string
  startedAt: string; completedAt: string | null; status: number | null
  currency: Currency; amountMicros: string | null; pricePerThousand: string | null; quotaCredits: number
}
export interface AttemptFilter {
  from?: string; to?: string; channelId?: string; sourceProviderId?: string; sessionId?: string; currency?: Currency
}
export interface SummaryRow {
  channelId: string; channelName: string; currency: Currency; operation: Operation
  total: number; billable: number; empty: number; failed: number; unknown: number
  priceUnknown: number; amountMicros: string; quotaCredits: number
}
export interface SessionOverrides { revision: number; search: string | null; fetch: string | null }
export interface WebOperationStatus {
  providerId: string | null; metered: boolean
  /** 配置状态不等于调用成功；成功证据仅来自账本。 */
  selectionSource?: 'runtime-entry' | 'settings-only' | 'unknown'
  registered?: boolean | null; available?: boolean | null
}
/** 熔断状态只暴露判定结果，不含查询正文或凭证。 */
export interface BreakerView {
  channelId: string
  channelName: string
  open: boolean
  failures: number
  threshold: number
  /** 冷却结束时间；仅 open 时有值。 */
  cooldownUntil: string | null
  lastFailureAt: string | null
  resetAt: string | null
}
/** 预算用量与上限；amountMicros 为字符串微单位，避免浮点误差。 */
export interface BudgetUsage {
  currency: Currency
  amountMicros: string
  limit: string | null
  exceeded: boolean
}
export interface BudgetState {
  enabled: boolean
  window: 'day' | 'month'
  windowFrom: string
  windowTo: string
  onExceed: 'warn' | 'block' | 'fallback'
  requests: number
  requestLimit: number | null
  currencies: BudgetUsage[]
  exceeded: boolean
}
export type ExportFormat = 'csv' | 'json'
/** 导出只含脱敏账本字段；不含查询正文、正文内容、凭证或会话ID。 */
export interface LedgerExport {
  filename: string
  mimeType: string
  content: string
  rowCount: number
  truncated: boolean
}
export interface RouteStatus { channelId: string | null; source: 'global' | 'binding' | 'none' | 'ordered'; ready: boolean; reason: string | null }
export interface CandidateState { channelId: string; capabilities: Operation[]; credentialReady: boolean; reason: string | null }
export interface ProviderRouteView { providerId: string; search: RouteStatus; fetch: RouteStatus }
export interface ChannelState { id: string; used: boolean; canDelete: boolean; reason: string | null; references: string[] }
/** 管理界面只能读取存在性与数量，绝不返回已有Key。 */
export interface ChannelCredentialState {
  channelId: string; credentialRef: string; configured: boolean; writable: boolean
  keyCount: number; source: 'pool' | 'reference' | 'none'
}
export type KeyTestState = 'success' | 'auth-rejected' | 'limited' | 'timeout' | 'failed' | 'unknown' | 'not-tested'
export interface KeyTestResult { index: number; state: KeyTestState; status: number | null; attemptId: string | null; code: string | null }
export interface KeyTestBatch { operationId: string; channelId: string; operation: Operation; source: 'input' | 'saved'; results: KeyTestResult[] }
export interface PluginStatus {
  version: string; profileId: string; namespace: string; coverage: string; active: boolean; configError: string | null
  operations?: { search: WebOperationStatus; fetch: WebOperationStatus }
  routes?: ProviderRouteView[]; issues?: string[]; totalAttempts?: number; lastAttemptAt?: string | null
}
export interface ProviderView { id: string; name: string }
export interface AttemptPage { items: AttemptView[]; nextCursor: string | null }
export class BillingError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'BillingError' }
}
