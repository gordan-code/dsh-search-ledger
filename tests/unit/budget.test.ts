import { describe, expect, it } from 'vitest'
import { budgetState, budgetWindow } from '../../src/accounting/budget.ts'
import type { BudgetSettings } from '../../src/contracts.ts'

function settings(overrides: Partial<BudgetSettings> = {}): BudgetSettings {
  return { enabled: true, window: 'day', limits: {}, requests: null, onExceed: 'warn', ...overrides }
}

describe('budgetWindow', () => {
  it('自然日从本机零点开始，到次日零点结束', () => {
    const range = budgetWindow(new Date(2026, 9, 28, 15, 30, 0), 'day')
    expect(new Date(range.from).getHours()).toBe(0)
    expect(new Date(range.from).getDate()).toBe(28)
    expect(new Date(range.to).getDate()).toBe(29)
    expect(new Date(range.to).getTime() - new Date(range.from).getTime()).toBe(86_400_000)
  })

  it('自然月从当月一日到次月一日', () => {
    const range = budgetWindow(new Date(2026, 9, 28, 15, 30, 0), 'month')
    expect(new Date(range.from).getDate()).toBe(1)
    expect(new Date(range.from).getMonth()).toBe(9)
    expect(new Date(range.to).getMonth()).toBe(10)
  })

  it('跨年月份的窗口边界正确', () => {
    const range = budgetWindow(new Date(2026, 11, 31, 23, 0, 0), 'month')
    expect(new Date(range.from).getFullYear()).toBe(2026)
    expect(new Date(range.to).getFullYear()).toBe(2027)
    expect(new Date(range.to).getMonth()).toBe(0)
  })

  it('拒绝无效时间', () => {
    expect(() => budgetWindow(new Date(Number.NaN), 'day')).toThrow(/时间无效/)
  })
})

describe('budgetState', () => {
  const range = budgetWindow(new Date(2026, 9, 28, 12, 0, 0), 'day')

  it('未设置限额的币种在无消费时完全省略', () => {
    const state = budgetState({ amounts: {}, requests: 0 }, settings(), range)
    expect(state.currencies).toEqual([])
    expect(state.exceeded).toBe(false)
    expect(state.requestLimit).toBeNull()
  })

  it('金额达到上限即判为超限', () => {
    const state = budgetState({ amounts: { CNY: '5000000' }, requests: 12 }, settings({ limits: { CNY: '5' } }), range)
    expect(state.currencies).toEqual([{ currency: 'CNY', amountMicros: '5000000', limit: '5', exceeded: true }])
    expect(state.exceeded).toBe(true)
    expect(state.requests).toBe(12)
  })

  it('未达上限不算超限', () => {
    const state = budgetState({ amounts: { CNY: '4999999' }, requests: 1 }, settings({ limits: { CNY: '5' } }), range)
    expect(state.currencies[0]!.exceeded).toBe(false)
    expect(state.exceeded).toBe(false)
  })

  it('不同币种各自限额，不做汇率折算', () => {
    const state = budgetState(
      { amounts: { CNY: '1000000', USD: '9000000' }, requests: 2 },
      settings({ limits: { CNY: '5', USD: '5' } }),
      range,
    )
    expect(state.currencies.map(row => [row.currency, row.exceeded])).toEqual([['CNY', false], ['USD', true]])
    expect(state.exceeded).toBe(true)
  })

  it('请求次数达到上限同样判为超限', () => {
    const state = budgetState({ amounts: {}, requests: 50 }, settings({ requests: 50 }), range)
    expect(state.exceeded).toBe(true)
    expect(state.requestLimit).toBe(50)
  })

  it('未设置请求上限时不按次数超限', () => {
    const state = budgetState({ amounts: {}, requests: 10_000 }, settings(), range)
    expect(state.exceeded).toBe(false)
  })

  it('有消费但无限额的币种仍然展示', () => {
    const state = budgetState({ amounts: { USD: '250000' }, requests: 1 }, settings(), range)
    expect(state.currencies).toEqual([{ currency: 'USD', amountMicros: '250000', limit: null, exceeded: false }])
  })

  it('保留 onExceed 与窗口信息供界面解释', () => {
    const state = budgetState({ amounts: {}, requests: 0 }, settings({ onExceed: 'block', window: 'month' }), range)
    expect(state.onExceed).toBe('block')
    expect(state.window).toBe('month')
    expect(state.windowFrom).toBe(range.from)
    expect(state.windowTo).toBe(range.to)
  })

  it('限额写法非法时明确报错', () => {
    expect(() => budgetState({ amounts: { CNY: '1' }, requests: 0 }, settings({ limits: { CNY: 'abc' } }), range)).toThrow(/预算限额金额无效/)
  })
})
