import { describe, expect, it } from 'vitest'
import { buildExport, EXPORT_ROW_LIMIT } from '../../src/host/ledger-export.ts'
import type { AttemptView } from '../../src/contracts.ts'

const now = new Date(Date.UTC(2026, 9, 28, 3, 4, 5))

function row(overrides: Partial<AttemptView> = {}): AttemptView {
  return {
    attemptId: 'attempt-1',
    operationId: 'operation-1',
    profileId: 'profile',
    sessionId: 'session',
    sourceProviderId: 'provider',
    channelId: 'channel',
    channelName: '渠道',
    operation: 'search',
    outcome: 'billable',
    startedAt: '2026-10-28T02:00:00.000Z',
    completedAt: '2026-10-28T02:00:01.000Z',
    status: 200,
    currency: 'CNY',
    amountMicros: '5000',
    pricePerThousand: '5',
    quotaCredits: 1,
    ...overrides,
  }
}

describe('buildExport', () => {
  it('CSV 带 BOM、表头与一行记录', () => {
    const file = buildExport([row()], 'csv', false, now)
    expect(file.content.startsWith('\ufeff')).toBe(true)
    const [header, first] = file.content.slice(1).split('\r\n')
    expect(header).toBe('startedAt,completedAt,operation,channelId,channelName,outcome,status,currency,pricePerThousand,amountMicros,quotaCredits,sourceProviderId,attemptId')
    expect(first).toBe('2026-10-28T02:00:00.000Z,2026-10-28T02:00:01.000Z,search,channel,渠道,billable,200,CNY,5,5000,1,provider,attempt-1')
  })

  it('CSV 转义引号与逗号，并保留换行', () => {
    const file = buildExport([row({ channelName: 'a,b"c\nd' })], 'csv', false, now)
    expect(file.content).toContain('"a,b""c\nd"')
  })

  it('空值导出为空单元格而不是字面 null', () => {
    const file = buildExport([row({ completedAt: null, status: null, amountMicros: null, pricePerThousand: null })], 'csv', false, now)
    expect(file.content).not.toContain('null')
    expect(file.content.split('\r\n')[1]).toContain(',,')
  })

  it('以公式字符开头的文本被中和', () => {
    const file = buildExport([row({ channelName: '=SUM(A1)' })], 'csv', false, now)
    expect(file.content).toContain(`,'=SUM(A1),`)
  })

  it('公式字符与逗号同时存在时既中和又加引号', () => {
    const file = buildExport([row({ channelName: '=1,2' })], 'csv', false, now)
    expect(file.content).toContain(`"'=1,2"`)
  })

  it('JSON 输出稳定字段集且不泄露会话或正文', () => {
    const file = buildExport([row()], 'json', false, now)
    const parsed = JSON.parse(file.content) as Record<string, unknown>[]
    expect(Object.keys(parsed[0]!)).toEqual([
      'startedAt', 'completedAt', 'operation', 'channelId', 'channelName', 'outcome', 'status',
      'currency', 'pricePerThousand', 'amountMicros', 'quotaCredits', 'sourceProviderId', 'attemptId',
    ])
    expect(file.content).not.toContain('session')
    expect(file.content).not.toContain('operation-1')
  })

  it('文件名带 UTC 时间戳与扩展名', () => {
    expect(buildExport([], 'csv', false, now).filename).toBe('web-search-ledger-20261028-030405.csv')
    expect(buildExport([], 'json', false, now).filename).toBe('web-search-ledger-20261028-030405.json')
  })

  it('声明行数与截断标记', () => {
    const file = buildExport([row(), row({ attemptId: 'attempt-2' })], 'csv', true, now)
    expect(file.rowCount).toBe(2)
    expect(file.truncated).toBe(true)
  })

  it('mime 类型区分格式', () => {
    expect(buildExport([], 'csv', false, now).mimeType).toContain('text/csv')
    expect(buildExport([], 'json', false, now).mimeType).toContain('application/json')
  })

  it('拒绝未知格式', () => {
    expect(() => buildExport([], 'xml' as 'csv', false, now)).toThrow(/format must be csv or json/)
  })

  it('导出行数上限是显式常量', () => {
    expect(EXPORT_ROW_LIMIT).toBe(20_000)
  })
})
