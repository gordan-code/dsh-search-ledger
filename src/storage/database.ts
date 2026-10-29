import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AttemptFilter,
  AttemptResult,
  AttemptStart,
  AttemptView,
  BillingPolicy,
  Currency,
  Operation,
  SessionOverrides,
  SummaryRow,
} from '../contracts.ts'
import { BillingError } from '../contracts.ts'
import { formatMicros, priceToUnitMicros, SQLITE_MAX_INTEGER } from '../accounting/money.ts'
import type { BreakerObservation } from '../accounting/breaker.ts'
import type { BudgetUsageTotal } from '../accounting/budget.ts'

import { initializeDatabase } from './migrations.ts'
const MAX_LIST_LIMIT = 200
type FinalOutcome = 'billable' | 'empty' | 'failed' | 'unknown'
type StoredOutcome = 'prepared' | 'dispatching' | FinalOutcome

type SqlRow = Record<string, unknown>

interface Cursor {
  startedAt: string
  attemptId: string
}

interface StoredAttempt {
  attempt_id: string
  operation_id: string
  profile_id: string
  session_id: string | null
  source_provider_id: string | null
  source_model: string | null
  owner_token: string
  operation: Operation
  channel_id: string
  channel_name: string
  channel_kind: string
  endpoint_origin: string
  price_per_thousand: string | null
  currency: Currency
  billing_policy: BillingPolicy
  config_revision: string
  started_at: string
  dispatched_at: string | null
  completed_at: string | null
  outcome: StoredOutcome
  transport_status: number | null
  result_count: number | null
  has_content: number | null
  unit_micros: bigint | number | null
  amount_micros: bigint | number | null
  quota_credits: number
  quota_subject: string | null
  quota_window: string | null
  error_code: string | null
}

const ATTEMPT_COLUMNS = `
  attempt_id, operation_id, profile_id, session_id, source_provider_id, source_model,
  owner_token, operation, channel_id, channel_name, channel_kind, endpoint_origin,
  price_per_thousand, currency, billing_policy, config_revision, started_at,
  dispatched_at, completed_at, outcome, transport_status, result_count, has_content,
  unit_micros, amount_micros, quota_credits, quota_subject, quota_window, error_code
`

function sqlIntegerToNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) throw new BillingError('DB_CORRUPT', `${field} 超出安全整数范围`)
  return numeric
}

function rowAsAttempt(row: SqlRow): StoredAttempt {
  return {
    ...(row as unknown as Omit<StoredAttempt, 'transport_status' | 'result_count' | 'has_content' | 'quota_credits'>),
    transport_status: sqlIntegerToNumber(row.transport_status, 'transport_status'),
    result_count: sqlIntegerToNumber(row.result_count, 'result_count'),
    has_content: sqlIntegerToNumber(row.has_content, 'has_content'),
    quota_credits: sqlIntegerToNumber(row.quota_credits, 'quota_credits') ?? 0,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseStartedAt(startedAt: string): Date {
  if (typeof startedAt !== 'string') throw new BillingError('INVALID_ARGUMENT', 'startedAt 必须是 ISO 时间')
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(startedAt)
  if (match === null) throw new BillingError('INVALID_ARGUMENT', 'startedAt 必须是带时区的 ISO 时间')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText)
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText)
  const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3)); const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6))
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) {
    throw new BillingError('INVALID_ARGUMENT', 'startedAt 不是有效的 ISO 时间')
  }
  const parsed = new Date(startedAt)
  if (Number.isNaN(parsed.getTime())) throw new BillingError('INVALID_ARGUMENT', 'startedAt 不是有效的 ISO 时间')
  return parsed
}

function quotaWindowFor(startedAt: Date): string {
  return startedAt.toISOString().slice(0, 7)
}

function normalizeBoolean(value: number | null): boolean | null {
  return value === null ? null : value !== 0
}

function integerValue(value: bigint | number | null): bigint | null {
  if (value === null) return null
  return typeof value === 'bigint' ? value : BigInt(value)
}

function asSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new BillingError('INVALID_ARGUMENT', `${field} 必须是安全整数`)
  return value
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new BillingError('INVALID_ARGUMENT', `${field} 不能为空`)
  return value
}

