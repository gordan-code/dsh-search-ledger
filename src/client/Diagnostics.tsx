// 只读诊断：复用宿主返回的脱敏证据，不触发搜索、抓取或密钥测试。
import React, { useEffect, useState } from 'react'
import type { AttemptView, CandidateState, Operation, PluginStatus, ProviderView, WebOperationStatus } from '../contracts.ts'
import type { BillingApi } from './api.ts'
import { amount } from './api.ts'
import { SectionCard } from './components.tsx'
import { Select } from './Select.tsx'

/** 严格白名单；不包含任何可由用户、上游或凭据控制的字符串。 */
export function diagnosticExport(status: PluginStatus | null, rows: AttemptView[], truncated: boolean, context?: { operation: Operation; routeReady: boolean | null; candidates: CandidateState[] | null }) {
  const counts = { billable: 0, empty: 0, failed: 0, unknown: 0, other: 0 }
  for (const row of rows) {
    if (row.outcome === 'billable' || row.outcome === 'empty' || row.outcome === 'failed' || row.outcome === 'unknown') counts[row.outcome]++
    else counts.other++
  }
  const confirmed = (item?: WebOperationStatus): boolean | null => item?.metered ? true : item?.selectionSource === 'runtime-entry' ? false : null
  const timestamp = (value: string | null): string | null => {
    if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null
    const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : date.toISOString()
  }
  const recent = rows.slice(0, 200).map(row => ({
    operation: row.operation === 'search' || row.operation === 'fetch' ? row.operation : null,
    outcome: row.outcome === 'billable' || row.outcome === 'empty' || row.outcome === 'failed' || row.outcome === 'unknown' ? row.outcome : 'other',
    startedAt: timestamp(row.startedAt), completedAt: timestamp(row.completedAt),
    httpStatus: Number.isInteger(row.status) && row.status! >= 100 && row.status! <= 599 ? row.status : null,
  }))
  const pluginVersion = typeof status?.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,30})?$/.test(status.version) ? status.version : null
  const check = context ? { operation: context.operation === 'search' ? 'search' : 'fetch', routeReady: typeof context.routeReady === 'boolean' ? context.routeReady : null, candidates: context.candidates === null ? null : { total: context.candidates.length, ready: context.candidates.filter(item => item.credentialReady).length } } : null
  return { format: 'dsh-search-ledger-diagnostic-v1', pluginVersion, searchMetered: confirmed(status?.operations?.search), fetchMetered: confirmed(status?.operations?.fetch), statusAvailable: status !== null, check, attempts: rows.length, truncated, outcomes: counts, recent }
}

function formattedTime(value: string | null): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

function displayAmount(row: AttemptView): string {
  if (row.amountMicros == null) return '费用未确认或未知'
  try { return `${row.currency} ${amount(row.amountMicros)}（本地估算）` } catch { return '费用未知' }
}

function outcomeHint(row: AttemptView): string {
  if (row.outcome === 'unknown') return '结果未确认，服务端可能仍会计费'
  if (row.status === 401 || row.status === 403) return '认证或权限被拒绝，请检查服务商凭据和权限'
  if (row.status === 429) return '服务商限流或额度不足，请检查账户配额'
  if (row.status !== null && row.status >= 500) return '服务商返回服务器错误，可稍后重试'
  return ''
}

function duration(row: AttemptView): string {
  if (!row.completedAt) return '耗时未知'
  const elapsed = Date.parse(row.completedAt) - Date.parse(row.startedAt)
  return Number.isFinite(elapsed) && elapsed >= 0 ? `耗时 ${(elapsed / 1000).toFixed(2)} 秒` : '耗时未知'
}

