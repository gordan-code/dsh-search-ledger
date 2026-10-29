// 账本导出只包含脱敏字段：没有查询正文、正文内容、凭证、安装主体或会话ID。
import type { AttemptView, ExportFormat, LedgerExport } from '../contracts.ts'

/** 单次导出上限；超出时截断并在结果里明确标注。 */
export const EXPORT_ROW_LIMIT = 20_000

const HEADER = [
  'startedAt', 'completedAt', 'operation', 'channelId', 'channelName',
  'outcome', 'status', 'currency', 'pricePerThousand', 'amountMicros',
  'quotaCredits', 'sourceProviderId', 'attemptId',
] as const

/** 电子表格会把 = + - @ 开头的单元格当作公式；导出前统一加前缀抵消。 */
function cell(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
}

function csvCell(value: string | number | null): string {
  const text = cell(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function record(row: AttemptView): (string | number | null)[] {
  return [
    row.startedAt, row.completedAt, row.operation, row.channelId, row.channelName,
    row.outcome, row.status, row.currency, row.pricePerThousand, row.amountMicros,
    row.quotaCredits, row.sourceProviderId, row.attemptId,
  ]
}

function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

/** 行序沿用账本的分页顺序（时间倒序），便于与界面核对。 */
export function buildExport(rows: readonly AttemptView[], format: ExportFormat, truncated: boolean, now: Date): LedgerExport {
  if (format !== 'csv' && format !== 'json') throw new Error('format must be csv or json')
  const content = format === 'csv'
    ? [HEADER.join(','), ...rows.map(row => record(row).map(csvCell).join(','))].join('\r\n')
    : JSON.stringify(rows.map(row => Object.fromEntries(HEADER.map((key, index) => [key, record(row)[index] ?? null]))), null, 2)
  return {
    filename: `web-search-ledger-${stamp(now)}.${format}`,
    mimeType: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
    content: format === 'csv' ? `\ufeff${content}` : content,
    rowCount: rows.length,
    truncated,
  }
}
