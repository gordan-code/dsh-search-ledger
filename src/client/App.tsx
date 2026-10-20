import React, { useEffect, useState } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RoutingConfig, ProviderView, PluginStatus, WebOperationStatus } from '../contracts.ts'
import type { BillingApi } from './api.ts'
import { Channels } from './Channels.tsx'
import { Routing } from './Routing.tsx'
import { Usage } from './Usage.tsx'
import { parseRoutingConfig } from '../config-schema.ts'
import { Badge } from './components.tsx'
import billingStyles from './styles.ts'

export interface AppProps {
  api: BillingApi
  form: ConfigForm<RoutingConfig>
  /** 本地预览可选择初始面板，但不会修改宿主状态。 */
  initialTab?: number
}

function operationLabel(operation: 'search' | 'fetch'): string {
  return operation === 'search' ? 'Search' : 'Fetch'
}

function statusTime(value: string | null | undefined): string {
  if (!value) return '暂无时间证据'
  const time = new Date(value)
  return Number.isNaN(time.valueOf()) ? '时间未知' : time.toLocaleString()
}

function selectionLabel(source: WebOperationStatus['selectionSource'] | undefined): string {
  if (source === 'runtime-entry') return '运行时 entry'
  if (source === 'settings-only') return '仅配置快照'
  return '待核实'
}

function StatusOverview({ status }: { status: PluginStatus | null }) {
  if (!status) return <div className="dsh-status-grid" aria-label="计费接入状态加载中"><div className="dsh-status-card"><p>正在读取接入状态…</p></div></div>
  const active = status.active
  const operations = status.operations
  const issueList = status.issues ?? []
  return <div className="dsh-stack">
    <div className="dsh-status-grid" aria-label="计费接入状态">
      <div className="dsh-status-card">
        <h3>插件状态</h3>
        <span className={`dsh-status-pill ${active ? 'dsh-status-ok' : 'dsh-status-warn'}`}>{active ? '已启用' : '未启用'}</span>
        <p>{status.coverage || '当前配置未提供覆盖范围'}</p>
      </div>
      {(['search', 'fetch'] as const).map(operation => {
        const item = operations?.[operation]
        return <div className="dsh-status-card" key={operation}>
          <h3>{operationLabel(operation)}</h3>
          <span className={`dsh-status-pill ${item?.metered ? 'dsh-status-ok' : 'dsh-status-warn'}`}>{item?.metered ? '路由已配置到计量后端' : selectionLabel(item?.selectionSource)}</span>
          <p>{item?.providerId ? `目标 provider：${item.providerId}` : '没有可确认的后端配置'}{item?.available === false ? ' · 当前不可用' : ''}</p>
        </div>
      })}
      <div className="dsh-status-card">
        <h3>账本证据</h3>
        <span className={`dsh-status-pill ${status.totalAttempts ? 'dsh-status-ok' : 'dsh-status-warn'}`}>{status.totalAttempts ? `${status.totalAttempts} 次尝试` : '暂无记录'}</span>
        <p>最近记录：{statusTime(status.lastAttemptAt)}</p>
      </div>
    </div>
    {(status.configError || issueList.length > 0) && <div className="dsh-alert" role="alert">
      {status.configError && <div>{status.configError}</div>}
      {issueList.map(issue => <div key={issue}>{issue}</div>)}
    </div>}
  </div>
}

export function App({ api, form, initialTab = 0 }: AppProps) {
  const [tab, setTab] = useState(() => Math.max(0, Math.min(2, initialTab)))
  const [snapshot, setSnapshot] = useState(() => form.getSnapshot())
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [status, setStatus] = useState<PluginStatus | null>(null)
  const [error, setError] = useState('')

  useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])
  useEffect(() => {
    let alive = true
    setError('')
    Promise.all([Promise.resolve().then(() => api.getStatus()), Promise.resolve().then(() => api.listProviders())]).then(([nextStatus, nextProviders]) => {
      if (!alive) return
      setStatus(nextStatus)
      setProviders(nextProviders)
    }).catch(error => {
      if (!alive) return
      setError(error instanceof Error ? error.message : '无法读取计费服务，请检查插件接入状态')
    })
    return () => { alive = false }
  }, [api, snapshot.revision])

  const config = snapshot.value
  const save = async (patch: Partial<RoutingConfig>, revision: number | undefined) => {
    if (revision === undefined) throw new Error('配置尚未加载')
    if (!config) throw new Error('配置尚未加载')
    parseRoutingConfig({ ...config, ...patch })
    const ok = await form.mutate(Object.entries(patch).map(([key, value]) => ({ op: 'set' as const, path: [key], value: JSON.parse(JSON.stringify(value)) })), revision)
    if (!ok) throw new Error('配置保存被拒绝或已被其他页面修改，请重新加载后编辑')
    const latest = form.getSnapshot().revision
    if (latest === undefined) throw new Error('保存后版本尚未读取，请重新打开面板')
    return latest
  }

  const tabLabels = ['渠道管理', 'Provider 与覆盖', '用量与费用']
  return <>
    <style dangerouslySetInnerHTML={{ __html: billingStyles }} />
    <section className="dsh-web-billing">
      <header className="dsh-header">
        <div className="dsh-header-copy">
          <div className="dsh-eyebrow">DSH native web</div>
          <h1>DSH 搜索账本</h1>
          <p className="dsh-subtitle">配置 Search / Fetch 的实际接入路径，保留本地计量证据；费用仅代表本插件可观测范围。</p>
        </div>
        <Badge tone={status?.active ? 'success' : status ? 'warning' : 'neutral'}>{status?.active ? '运行中' : status ? '需要检查' : '读取中'}</Badge>
      </header>
      <StatusOverview status={status} />
      {error && <div className="dsh-alert" role="alert">{error}</div>}
      <div className="dsh-notice dsh-guidance">
        <strong>接入前请按顺序完成</strong>
        <ol>
          <li>在宿主 Web 工具后端选择 <code>web-search-metered</code> / <code>web-fetch-metered</code>。</li>
          <li>在本页 Provider 绑定中分别选择 Search / Fetch 渠道。</li>
          <li>保存后再发起一次原生调用，用量页以本地账本确认结果。</li>
        </ol>
        <span>仅统计经本插件执行的请求；只有成功写入本地账本的记录才会进入费用估算。</span>
        <span>本页不会静默选择收费渠道；配置状态不等于调用成功。</span>
      </div>
      <nav className="dsh-tabs" aria-label="搜索插件面板" role="tablist">
        {tabLabels.map((label, i) => <button key={label} className="dsh-tab" type="button" aria-selected={tab === i} onClick={() => setTab(i)}>{label}</button>)}
      </nav>
      {!config ? <div className="dsh-empty"><strong>正在读取配置</strong><span>如持续不可用，请检查 Host 的 web-search-billing 配置入口。</span></div> : <>
        {tab === 0 && <Channels api={api} config={config} revision={snapshot.revision} writable={snapshot.writable} save={save} />}
        {tab === 1 && <Routing config={config} providers={providers} status={status ?? undefined} api={api} revision={snapshot.revision} writable={snapshot.writable} save={save} />}
        {tab === 2 && <Usage api={api} config={config} providers={providers} />}
      </>}
    </section>
  </>
}
