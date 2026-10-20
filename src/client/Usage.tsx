// 只读取本地账本，刷新不会发送搜索 API；币种分别呈现。
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AttemptFilter, AttemptView, ProviderView, RoutingConfig, SummaryRow } from '../contracts.ts'
import { amount } from './api.ts'
import type { BillingApi } from './api.ts'
import { EmptyState, SectionCard } from './components.tsx'
import { Select } from './Select.tsx'

function today(): AttemptFilter {
  const from = new Date(); from.setHours(0, 0, 0, 0)
  const to = new Date(from); to.setDate(to.getDate() + 1)
  return { from: from.toISOString(), to: to.toISOString() }
}

function localInput(value: string | undefined): string {
  if (!value) return ''
  const d = new Date(value)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

function safeAmount(value: string | null | undefined): string {
  if (value == null) return '未知'
  try { return amount(value) } catch { return '未知' }
}

function latestAttempt(items: AttemptView[]): AttemptView | undefined {
  return [...items].sort((a, b) => Date.parse(b.completedAt || b.startedAt) - Date.parse(a.completedAt || a.startedAt))[0]
}

export function Usage({ api, config, providers }: { api: BillingApi; config?: RoutingConfig; providers: ProviderView[] }) {
  const [filter, setFilter] = useState<AttemptFilter>(today)
  const [rows, setRows] = useState<SummaryRow[]>([])
  const [attempts, setAttempts] = useState<AttemptView[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [message, setMessage] = useState('尚未读取本地账本')
  const [refreshTick, setRefreshTick] = useState(0)
  const requestRef = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // 账本在此面板中只读。宿主窗口恢复活动时刷新本地数据，不发起搜索/抓取调用，也不启动后台轮询。
  useEffect(() => {
    const refreshOnReturn = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') setRefreshTick(value => value + 1)
    }
    window.addEventListener('focus', refreshOnReturn)
    document.addEventListener('visibilitychange', refreshOnReturn)
    return () => {
      window.removeEventListener('focus', refreshOnReturn)
      document.removeEventListener('visibilitychange', refreshOnReturn)
    }
  }, [])

  const filterKey = JSON.stringify(filter)
  useEffect(() => {
    const request = ++requestRef.current
    let alive = true
    setState('loading')
    setMessage('正在读取本地账本…')
    setRows([])
    setAttempts([])
    const summaryPromise = Promise.resolve().then(() => api.getSummary(filter))
    const attemptsPromise = typeof api.listAttempts === 'function'
      ? Promise.resolve().then(() => api.listAttempts(filter, null, 12)).then(page => page.items)
      : Promise.resolve([] as AttemptView[])
    Promise.allSettled([summaryPromise, attemptsPromise]).then(([summaryResult, attemptsResult]) => {
      if (!alive || !mounted.current || request !== requestRef.current) return
      if (summaryResult.status === 'rejected') throw summaryResult.reason
      const summary = summaryResult.value
      const recent = attemptsResult.status === 'fulfilled' ? attemptsResult.value : []
      setRows(summary)
      setAttempts(recent)
      setState('ready')
      setMessage(summary.length ? attemptsResult.status === 'fulfilled' ? '已读取本地账本' : '已读取本地账本；最近调用元数据暂不可用' : '筛选范围内暂无记录')
    }).catch(error => {
      if (!alive || !mounted.current || request !== requestRef.current) return
      setRows([])
      setAttempts([])
      setState('error')
      setMessage(error instanceof Error ? error.message : '账本读取失败，请检查服务状态')
    })
    return () => { alive = false }
  }, [api, filterKey, refreshTick])

  const set = (key: keyof AttemptFilter, value: string) => setFilter(previous => ({ ...previous, [key]: value || undefined }))
  const latest = latestAttempt(attempts)
  const totals = useMemo(() => {
    const grouped = new Map<string, { knownAmount: bigint; hasKnownAmount: boolean; unknownPriceCount: number; unconfirmedCount: number; amountMissingCount: number; attempts: number }>()
    for (const row of rows) {
      const current = grouped.get(row.currency) ?? { knownAmount: 0n, hasKnownAmount: false, unknownPriceCount: 0, unconfirmedCount: 0, amountMissingCount: 0, attempts: 0 }
      let amountParsed = false
      if (row.amountMicros != null) {
        try {
          current.knownAmount += BigInt(row.amountMicros)
          current.hasKnownAmount = true
          amountParsed = true
        } catch { /* 无法解析的账目金额不能计入已知金额。 */ }
      }
      current.unknownPriceCount += row.priceUnknown
      current.unconfirmedCount += row.unknown
      if (!amountParsed && row.priceUnknown === 0) current.amountMissingCount += row.total
      current.attempts += row.total
      grouped.set(row.currency, current)
    }
    return Array.from(grouped.entries())
  }, [rows])
  const channelLabel = (id: string, fallbackName?: string): string => {
    const channel = config?.channels.find(item => item.id === id)
    return channel ? `${channel.name}${channel.archived ? '（已归档）' : ''}` : (fallbackName || id)
  }

  return <div className="dsh-stack">
    <SectionCard title="用量与费用" description="自动读取本地账本，筛选条件变化后重新读取。不同币种不合并；未知价格不会被当作免费。credits 仅为本地预留，不等于服务商实际 usage。" actions={<button type="button" onClick={() => setRefreshTick(value => value + 1)}>刷新本地账本</button>}>
      <div className="dsh-filter-grid">
        <label>开始（含）<input type="datetime-local" value={localInput(filter.from)} onChange={event => set('from', event.target.value ? new Date(event.target.value).toISOString() : '')} /></label>
        <label>结束（不含）<input type="datetime-local" value={localInput(filter.to)} onChange={event => set('to', event.target.value ? new Date(event.target.value).toISOString() : '')} /></label>
        <label>渠道<Select aria-label="筛选渠道" value={filter.channelId ?? ''} onValueChange={value => set('channelId', value)}><option value="">全部渠道</option>{config?.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}{channel.archived ? '（已归档）' : ''}</option>)}</Select></label>
        <label>来源 provider<Select aria-label="筛选来源provider" value={filter.sourceProviderId ?? ''} onValueChange={value => set('sourceProviderId', value)}><option value="">全部 Provider</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select></label>
        <label>会话 ID<input value={filter.sessionId ?? ''} onChange={event => set('sessionId', event.target.value)} /></label>
        <label>币种<Select aria-label="筛选币种" value={filter.currency ?? ''} onValueChange={value => set('currency', value as 'CNY' | 'USD' | '')}><option value="">全部币种</option><option>CNY</option><option>USD</option></Select></label>
      </div>
      <p className="dsh-action-note" role="status">{message}</p>
    </SectionCard>

    {state === 'error' ? <div className="dsh-alert" role="alert">{message}</div> : state === 'loading' && rows.length === 0 ? <EmptyState title="正在读取本地账本">筛选条件不会触发网络搜索，只读取本地计量记录。</EmptyState> : rows.length === 0 && state === 'ready' ? <EmptyState title="筛选范围内暂无记录">空结果不等于免费；请调整时间、渠道或币种后重试。</EmptyState> : <>
      {totals.length > 0 && <div className="dsh-summary-grid">{totals.map(([currency, total]) => {
        const notes = [
          total.unconfirmedCount > 0 ? `未确认 ${total.unconfirmedCount} 次` : '',
          total.unknownPriceCount > 0 ? `未知价格 ${total.unknownPriceCount} 次` : '',
          total.amountMissingCount > 0 ? `金额未估算 ${total.amountMissingCount} 次` : '',
        ].filter(Boolean)
        return <div className="dsh-summary-card" key={currency}><strong>{currency} {total.hasKnownAmount ? `已知 ${safeAmount(total.knownAmount.toString())}` : '已知金额暂无'}</strong><span>{total.attempts} 次尝试 · {notes.length > 0 ? `${notes.join(' · ')} · 总额不完整` : '已知本地估算'}</span></div>
      })}</div>}
      <div className="dsh-table-wrap"><table><thead><tr>{['渠道', '操作', '计费成功', '空结果', '失败', '未确认', '未知价格', '本地估算费用', '本地预留 credits'].map(value => <th key={value}>{value}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={`${row.channelId}-${row.operation}-${row.currency}-${i}`}><td>{channelLabel(row.channelId, row.channelName)}</td><td>{row.operation}</td><td>{row.billable}</td><td>{row.empty}</td><td>{row.failed}</td><td>{row.unknown}</td><td>{row.priceUnknown}</td><td>{row.currency} {safeAmount(row.amountMicros)}{row.priceUnknown > 0 && <span className="dsh-inline-note">（含未知）</span>}</td><td>{row.quotaCredits}</td></tr>)}</tbody></table></div>
    </>}

    <SectionCard title="最近调用元数据" description="仅显示时间、操作、渠道和结果状态，不显示请求正文、查询词或凭证；operationId 可用于关联同一次故障转移接力。">
      {!latest ? <EmptyState title="暂无最近调用">当本地账本有记录时，这里会显示最近一次调用的时间。</EmptyState> : <div className="dsh-recent-list"><div className="dsh-recent-item"><strong>{channelLabel(latest.channelId)} · {latest.operation}</strong><span className="dsh-recent-meta">{formatTime(latest.completedAt || latest.startedAt)} · 结果：{latest.outcome} · HTTP {latest.status ?? '未知'}{latest.sourceProviderId ? ` · provider ${latest.sourceProviderId}` : ''}{latest.operationId ? <> · operationId <code>{latest.operationId}</code></> : ''}</span></div></div>}
    </SectionCard>
  </div>
}
