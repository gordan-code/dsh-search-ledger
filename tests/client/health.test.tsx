// @vitest-environment jsdom
// 熔断/预算/导出都属于新增能力：旧宿主缺少方法时只能显示"未提供"，不能伪造数据。
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BreakerCard, BudgetCard } from '../../src/client/Health.tsx'
import { Usage } from '../../src/client/Usage.tsx'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const budgetState = {
  enabled: true, window: 'day' as const,
  windowFrom: '2026-10-27T16:00:00.000Z', windowTo: '2026-10-28T16:00:00.000Z',
  onExceed: 'block' as const, requests: 12, requestLimit: 100,
  currencies: [{ currency: 'CNY' as const, amountMicros: '5000', limit: '5', exceeded: true }],
  exceeded: true,
}

const breakerViews = [
  { channelId: 'a', channelName: '渠道A', open: true, failures: 3, threshold: 3, cooldownUntil: '2026-10-28T03:00:00.000Z', lastFailureAt: '2026-10-28T02:50:00.000Z', resetAt: null },
  { channelId: 'b', channelName: '渠道B', open: false, failures: 0, threshold: 3, cooldownUntil: null, lastFailureAt: null, resetAt: null },
]

describe('预算卡片', () => {
  it('宿主缺少接口时明确说明而不是显示零用量', () => {
    render(<BudgetCard api={{ getStatus: async () => ({}), listProviders: async () => [], listChannelStates: async () => [], deleteChannel: async () => 1, getSummary: async () => [], listAttempts: async () => ({ items: [], nextCursor: null }), getSessionOverride: async () => ({} as never), setSessionOverride: async () => ({} as never) }} config={DEFAULT_CONFIG} />)
    expect(screen.getByText('当前宿主未提供预算接口')).toBeTruthy()
    expect((screen.getByRole('button', { name: '刷新预算' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('超限时给出明确状态与解释', async () => {
    const api = { getBudgetState: vi.fn(async () => budgetState) }
    render(<BudgetCard api={api as never} config={DEFAULT_CONFIG} />)
    await screen.findByText('已达到预算上限')
    expect(screen.getByText('12 / 100')).toBeTruthy()
    expect(screen.getByText('超限后拒绝新请求')).toBeTruthy()
    expect(screen.getByText('已超限')).toBeTruthy()
    expect(screen.getByText('0.005000')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
  })

  it('预算上限是十进制金额，不按微单位再次缩小', async () => {
    const api = { getBudgetState: vi.fn(async () => ({ ...budgetState, currencies: [{ ...budgetState.currencies[0], limit: '5.25' }] })) }
    render(<BudgetCard api={api as never} config={DEFAULT_CONFIG} />)
    expect(await screen.findByText('5.25')).toBeTruthy()
  })

  it('未设置限额的币种显示为不限', async () => {
    const api = { getBudgetState: vi.fn(async () => ({ ...budgetState, exceeded: false, currencies: [{ currency: 'USD', amountMicros: '250000', limit: null, exceeded: false }] })) }
    render(<BudgetCard api={api as never} config={DEFAULT_CONFIG} />)
    await screen.findByText('已读取预算用量')
    expect(screen.getAllByText('不限').length).toBeGreaterThan(0)
    expect(screen.getByText('不受限')).toBeTruthy()
  })

  it('读取失败时显示错误原文，不静默归零', async () => {
    const api = { getBudgetState: vi.fn(async () => { throw new Error('预算用量读取失败') }) }
    render(<BudgetCard api={api as never} config={DEFAULT_CONFIG} />)
    expect(await screen.findByText('预算用量读取失败')).toBeTruthy()
  })
})

describe('熔断卡片', () => {
  it('宿主缺少接口时明确说明', () => {
    render(<BreakerCard api={{ getStatus: async () => ({}), listProviders: async () => [], listChannelStates: async () => [], deleteChannel: async () => 1, getSummary: async () => [], listAttempts: async () => ({ items: [], nextCursor: null }), getSessionOverride: async () => ({} as never), setSessionOverride: async () => ({} as never) }} config={DEFAULT_CONFIG} />)
    expect(screen.getByText('当前宿主未提供熔断接口')).toBeTruthy()
  })

  it('展示冷却渠道并允许复位', async () => {
    const resetBreaker = vi.fn(async () => breakerViews.map(view => ({ ...view, open: false, cooldownUntil: null })))
    const api = { listBreakerStates: vi.fn(async () => breakerViews), resetBreaker }
    render(<BreakerCard api={api as never} config={DEFAULT_CONFIG} />)
    expect(await screen.findByText('1 个渠道正在冷却')).toBeTruthy()
    expect(screen.getByText('3 / 3')).toBeTruthy()
    expect(screen.getByText('无需复位')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复位' }))
    await waitFor(() => expect(resetBreaker).toHaveBeenCalledWith('a'))
    expect(await screen.findByText('已复位该渠道的冷却')).toBeTruthy()
  })

  it('复位失败时保留错误信息且不禁用整张卡片', async () => {
    const api = { listBreakerStates: vi.fn(async () => breakerViews), resetBreaker: vi.fn(async () => { throw new Error('渠道不存在，无法复位') }) }
    render(<BreakerCard api={api as never} config={DEFAULT_CONFIG} />)
    await screen.findByText('1 个渠道正在冷却')
    fireEvent.click(screen.getByRole('button', { name: '复位' }))
    expect(await screen.findByText('渠道不存在，无法复位')).toBeTruthy()
    expect((screen.getByRole('button', { name: '复位' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('账本导出', () => {
  const baseApi = { getSummary: async () => [], listAttempts: async () => ({ items: [], nextCursor: null }) }

  it('缺少导出接口时按钮被禁用', async () => {
    render(<Usage api={baseApi as never} config={DEFAULT_CONFIG} providers={[]} />)
    const button = await screen.findByRole('button', { name: '导出 CSV' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('导出成功后报告条数并触发下载', async () => {
    const createObjectURL = vi.fn(() => 'blob:ledger')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const exportLedger = vi.fn(async () => ({ filename: 'web-search-ledger-20261028-030405.csv', mimeType: 'text/csv;charset=utf-8', content: '\ufeffa,b', rowCount: 3, truncated: false }))
    render(<Usage api={{ ...baseApi, exportLedger } as never} config={DEFAULT_CONFIG} providers={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: '导出 CSV' }))
    expect(await screen.findByText('已导出 3 条记录')).toBeTruthy()
    expect(exportLedger).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('截断与失败都必须写清，不能被当成完整导出', async () => {
    const exportLedger = vi.fn(async () => ({ filename: 'x.csv', mimeType: 'text/csv', content: '', rowCount: 20_000, truncated: true }))
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const view = render(<Usage api={{ ...baseApi, exportLedger } as never} config={DEFAULT_CONFIG} providers={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: '导出 JSON' }))
    expect(await screen.findByText(/已达单次上限/)).toBeTruthy()
    view.unmount()

    const failing = render(<Usage api={{ ...baseApi, exportLedger: vi.fn(async () => { throw new Error('导出条数上限无效') }) } as never} config={DEFAULT_CONFIG} providers={[]} />)
    fireEvent.click(await failing.findByRole('button', { name: '导出 CSV' }))
    expect(await failing.findByText('导出条数上限无效')).toBeTruthy()
  })
})
