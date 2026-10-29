// 熔断与预算只读展示：数据全部来自本地账本与当前配置快照，不发起任何上游调用。
import React, { useEffect, useState } from 'react'
import type { BreakerView, BudgetState, RoutingConfig } from '../contracts.ts'
import { amount } from './api.ts'
import type { BillingApi } from './api.ts'
import { EmptyState, SectionCard } from './components.tsx'

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

function safeAmount(value: string | null | undefined): string {
  if (value == null) return '未知'
  try { return amount(value) } catch { return '未知' }
}

function windowLabel(window: 'day' | 'month'): string {
  return window === 'day' ? '自然日' : '自然月'
}

function actionLabel(action: 'warn' | 'block' | 'fallback'): string {
  if (action === 'block') return '超限后拒绝新请求'
  if (action === 'fallback') return '超限后只走免费渠道'
  return '超限后仅提示，不阻断'
}

/** 预算卡片：上限来自配置，用量来自账本终态；两者不一致时以账本为准并说明。 */
export function BudgetCard({ api, config }: { api: BillingApi; config?: RoutingConfig }) {
  const [state, setState] = useState<BudgetState | null>(null)
  const [message, setMessage] = useState('尚未读取预算用量')
  const [tick, setTick] = useState(0)
  const supported = typeof api.getBudgetState === 'function'

  useEffect(() => {
    if (!supported) { setMessage('当前宿主版本未提供预算接口'); return }
    let alive = true
    Promise.resolve().then(() => api.getBudgetState?.()).then(next => {
      if (!alive || !next) return
      setState(next)
      setMessage(next.exceeded ? '已达到预算上限' : '已读取预算用量')
    }).catch(error => {
      if (!alive) return
      setState(null)
      setMessage(error instanceof Error ? error.message : '预算用量读取失败')
    })
    return () => { alive = false }
  }, [api, supported, tick])

  return <SectionCard
    title="预算与上限"
    description="按自然日或自然月统计本地估算金额；不同币种不合并，未设置限额的币种不参与超限判定。"
    actions={<button type="button" disabled={!supported} onClick={() => setTick(value => value + 1)}>刷新预算</button>}
  >
    {!supported
      ? <EmptyState title="当前宿主未提供预算接口">升级宿主后可查看预算用量。</EmptyState>
      : !state
        ? <p className="dsh-action-note" role="status">{message}</p>
        : <div className="dsh-stack">
          <div className="dsh-status-grid">
            <div className="dsh-status-card">
              <h3>统计窗口</h3>
              <span className={`dsh-status-pill ${state.enabled ? 'dsh-status-ok' : 'dsh-status-warn'}`}>{state.enabled ? '已启用' : '未启用（仅统计）'}</span>
              <p>{windowLabel(state.window)} · {formatTime(state.windowFrom)} 起</p>
            </div>
            <div className="dsh-status-card">
              <h3>请求次数</h3>
              <span className={`dsh-status-pill ${state.exceeded ? 'dsh-status-warn' : 'dsh-status-ok'}`}>{state.requests}{state.requestLimit === null ? ' / 不限' : ` / ${state.requestLimit}`}</span>
              <p>{actionLabel(state.onExceed)}</p>
            </div>
            <div className="dsh-status-card">
              <h3>配置来源</h3>
              <span className="dsh-status-pill">{config?.budget ? '面板配置' : '默认（未启用）'}</span>
              <p>窗口结束：{formatTime(state.windowTo)}</p>
            </div>
          </div>
          {state.currencies.length === 0
            ? <EmptyState title="窗口内没有计费记录">未产生费用不代表预算充足，只代表本窗口尚无终态记录。</EmptyState>
            : <div className="dsh-table-wrap"><table>
              <thead><tr>{['币种', '已用（本地估算）', '上限', '状态'].map(value => <th key={value}>{value}</th>)}</tr></thead>
              <tbody>{state.currencies.map(row => <tr key={row.currency}>
                <td>{row.currency}</td>
                <td>{safeAmount(row.amountMicros)}</td>
                <td>{row.limit == null ? '不限' : row.limit}</td>
                <td>{row.exceeded ? '已超限' : row.limit == null ? '不受限' : '未超限'}</td>
              </tr>)}</tbody>
            </table></div>}
          <p className="dsh-action-note" role="status">{message}</p>
        </div>}
  </SectionCard>
}

/** 熔断卡片：冷却由账本终态推导，复位只写本地标记，不改变渠道配置。 */
export function BreakerCard({ api, config }: { api: BillingApi; config?: RoutingConfig }) {
  const [views, setViews] = useState<BreakerView[]>([])
  const [message, setMessage] = useState('尚未读取熔断状态')
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const supported = typeof api.listBreakerStates === 'function'

  useEffect(() => {
    if (!supported) { setMessage('当前宿主版本未提供熔断接口'); return }
    let alive = true
    Promise.resolve().then(() => api.listBreakerStates?.()).then(next => {
      if (!alive || !next) return
      setViews(next)
      const open = next.filter(item => item.open).length
      setMessage(open > 0 ? `${open} 个渠道正在冷却` : '没有渠道处于冷却')
    }).catch(error => {
      if (!alive) return
      setViews([])
      setMessage(error instanceof Error ? error.message : '熔断状态读取失败')
    })
    return () => { alive = false }
  }, [api, supported, tick])

  const reset = async (channelId: string) => {
    if (typeof api.resetBreaker !== 'function') return
    setBusy(channelId)
    try {
      const next = await api.resetBreaker(channelId)
      setViews(next)
      setMessage('已复位该渠道的冷却')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '复位失败')
    } finally {
      setBusy(null)
    }
  }

  return <SectionCard
    title="渠道熔断"
    description="连续失败达到阈值后该渠道进入冷却，冷却期内不参与故障转移；复位只清除本地标记，不会自动恢复上游可用性。"
    actions={<button type="button" disabled={!supported} onClick={() => setTick(value => value + 1)}>刷新状态</button>}
  >
    {!supported
      ? <EmptyState title="当前宿主未提供熔断接口">升级宿主后可查看渠道冷却状态。</EmptyState>
      : views.length === 0
        ? <p className="dsh-action-note" role="status">{message}</p>
        : <div className="dsh-stack">
          <div className="dsh-table-wrap"><table>
            <thead><tr>{['渠道', '状态', '窗口内失败', '冷却至', '最近失败', '操作'].map(value => <th key={value}>{value}</th>)}</tr></thead>
            <tbody>{views.map(view => {
              const channel = config?.channels.find(item => item.id === view.channelId)
              return <tr key={view.channelId}>
                <td>{channel?.name ?? view.channelName}</td>
                <td>{view.open ? '冷却中' : '正常'}</td>
                <td>{view.failures} / {view.threshold}</td>
                <td>{formatTime(view.cooldownUntil)}</td>
                <td>{formatTime(view.lastFailureAt)}</td>
                <td>{view.open
                  ? <button type="button" disabled={busy === view.channelId} onClick={() => { void reset(view.channelId) }}>复位</button>
                  : <span className="dsh-inline-note">无需复位</span>}</td>
              </tr>
            })}</tbody>
          </table></div>
          <p className="dsh-action-note" role="status">{message}</p>
        </div>}
  </SectionCard>
}
