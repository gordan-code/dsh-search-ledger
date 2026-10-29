// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Diagnostics, diagnosticExport } from '../../src/client/Diagnostics.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const attempts = [
  { attemptId: 'a', operationId: 'op', profileId: 'p', sessionId: null, sourceProviderId: 'p1', channelId: 'a', channelName: '第一渠道', operation: 'search', outcome: 'unknown', startedAt: '2026-10-28T10:00:00Z', completedAt: null, status: null, currency: 'CNY', amountMicros: null, pricePerThousand: null, quotaCredits: 0 },
  { attemptId: 'b', operationId: 'op', profileId: 'p', sessionId: null, sourceProviderId: 'p1', channelId: 'b', channelName: '第二渠道', operation: 'search', outcome: 'billable', startedAt: '2026-10-28T10:00:01Z', completedAt: '2026-10-28T10:00:02Z', status: 200, currency: 'CNY', amountMicros: '5000', pricePerThousand: '5', quotaCredits: 0 },
]
const status = { version: '0.6.1', profileId: 'secret-profile', namespace: 'dsh-search-ledger', coverage: '', active: true, configError: null, operations: { search: { providerId: 'web-search-metered', metered: true, selectionSource: 'runtime-entry' }, fetch: { providerId: null, metered: false, selectionSource: 'settings-only' } }, routes: [] }

it('使用现有脱敏 API 读取就绪状态并将同操作尝试分组', async () => {
  const api = { listAttempts: vi.fn(async () => ({ items: attempts, nextCursor: 'more' })), getCandidateStates: vi.fn(async () => [{ channelId: 'a', capabilities: ['search'], credentialReady: false, reason: '未配置凭证' }]) }
  render(<Diagnostics api={api as never} status={status as never} providers={[{ id: 'p1', name: '模型 P1' }]} />)
  expect(await screen.findByText(/未配置凭证/)).toBeTruthy()
  expect(await screen.findByText(/2 次已记录尝试/)).toBeTruthy()
  expect(screen.getByText('第一渠道')).toBeTruthy()
  expect(screen.getByText('第二渠道')).toBeTruthy()
  expect(screen.getByText(/可能不完整/)).toBeTruthy()
  expect(api.getCandidateStates).toHaveBeenCalledWith('search', 'p1', null)
  expect(api.listAttempts).toHaveBeenCalledTimes(1)
})

it('诊断导出仅生成白名单统计，不含用户提供的名字、标识、查询或错误文本', () => {
  const report = diagnosticExport(status as never, attempts as never, true)
  const text = JSON.stringify(report)
  for (const sensitive of ['secret-profile', 'p1', '第一渠道', '第二渠道', 'web-search-metered']) expect(text).not.toContain(sensitive)
  expect(report.attempts).toBe(2)
  expect(report.truncated).toBe(true)
  expect(report.recent[0].outcome).toBe('unknown')
  expect(report.recent[1].httpStatus).toBe(200)
  expect(report.pluginVersion).toBe('0.6.1')
})

it('不完整后端证据不伪装成已确认未接管', () => {
  const report = diagnosticExport({ ...status, operations: { ...status.operations, fetch: { metered: false, selectionSource: 'settings-only' } } } as never, [], false)
  expect(report.fetchMetered).toBeNull()
})

it('诊断导出需要用户确认后才下载', async () => {
  const api = { listAttempts: vi.fn(async () => ({ items: [], nextCursor: null })) }
  const create = vi.fn(() => 'blob:diagnostics')
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<Diagnostics api={api as never} status={status as never} providers={[]} />)
  fireEvent.click(await screen.findByRole('button', { name: '导出脱敏诊断' }))
  expect(confirm).toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it('浏览器不支持导出时提示错误而不是崩溃', async () => {
  const api = { listAttempts: vi.fn(async () => ({ items: [], nextCursor: null })) }
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('private error') })
  render(<Diagnostics api={api as never} status={status as never} providers={[]} />)
  fireEvent.click(await screen.findByRole('button', { name: '导出脱敏诊断' }))
  expect(await screen.findByText('无法导出诊断，请检查当前环境的下载权限。')).toBeTruthy()
})
