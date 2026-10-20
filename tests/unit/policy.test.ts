import { describe, expect, it } from 'vitest'
import { decide } from '../../src/accounting/policy.ts'

describe('计费策略', () => {
  it('官方 Search 只对 200 且原始 results 非空计费', () => {
    expect(decide('search', 'official-nonempty', { status: 200, payload: { results: [{ title: 'x' }] } })).toMatchObject({ outcome: 'billable', resultCount: 1 })
    expect(decide('search', 'official-nonempty', { status: 200, payload: { results: [] } })).toMatchObject({ outcome: 'empty', resultCount: 0 })
    expect(decide('search', 'official-nonempty', { status: 200, payload: {} }).outcome).toBe('unknown')
    expect(decide('search', 'official-nonempty', { status: 503 }).outcome).toBe('failed')
  })

  it('官方 Fetch 区分非空内容、空内容与损坏 200', () => {
    expect(decide('fetch', 'official-nonempty', { status: 200, payload: { content: '正文' } })).toMatchObject({ outcome: 'billable', hasContent: true })
    expect(decide('fetch', 'official-nonempty', { status: 200, payload: { content: '  ' } })).toMatchObject({ outcome: 'empty', hasContent: false })
    expect(decide('fetch', 'official-nonempty', { status: 200, payload: { content: 3 } }).outcome).toBe('unknown')
    expect(decide('fetch', 'official-nonempty', { transportUnknown: true }).outcome).toBe('unknown')
  })

  it('http-200 策略对任何 HTTP 200 计费，而非 200 为已知失败', () => {
    expect(decide('search', 'http-200', { status: 200, payload: { malformed: true } }).outcome).toBe('billable')
    expect(decide('search', 'http-200', { status: 429 }).outcome).toBe('failed')
    expect(decide('search', 'http-200', { status: 200, transportUnknown: true }).outcome).toBe('unknown')
  })

  it('free 策略仍要求结果证据但不改变成功状态', () => {
    expect(decide('search', 'free', { status: 200, payload: { results: [{ url: 'x' }] } }).outcome).toBe('billable')
    expect(decide('search', 'free', { status: 200, payload: { results: [] } }).outcome).toBe('empty')
  })

  it('provider-success 先遵循服务商逐请求证据，不能被 HTTP 200 覆盖', () => {
    expect(decide('search', 'provider-success', { status: 200, payload: {}, billingEvidence: { state: 'success', resultCount: 2, hasContent: true } })).toMatchObject({ outcome: 'billable', resultCount: 2 })
    // 非DeepSeek的成功请求可能按次收费，不能套用官方“空结果不收费”。
    expect(decide('search', 'provider-success', { status: 200, payload: {}, billingEvidence: { state: 'success', resultCount: 0, hasContent: false } }).outcome).toBe('billable')
    expect(decide('search', 'http-200', { status: 200, payload: {}, billingEvidence: { state: 'failed' } }).outcome).toBe('failed')
    expect(decide('fetch', 'provider-success', { status: 200, payload: { content: 'body' }, billingEvidence: { state: 'unknown' } }).outcome).toBe('unknown')
  })
  it('旧free Tavily启用Extract后按新的业务证据判定，不依赖DeepSeek正文结构', () => {
    expect(decide('fetch', 'free', { status: 200, payload: { results: [{ raw_content: 'text' }] }, billingEvidence: { state: 'success', hasContent: true } })).toMatchObject({ outcome: 'billable', hasContent: true })
    expect(decide('fetch', 'free', { status: 200, payload: {}, billingEvidence: { state: 'success', hasContent: false } })).toMatchObject({ outcome: 'empty', hasContent: false })
  })
})
