// 预算按本机时区的自然日/自然月统计；币种各自限额，绝不隐式折算汇率。
import type { BudgetSettings, BudgetState, BudgetUsage, Currency } from '../contracts.ts'
import { BillingError } from '../contracts.ts'
import { decimalToMicros } from './money.ts'

const CURRENCIES: readonly Currency[] = ['CNY', 'USD']

export interface BudgetWindowRange {
  /** 含边界，UTC ISO 时间，与账本 started_at 同一格式。 */
  from: string
  to: string
}

export interface BudgetUsageTotal {
  amounts: Partial<Record<Currency, string>>
  requests: number
}

function valid(date: Date): number {
  const value = date.getTime()
  if (!Number.isFinite(value)) throw new BillingError('TIME_INVALID', '时间无效')
  return value
}

/**
 * 计算窗口边界。窗口按宿主本机时区的自然日/自然月开始，
 * 与渠道额度的 UTC 月份不同：预算面向使用者直觉，额度面向服务商账单周期。
 */
export function budgetWindow(now: Date, window: 'day' | 'month'): BudgetWindowRange {
  valid(now)
  const year = now.getFullYear()
  const month = now.getMonth()
  const day = now.getDate()
  const start = window === 'month' ? new Date(year, month, 1) : new Date(year, month, day)
  const end = window === 'month' ? new Date(year, month + 1, 1) : new Date(year, month, day + 1)
  return { from: start.toISOString(), to: end.toISOString() }
}

/** 预算用量汇总成可展示状态；未设置限额的币种在完全没有消费时省略。 */
export function budgetState(usage: BudgetUsageTotal, settings: BudgetSettings, range: BudgetWindowRange): BudgetState {
  const currencies: BudgetUsage[] = []
  for (const currency of CURRENCIES) {
    const limitText = settings.limits[currency] ?? null
    const amountMicros = usage.amounts[currency] ?? '0'
    if (limitText === null && amountMicros === '0') continue
    let exceeded = false
    if (limitText !== null) {
      let limitMicros: bigint
      try { limitMicros = decimalToMicros(limitText) } catch { throw new BillingError('CONFIG_INVALID', '预算限额金额无效') }
      exceeded = BigInt(amountMicros) >= limitMicros
    }
    currencies.push({ currency, amountMicros, limit: limitText, exceeded })
  }
  const requestsExceeded = settings.requests !== null && usage.requests >= settings.requests
  return {
    enabled: settings.enabled,
    window: settings.window,
    windowFrom: range.from,
    windowTo: range.to,
    onExceed: settings.onExceed,
    requests: usage.requests,
    requestLimit: settings.requests,
    currencies,
    exceeded: requestsExceeded || currencies.some(item => item.exceeded),
  }
}