export function Diagnostics({ api, status, providers }: { api: BillingApi; status: PluginStatus | null; providers: ProviderView[] }) {
  const [operation, setOperation] = useState<Operation>('search')
  const [provider, setProvider] = useState(providers[0]?.id ?? '')
  const [candidates, setCandidates] = useState<CandidateState[]>([])
  const [candidatesLoaded, setCandidatesLoaded] = useState(false)
  const [candidateNote, setCandidateNote] = useState('')
  const [rows, setRows] = useState<AttemptView[]>([])
  const [truncated, setTruncated] = useState(false)
  const [ledgerReady, setLedgerReady] = useState(false)
  const [ledgerNote, setLedgerNote] = useState('正在读取本地账本…')
  const [exportNote, setExportNote] = useState('')
  const [tick, setTick] = useState(0)
  const [currentStatus, setCurrentStatus] = useState(status)

  useEffect(() => { if (!provider && providers[0]) setProvider(providers[0].id) }, [providers, provider])
  useEffect(() => { setCurrentStatus(status) }, [status])
  useEffect(() => {
    if (tick === 0 || typeof api.getStatus !== 'function') return
    let alive = true
    Promise.resolve().then(() => api.getStatus()).then(next => { if (alive) setCurrentStatus(next) }).catch(() => { if (alive) setCurrentStatus(null) })
    return () => { alive = false }
  }, [api, tick])
  useEffect(() => {
    let alive = true
    setCandidates([]); setCandidatesLoaded(false)
    if (!api.getCandidateStates || !provider) { setCandidateNote('请选择 Provider；候选状态不可用时不会推断凭据是否有效。'); return () => { alive = false } }
    setCandidateNote('正在读取候选状态…')
    Promise.resolve().then(() => api.getCandidateStates!(operation, provider, null)).then(result => {
      if (!alive) return
      setCandidates(result); setCandidatesLoaded(true)
      setCandidateNote(result.length ? '仅检查凭据是否可读取；不验证 Key，不包含会话覆盖。' : '没有启用且支持此操作的候选渠道。')
    }).catch(() => { if (alive) setCandidateNote('候选状态暂不可读取；请检查配置和凭据服务。') })
    return () => { alive = false }
  }, [api, operation, provider, tick])
  useEffect(() => {
    let alive = true
    setLedgerReady(false); setLedgerNote('正在读取本地账本…')
    Promise.resolve().then(() => api.listAttempts({}, null, 200)).then(page => {
      if (!alive) return
      setRows(page.items); setTruncated(page.nextCursor !== null); setLedgerReady(true)
      setLedgerNote(page.items.length ? '仅显示最近 200 条已记录尝试；未记录的跳过不能推断。' : '暂无已记录尝试。')
    }).catch(() => { if (alive) { setRows([]); setLedgerNote('本地账本读取失败，无法判断是否存在请求。') } })
    return () => { alive = false }
  }, [api, tick])

  const groups = new Map<string, AttemptView[]>()
  for (const row of rows) {
    const key = row.operationId || `attempt:${row.attemptId}`
    const group = groups.get(key) ?? []
    group.push(row); groups.set(key, group)
  }
  const route = currentStatus?.routes?.find(item => item.providerId === provider)?.[operation]
  const opStatus = currentStatus?.operations?.[operation]
  const exportReport = () => {
    if (!ledgerReady || !window.confirm('导出包含插件版本、后端与自检状态、记录数量、结果统计及最近记录的操作、状态、时间与 HTTP 状态码；不包含渠道名称、Provider ID、Key 或查询内容。时间等信息仍可能敏感，请检查文件后再分享。')) return
    try {
      const content = JSON.stringify(diagnosticExport(currentStatus, rows, truncated, { operation, routeReady: route?.ready ?? null, candidates: candidatesLoaded ? candidates : null }), null, 2)
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
      try {
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'dsh-search-ledger-diagnostic.json'; anchor.rel = 'noopener'
        document.body.appendChild(anchor); anchor.click(); anchor.remove()
      } finally { setTimeout(() => URL.revokeObjectURL(url), 0) }
      setExportNote('已导出诊断文件，请检查后再分享。')
    } catch { setExportNote('无法导出诊断，请检查当前环境的下载权限。') }
  }

  return <div className="dsh-stack">
    <SectionCard title="配置自检" description="仅读取配置和凭据存在性，不发送网络请求。配置正常不代表渠道认证成功。" actions={<button type="button" onClick={() => setTick(value => value + 1)}>刷新诊断</button>}>
      <div className="dsh-filter-grid">
        <label>Provider<Select aria-label="诊断 Provider" value={provider} onValueChange={setProvider}><option value="">请选择</option>{providers.map(item => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}</Select></label>
        <label>操作<Select aria-label="诊断操作" value={operation} onValueChange={value => setOperation(value as Operation)}><option value="search">Search</option><option value="fetch">Fetch</option></Select></label>
      </div>
      <p>计量后端：{opStatus?.metered ? '已确认接管' : opStatus?.selectionSource === 'settings-only' ? '仅有配置快照，运行状态待确认' : '尚未确认接管'}</p>
      <p>默认路由：{route ? route.ready ? `已配置（${route.source}）` : route.reason || '未就绪' : '当前 Provider 的路由状态不可用'}</p>
      <p role="status">{candidateNote}</p>
      {candidates.length > 0 && <ul>{candidates.map(candidate => <li key={candidate.channelId}>{candidate.channelId}：{candidate.credentialReady ? '凭据就绪或不需要凭据' : candidate.reason || '凭据不可用'}</li>)}</ul>}
    </SectionCard>
    <SectionCard title="最近请求时间线" description="按 operationId 关联已记录尝试；耗时基于账本时间，不能推断未记录的请求。" actions={<button type="button" disabled={!ledgerReady} onClick={exportReport}>导出脱敏诊断</button>}>
      <p role="status">{ledgerNote}</p>
      {exportNote && <p role="status">{exportNote}</p>}
      {truncated && <p>记录达到上限，分组可能不完整。</p>}
      {Array.from(groups.entries()).map(([id, group]) => <details key={id} open>
        <summary>{group[0]?.operation === 'search' ? 'Search' : 'Fetch'} · {group.length} 次已记录尝试 · {formattedTime(group[0]?.startedAt ?? null)} · 来源 Provider：{group[0]?.sourceProviderId ?? '未知'}</summary>
        <ol>{[...group].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptId.localeCompare(b.attemptId)).map(row => <li key={row.attemptId}>
          <strong>{row.channelName}</strong> · {row.outcome === 'billable' ? '计费成功' : row.outcome === 'empty' ? '空结果' : row.outcome === 'failed' ? '失败' : '未确认'} · {displayAmount(row)}
          <div>{formattedTime(row.startedAt)}{row.completedAt ? ` → ${formattedTime(row.completedAt)}` : ' · 结束时间未知'} · {duration(row)}{row.status !== null ? ` · HTTP ${row.status}` : ''}</div>
          {outcomeHint(row) && <div>{outcomeHint(row)}</div>}
        </li>)}</ol>
      </details>)}
    </SectionCard>
  </div>
}