function isTerminal(outcome: StoredOutcome): outcome is FinalOutcome {
  return outcome !== 'prepared' && outcome !== 'dispatching'
}

function projectedOutcome(row: StoredAttempt): FinalOutcome {
  return isTerminal(row.outcome) ? row.outcome : 'unknown'
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function parseCursor(cursor: string | undefined): Cursor | null {
  if (cursor === undefined) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>
    if (typeof parsed.startedAt !== 'string' || typeof parsed.attemptId !== 'string' || parsed.attemptId.length === 0) throw new Error('invalid cursor')
    return { startedAt: parsed.startedAt, attemptId: parsed.attemptId }
  } catch {
    throw new BillingError('INVALID_CURSOR', '分页游标无效')
  }
}

function compareDesc(a: StoredAttempt, b: StoredAttempt): number {
  if (a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1
  return a.attempt_id < b.attempt_id ? 1 : a.attempt_id > b.attempt_id ? -1 : 0
}

/** 同一安装账本；所有金额和额度变更均在本类内完成。 */
export class BillingDatabase {
  private readonly db: DatabaseSync
  private closed = false

  constructor(path: string) {
    ensureString(path, '数据库路径')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    try { initializeDatabase(this.db, path) } catch (error) { this.db.close(); throw error }
    if (path !== ':memory:') {
      try { this.db.exec('PRAGMA journal_mode = WAL;') } catch { /* 内存或只读环境由 SQLite 自己报告错误。 */ }
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new BillingError('DB_CLOSED', '账本数据库已关闭')
  }

  private withTransaction<T>(action: () => T): T {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* 保留原始错误。 */ }
      throw error
    }
  }

  private selectAttempt(attemptId: string, ownerToken?: string): StoredAttempt | undefined {
    this.ensureOpen()
    const sql = ownerToken === undefined
      ? `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE attempt_id = ?`
      : `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE attempt_id = ? AND owner_token = ?`
    const statement = this.db.prepare(sql)
    statement.setReadBigInts(true)
    const row = ownerToken === undefined ? statement.get(attemptId) : statement.get(attemptId, ownerToken)
    return row === undefined ? undefined : rowAsAttempt(row as SqlRow)
  }

  private selectProfileAttempts(profileId: string): StoredAttempt[] {
    ensureString(profileId, 'profileId')
    const statement = this.db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE profile_id = ?`)
    statement.setReadBigInts(true)
    return (statement.all(profileId) as SqlRow[]).map(rowAsAttempt)
  }

  prepare(start: AttemptStart): void {
    return this.withTransaction(() => {
      ensureString(start.attemptId, 'attemptId')
      ensureString(start.operationId, 'operationId')
      ensureString(start.ownerToken, 'ownerToken')
      ensureString(start.profileId, 'profileId')
      ensureString(start.channelId, 'channelId')
      ensureString(start.channelName, 'channelName')
      ensureString(start.channelKind, 'channelKind')
      ensureString(start.endpointOrigin, 'endpointOrigin')
      ensureString(start.configRevision, 'configRevision')
      const startedAt = parseStartedAt(start.startedAt)
      if (start.price.perThousand !== null) {
        try { priceToUnitMicros(start.price.perThousand) } catch {
          throw new BillingError('INVALID_PRICE', '价格无效或超出 SQLite 整数范围')
        }
      }

      const quota = start.quota
      let unitMicros: bigint | null = null
      if (start.price.perThousand !== null) unitMicros = priceToUnitMicros(start.price.perThousand)
      let credits = 0
      if (quota !== undefined) {
        ensureString(quota.subject, 'quota.subject')
        ensureString(quota.window, 'quota.window')
        if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(quota.window) || quota.window !== quotaWindowFor(startedAt)) {
          throw new BillingError('INVALID_QUOTA', '额度窗口必须等于 startedAt 对应的 UTC 月份')
        }
        credits = asSafeInteger(quota.credits, 'quota.credits')
        const limit = asSafeInteger(quota.limit, 'quota.limit')
        if (credits < 0 || limit < 0) throw new BillingError('INVALID_QUOTA', '额度必须是非负整数')
        const existingStatement = this.db.prepare('SELECT limit_credits, reserved_credits FROM quota_subjects WHERE subject = ? AND window = ?')
        existingStatement.setReadBigInts(true)
        const existing = existingStatement.get(quota.subject, quota.window) as SqlRow | undefined
        if (existing !== undefined) {
          const existingLimit = Number(existing.limit_credits)
          if (existingLimit !== limit) throw new BillingError('QUOTA_CONFIG_CONFLICT', '同一额度主体的上限配置不一致')
        } else {
          this.db.prepare('INSERT INTO quota_subjects(subject, window, limit_credits, reserved_credits) VALUES (?, ?, ?, 0)').run(quota.subject, quota.window, limit)
        }
        const reserved = this.db.prepare('SELECT reserved_credits FROM quota_subjects WHERE subject = ? AND window = ?')
        reserved.setReadBigInts(true)
        const reservedRow = reserved.get(quota.subject, quota.window) as SqlRow
        const reservedCredits = BigInt(reservedRow.reserved_credits as bigint | number)
        if (reservedCredits + BigInt(credits) > BigInt(limit)) throw new BillingError('QUOTA_LOCAL_LIMIT', '本地额度不足')
        this.db.prepare('UPDATE quota_subjects SET reserved_credits = reserved_credits + ? WHERE subject = ? AND window = ?').run(credits, quota.subject, quota.window)
      }

      try {
        this.db.prepare(`
          INSERT INTO attempts (
            attempt_id, operation_id, profile_id, session_id, source_provider_id, source_model,
            owner_token, operation, channel_id, channel_name, channel_kind, endpoint_origin,
            price_per_thousand, currency, billing_policy, config_revision, started_at,
            outcome, unit_micros, quota_credits, quota_subject, quota_window
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)
        `).run(
          start.attemptId, start.operationId, start.profileId, start.sessionId ?? null,
          start.sourceProviderId ?? null, start.sourceModel ?? null, start.ownerToken,
          start.operation, start.channelId, start.channelName, start.channelKind, start.endpointOrigin,
          start.price.perThousand, start.price.currency, start.price.policy, start.configRevision,
          start.startedAt, unitMicros, credits, quota?.subject ?? null, quota?.window ?? null,
        )
      } catch (error) {
        if (quota !== undefined) {
          this.db.prepare('UPDATE quota_subjects SET reserved_credits = reserved_credits - ? WHERE subject = ? AND window = ?').run(credits, quota.subject, quota.window)
        }
        throw new BillingError('ATTEMPT_EXISTS', error instanceof Error ? error.message : '无法创建账本记录')
      }
      if (quota !== undefined) {
        this.db.prepare('INSERT INTO quota_reservations(attempt_id, subject, window, credits) VALUES (?, ?, ?, ?)').run(start.attemptId, quota.subject, quota.window, credits)
      }
    })
  }

  dispatch(attemptId: string, ownerToken: string): boolean {
    ensureString(attemptId, 'attemptId')
    ensureString(ownerToken, 'ownerToken')
    return this.withTransaction(() => {
      const result = this.db.prepare(`UPDATE attempts SET outcome = 'dispatching', dispatched_at = ?
        WHERE attempt_id = ? AND owner_token = ? AND outcome = 'prepared'`).run(nowIso(), attemptId, ownerToken)
      return result.changes === 1
    })
  }

  finish(attemptId: string, ownerToken: string, result: AttemptResult): boolean {
    ensureString(attemptId, 'attemptId')
    ensureString(ownerToken, 'ownerToken')
    if (!['billable', 'empty', 'failed', 'unknown'].includes(result.outcome)) throw new BillingError('INVALID_OUTCOME', '终态无效')
    const outcome = result.outcome as FinalOutcome
    return this.withTransaction(() => {
      const existing = this.selectAttempt(attemptId, ownerToken)
      if (existing === undefined || isTerminal(existing.outcome)) return false
      let amount: bigint | null = null
      const unitMicros = integerValue(existing.unit_micros)
      if (outcome === 'billable' && unitMicros !== null) amount = unitMicros
      const status = result.status === undefined ? null : asSafeInteger(result.status, 'status')
      const resultCount = result.resultCount === undefined ? null : asSafeInteger(result.resultCount, 'resultCount')
      const hasContent = result.hasContent === undefined ? null : result.hasContent ? 1 : 0
      const errorCode = result.errorCode === undefined ? null : result.errorCode.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, '')
      const update = this.db.prepare(`
        UPDATE attempts SET outcome = ?, transport_status = ?, result_count = ?, has_content = ?,
          completed_at = ?, amount_micros = ?, error_code = ?
        WHERE attempt_id = ? AND owner_token = ? AND outcome IN ('prepared', 'dispatching')
      `).run(outcome, status, resultCount, hasContent, result.completedAt, amount, errorCode, attemptId, ownerToken)
      return update.changes === 1
    })
  }

  cancelPrepared(attemptId: string, ownerToken: string): boolean {
    ensureString(attemptId, 'attemptId')
    ensureString(ownerToken, 'ownerToken')
    return this.withTransaction(() => {
      const existing = this.selectAttempt(attemptId, ownerToken)
      if (existing === undefined || existing.outcome !== 'prepared') return false
      if (existing.quota_subject !== null && existing.quota_window !== null) {
        const reservation = this.db.prepare('SELECT credits FROM quota_reservations WHERE attempt_id = ?')
        reservation.setReadBigInts(true)
        const reservationRow = reservation.get(attemptId) as SqlRow | undefined
        if (reservationRow !== undefined) {
          this.db.prepare('UPDATE quota_subjects SET reserved_credits = reserved_credits - ? WHERE subject = ? AND window = ?').run(reservationRow.credits as bigint | number, existing.quota_subject, existing.quota_window)
          this.db.prepare('DELETE FROM quota_reservations WHERE attempt_id = ?').run(attemptId)
        }
      }
      const update = this.db.prepare(`UPDATE attempts SET outcome = 'failed', completed_at = ?, error_code = 'PRE_DISPATCH_CANCELLED', quota_credits = 0
        WHERE attempt_id = ? AND owner_token = ? AND outcome = 'prepared'`).run(nowIso(), attemptId, ownerToken)
      return update.changes === 1
    })
  }

  summary(profileId: string, filter: AttemptFilter = {}): SummaryRow[] {
    const rows = this.filteredRows(profileId, filter)
    interface Aggregate extends SummaryRow { key: string; latestStartedAt: number; latestAttemptId: string }
    const grouped = new Map<string, Aggregate>()
    for (const row of rows) {
      const outcome = projectedOutcome(row)
      const currency = row.currency
      const key = `${row.channel_id}\u0000${currency}\u0000${row.operation}`
      let aggregate = grouped.get(key)
      if (aggregate === undefined) {
        aggregate = {
          key,
          channelId: row.channel_id,
          channelName: row.channel_name,
          currency,
          operation: row.operation,
          total: 0,
          billable: 0,
          empty: 0,
          failed: 0,
          unknown: 0,
          priceUnknown: 0,
          amountMicros: '0',
          quotaCredits: 0,
          latestStartedAt: Number.NEGATIVE_INFINITY,
          latestAttemptId: '',
        }
        grouped.set(key, aggregate)
      }
      const rowStartedAt = Date.parse(row.started_at)
      if (rowStartedAt > aggregate.latestStartedAt || (rowStartedAt === aggregate.latestStartedAt && row.attempt_id > aggregate.latestAttemptId)) {
        aggregate.channelName = row.channel_name
        aggregate.latestStartedAt = rowStartedAt
        aggregate.latestAttemptId = row.attempt_id
      }
      aggregate.total += 1
      aggregate[outcome] += 1
      aggregate.quotaCredits += row.quota_credits
      const unitMicros = integerValue(row.unit_micros)
      if (outcome === 'billable' && unitMicros === null) aggregate.priceUnknown += 1
      if (outcome === 'billable' && unitMicros !== null) {
        const amount = BigInt(aggregate.amountMicros) + unitMicros
        if (amount > SQLITE_MAX_INTEGER) throw new BillingError('AMOUNT_OVERFLOW', '汇总金额超出 SQLite 整数范围')
        aggregate.amountMicros = formatMicros(amount)
      }
    }
    return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key)).map(({ key: _key, latestStartedAt: _latestStartedAt, latestAttemptId: _latestAttemptId, ...row }) => row)
  }

  list(profileId: string, filter: AttemptFilter = {}, cursor?: string, limit = 50): { items: AttemptView[]; nextCursor: string | null } {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) throw new BillingError('INVALID_LIMIT', '分页大小必须在 1 到 200 之间')
    const parsedCursor = parseCursor(cursor)
    const rows = this.filteredRows(profileId, filter).sort(compareDesc)
    const afterCursor = parsedCursor === null ? rows : rows.filter(row => row.started_at < parsedCursor.startedAt || (row.started_at === parsedCursor.startedAt && row.attempt_id < parsedCursor.attemptId))
    const page = afterCursor.slice(0, limit + 1)
    const hasNext = page.length > limit
    const items = page.slice(0, limit).map(row => this.toView(row))
    const next = hasNext && page[limit - 1] !== undefined
      ? base64UrlEncode(JSON.stringify({ startedAt: page[limit - 1].started_at, attemptId: page[limit - 1].attempt_id } satisfies Cursor))
      : null
    return { items, nextCursor: next }
  }

  /** 导出用：一次取回有上限的完整记录集，顺序与分页接口一致。 */
  allViews(profileId: string, filter: AttemptFilter, limit: number): { items: AttemptView[]; truncated: boolean } {
    ensureString(profileId, 'profileId')
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new BillingError('INVALID_LIMIT', '导出条数上限无效')
    const rows = this.filteredRows(profileId, filter).sort(compareDesc)
    return { items: rows.slice(0, limit).map(row => this.toView(row)), truncated: rows.length > limit }
  }

  private filteredRows(profileId: string, filter: AttemptFilter): StoredAttempt[] {
    const rows = this.selectProfileAttempts(profileId)
    return rows.filter(row => {
      if (filter.from !== undefined && row.started_at < filter.from) return false
      if (filter.to !== undefined && row.started_at > filter.to) return false
      if (filter.channelId !== undefined && row.channel_id !== filter.channelId) return false
      if (filter.sourceProviderId !== undefined && row.source_provider_id !== filter.sourceProviderId) return false
      if (filter.sessionId !== undefined && row.session_id !== filter.sessionId) return false
      if (filter.currency !== undefined && row.currency !== filter.currency) return false
      return true
    })
  }

  private toView(row: StoredAttempt): AttemptView {
    const unitMicros = integerValue(row.unit_micros)
    const amountMicros = integerValue(row.amount_micros)
    return {
      attemptId: row.attempt_id,
      operationId: row.operation_id,
      profileId: row.profile_id,
      sessionId: row.session_id,
      sourceProviderId: row.source_provider_id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      operation: row.operation,
      outcome: projectedOutcome(row),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: row.transport_status,
      currency: row.currency,
      amountMicros: amountMicros === null ? null : formatMicros(amountMicros),
      pricePerThousand: row.price_per_thousand,
      quotaCredits: row.quota_credits,
    }
  }

  channelSessionReferences(profileId: string, channelId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM session_overrides WHERE profile_id=? AND (search_channel_id=? OR fetch_channel_id=?)').get(profileId, channelId, channelId)
    return asSafeInteger(row?.count, '会话覆盖数量')
  }

  /** 按关联ID读取脱敏记录；跨profile不可读取。 */
  getAttempt(profileId: string, attemptId: string): AttemptView | null {
    const row = this.selectAttempt(attemptId)
    return row && row.profile_id === profileId ? this.toView(row) : null
  }

  hasChannelAttempts(profileId: string, channelId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM attempts WHERE profile_id=? AND channel_id=? LIMIT 1').get(profileId, channelId)
  }

  /** 熔断判定输入：窗口内已终结的记录，按开始时间倒序，只含判定所需字段。 */
  recentOutcomes(profileId: string, since: string): BreakerObservation[] {
    ensureString(profileId, 'profileId')
    const parsed = parseStartedAt(since)
    const statement = this.db.prepare(`
      SELECT channel_id, outcome, started_at FROM attempts
      WHERE profile_id = ? AND started_at >= ? AND outcome IN ('billable', 'empty', 'failed', 'unknown')
      ORDER BY started_at DESC, attempt_id DESC
    `)
    return (statement.all(profileId, parsed.toISOString()) as SqlRow[]).map(row => ({
      channelId: String(row.channel_id),
      outcome: row.outcome as BreakerObservation['outcome'],
      startedAt: String(row.started_at),
    }))
  }

  /**
   * 预算用量：金额只累计已确认计费的金额，次数统计所有已离开 prepared 的记录。
   * 派发前取消的记录从未产生上游请求，不计入次数。
   */
  budgetUsage(profileId: string, from: string, to: string): BudgetUsageTotal {
    ensureString(profileId, 'profileId')
    const start = parseStartedAt(from).toISOString()
    const end = parseStartedAt(to).toISOString()
    const amountStatement = this.db.prepare(`
      SELECT currency, SUM(amount_micros) AS total FROM attempts
      WHERE profile_id = ? AND started_at >= ? AND started_at < ?
        AND outcome = 'billable' AND amount_micros IS NOT NULL
      GROUP BY currency
    `)
    amountStatement.setReadBigInts(true)
    const amounts: Partial<Record<Currency, string>> = {}
    for (const row of amountStatement.all(profileId, start, end) as SqlRow[]) {
      const total = row.total === null || row.total === undefined ? 0n : BigInt(row.total as bigint | number)
      amounts[row.currency as Currency] = formatMicros(total)
    }
    const count = this.db.prepare(`
      SELECT COUNT(*) AS count FROM attempts
      WHERE profile_id = ? AND started_at >= ? AND started_at < ?
        AND outcome <> 'prepared' AND (error_code IS NULL OR error_code <> 'PRE_DISPATCH_CANCELLED')
    `).get(profileId, start, end)
    return { amounts, requests: asSafeInteger(count?.count, '请求次数') }
  }

  getOverrides(profileId: string, sessionId: string): SessionOverrides {
    ensureString(profileId, 'profileId')
    ensureString(sessionId, 'sessionId')
    const statement = this.db.prepare('SELECT revision, search_channel_id, fetch_channel_id FROM session_overrides WHERE profile_id = ? AND session_id = ?')
    const row = statement.get(profileId, sessionId) as SqlRow | undefined
    return row === undefined
      ? { revision: 0, search: null, fetch: null }
      : { revision: Number(row.revision), search: row.search_channel_id as string | null, fetch: row.fetch_channel_id as string | null }
  }

  setOverride(profileId: string, sessionId: string, operation: Operation, channelIdOrNull: string | null, expectedRevision: number): SessionOverrides {
    ensureString(profileId, 'profileId')
    ensureString(sessionId, 'sessionId')
    if (operation !== 'search' && operation !== 'fetch') throw new BillingError('INVALID_ARGUMENT', 'operation 无效')
    if (channelIdOrNull !== null) ensureString(channelIdOrNull, 'channelId')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new BillingError('INVALID_ARGUMENT', 'expectedRevision 无效')
    return this.withTransaction(() => {
      const current = this.db.prepare('SELECT revision FROM session_overrides WHERE profile_id = ? AND session_id = ?').get(profileId, sessionId) as SqlRow | undefined
      const revision = current === undefined ? 0 : Number(current.revision)
      if (revision !== expectedRevision) throw new BillingError('SETTINGS_CONFLICT', '会话覆盖已被其他更新修改')
      if (current === undefined) {
        this.db.prepare('INSERT INTO session_overrides(profile_id, session_id, revision, search_channel_id, fetch_channel_id) VALUES (?, ?, 1, ?, ?)').run(profileId, sessionId, operation === 'search' ? channelIdOrNull : null, operation === 'fetch' ? channelIdOrNull : null)
      } else {
        const column = operation === 'search' ? 'search_channel_id' : 'fetch_channel_id'
        // column 仅来自固定的 Operation 联合类型，绝不把用户输入拼入 SQL。
        if (column === 'search_channel_id') this.db.prepare('UPDATE session_overrides SET revision = revision + 1, search_channel_id = ? WHERE profile_id = ? AND session_id = ? AND revision = ?').run(channelIdOrNull, profileId, sessionId, expectedRevision)
        else this.db.prepare('UPDATE session_overrides SET revision = revision + 1, fetch_channel_id = ? WHERE profile_id = ? AND session_id = ? AND revision = ?').run(channelIdOrNull, profileId, sessionId, expectedRevision)
      }
      return this.getOverrides(profileId, sessionId)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

export type { AttemptFilter, AttemptResult, AttemptStart, AttemptView, SessionOverrides, SummaryRow } from '../contracts.ts'
