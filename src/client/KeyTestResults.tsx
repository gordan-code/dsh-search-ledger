import React from 'react'
import type { KeyTestBatch, KeyTestState } from '../contracts.ts'
import { Badge } from './components.tsx'
const labels: Record<KeyTestState, string> = { success: '测试成功', 'auth-rejected': '认证或权限被拒绝', limited: '限流或额度限制', timeout: '超时 · 费用未确认', failed: '请求或协议失败', unknown: '结果未确认', 'not-tested': '未测试 · 已停止' }
export function KeyTestResults({ batch }: { batch: KeyTestBatch }) {
  return <div className="dsh-key-test-results" aria-label="Key测试结果" aria-live="polite">
    <strong>{batch.operation === 'search' ? 'Search' : 'Fetch'} 测试结果 · {batch.source === 'input' ? '本次输入' : '已保存池'}</strong>
    {batch.results.map(row => <div className="dsh-key-test-row" key={row.index}>
      <span>Key #{row.index}</span>
      <Badge tone={row.state === 'success' ? 'success' : row.state === 'auth-rejected' || row.state === 'failed' ? 'danger' : 'warning'}>{labels[row.state]}</Badge>
      <span className="dsh-inline-note">{row.status !== null ? `HTTP ${row.status}` : row.code === 'QUOTA_LOCAL_LIMIT' ? '本地额度保护，未派发' : row.code === 'KEY_TEST_CONFIG_CHANGED' ? '渠道配置已变更' : row.code === 'TOTAL_TIMEOUT' ? '总时间预算耗尽' : row.code === 'CANCELLED' ? '请求已取消' : row.code?.startsWith('DB_') ? '本地计量故障，已停止' : ''}</span>
    </div>)}
    <p className="dsh-inline-note">实际尝试计入当前渠道账本；限流、超时或网络错误不等于Key无效。测试不会自动保存Key。</p>
  </div>
}
