import { describe, expect, it } from 'vitest'
import { formatMicros, priceToUnitMicros } from '../../src/accounting/money.ts'

describe('金额转换', () => {
  it('把每千次价格精确转换为单次微单位', () => {
    expect(priceToUnitMicros('5')).toBe(5000n)
    expect(priceToUnitMicros('1.234')).toBe(1234n)
    expect(priceToUnitMicros('0.001')).toBe(1n)
  })

  it('拒绝负数、超过三位小数和超出 SQLite 整数范围的价格', () => {
    expect(() => priceToUnitMicros('-1')).toThrow()
    expect(() => priceToUnitMicros('1.0001')).toThrow()
    expect(() => priceToUnitMicros('1e2')).toThrow()
    expect(() => priceToUnitMicros('9223372036854775808')).toThrow()
  })

  it('将微单位以不丢精度的十进制整数文本输出', () => {
    expect(formatMicros(5000n)).toBe('5000')
    expect(formatMicros('0')).toBe('0')
  })
})
