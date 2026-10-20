/** SQLite INTEGER 能表示的最大非负值。 */
export const SQLITE_MAX_INTEGER = 9_223_372_036_854_775_807n

/**
 * 把每千次价格换算为一次调用的微单位金额。
 *
 * 价格最多保留三位小数，因此乘以 1000 后必定是整数：5.000 -> 5000。
 * 这里不接受指数、符号或空白形式，避免不同解析器对金额给出不同结果。
 */
export function priceToUnitMicros(perThousand: string): bigint {
  if (typeof perThousand !== 'string' || !/^\d+(?:\.\d{1,3})?$/.test(perThousand)) {
    throw new RangeError('价格必须是非负十进制字符串，且最多三位小数')
  }
  const [whole, fraction = ''] = perThousand.split('.')
  const value = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0')
  if (value > SQLITE_MAX_INTEGER) throw new RangeError('价格超出 SQLite 整数范围')
  return value
}

/** 把金额整数规范化为可安全传输和持久化的十进制整数文本。 */
export function formatMicros(micros: string | bigint): string {
  let value: bigint
  try {
    if (typeof micros === 'bigint') value = micros
    else if (typeof micros === 'string' && /^\d+$/.test(micros)) value = BigInt(micros)
    else throw new Error('invalid')
  } catch {
    throw new RangeError('微单位金额必须是非负整数')
  }
  if (value < 0n || value > SQLITE_MAX_INTEGER) throw new RangeError('金额超出 SQLite 整数范围')
  return value.toString(10)
}
