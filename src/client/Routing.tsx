// Search 与 Fetch 始终独立选择，空选项表示继承；会话覆盖使用独立 revision。
import React, { useEffect, useRef, useState } from 'react'
import type { CandidateState, Operation, PluginStatus, ProviderView, RoutingConfig, SessionOverrides } from '../contracts.ts'
import type { EditorProps } from './Channels.tsx'
import type { BillingApi } from './api.ts'
import { Badge, EmptyState, RouteBadge, SectionCard } from './components.tsx'
import { DEFAULT_FAILOVER_SETTINGS, FailoverEditor, type FailoverMap } from './Failover.tsx'
import { Select } from './Select.tsx'

const operations: Operation[] = ['search', 'fetch']

function operationLabel(operation: Operation): string { return operation === 'search' ? 'Search' : 'Fetch' }

function providerRoute(status: PluginStatus | undefined, providerId: string, operation: Operation) {
  return status?.routes?.find(route => route.providerId === providerId)?.[operation]
}

function failoverSettings(config: RoutingConfig): FailoverMap {
  return {
    search: { ...DEFAULT_FAILOVER_SETTINGS, ...(config.failover?.search ?? {}) },
    fetch: { ...DEFAULT_FAILOVER_SETTINGS, ...(config.failover?.fetch ?? {}) },
  }
}

export function Routing({ config, providers, status, api, revision, writable, save }: EditorProps & { providers: ProviderView[]; status?: PluginStatus; api: BillingApi }) {
  const [bindings, setBindings] = useState(() => structuredClone(config.providerBindings))
  const [global, setGlobal] = useState(() => structuredClone(config.globalOverrides))
  const [failover, setFailover] = useState<FailoverMap>(() => failoverSettings(config))
  const [sessionId, setSessionId] = useState('')
  const [session, setSession] = useState<SessionOverrides | null>(null)
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [sessionSaving, setSessionSaving] = useState(false)
  const [candidateOperation, setCandidateOperation] = useState<Operation>('search')
  const [candidateProvider, setCandidateProvider] = useState('')
  const [candidateStates, setCandidateStates] = useState<CandidateState[]>([])
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [candidateMessage, setCandidateMessage] = useState('')
  const revisionRef = useRef(revision)
  const dirtyRef = useRef(false)
  const snapshotKey = useRef(JSON.stringify({ revision, bindings: config.providerBindings, global: config.globalOverrides, failover: config.failover }))
  const mounted = useRef(true)
  const sessionRequest = useRef(0)
  const candidateRequest = useRef(0)
  const sessionMutation = useRef(0)
  const sessionSavingRef = useRef(false)
  const savingRef = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    candidateRequest.current += 1
    setCandidateStates([])
    setCandidateLoading(false)
    setCandidateMessage('')
  }, [config, revision, candidateOperation, candidateProvider, sessionId, session?.revision])
  useEffect(() => {
    const key = JSON.stringify({ revision, bindings: config.providerBindings, global: config.globalOverrides, failover: config.failover })
    if (key === snapshotKey.current) return
    snapshotKey.current = key
    if (dirtyRef.current) {
      setMessage('路由配置已在其他页面更新；当前未保存编辑已保留，请先保存或重新打开面板。')
      return
    }
    revisionRef.current = revision
    setBindings(structuredClone(config.providerBindings))
    setGlobal(structuredClone(config.globalOverrides))
    setFailover(failoverSettings(config))
  }, [config, revision])

  const markDirty = () => {
    if (savingRef.current) return false
    dirtyRef.current = true
    setDirty(true)
    return true
  }
  const changeFailover = (operation: Operation, patch: Partial<typeof failover.search>) => {
    if (!markDirty()) return
    setFailover(previous => ({ ...previous, [operation]: { ...previous[operation], ...patch } }))
  }
  const operationChannels = (operation: Operation) => config.channels.filter(channel => !channel.archived && channel.capabilities.includes(operation))
  const select = (operation: Operation, value: string | null | undefined, change: (id: string | null) => void, sessionEdit = false) => <Select className="dsh-route-select" aria-label={`${operation}渠道`} value={value ?? ''} disabled={!writable || saving || (sessionEdit && sessionSaving)} onValueChange={next => { if (sessionEdit) { if (!savingRef.current && !sessionSavingRef.current) change(next || null) } else if (markDirty()) change(next || null) }}>
    <option value="">跟随／继承</option>
    {operationChannels(operation).map(channel => <option key={channel.id} value={channel.id} disabled={!channel.enabled}>{channel.name}{!channel.enabled ? ' · 未启用，请先启用并保存' : ''}（{channel.id}）</option>)}
  </Select>

  const saveRouting = () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setMessage('')
    let request: Promise<number>
    try {
      for (const item of Object.values(failover)) {
        if (!Number.isSafeInteger(item.attemptTimeoutMs) || item.attemptTimeoutMs < 1 || item.attemptTimeoutMs > 30000 || !Number.isSafeInteger(item.totalTimeoutMs) || item.totalTimeoutMs < 1 || item.totalTimeoutMs > 300000) throw new Error('超时预算超出允许范围：单项0.001–30秒，总预算0.001–300秒')
      }
      const patch: Partial<RoutingConfig> = { providerBindings: bindings, globalOverrides: global }
      // 老配置没有 failover 时保持真正的旧写入形状；只有用户改动故障转移或已有配置时才写入该字段。
      if (config.failover !== undefined || JSON.stringify(failover) !== JSON.stringify(failoverSettings(config))) patch.failover = failover
      request = save(patch, revisionRef.current)
    } catch (error) {
      savingRef.current = false
      if (mounted.current) {
        setSaving(false)
        setMessage(error instanceof Error ? error.message : '操作失败，配置未改变')
      }
      return
    }
    void Promise.resolve(request).then(nextRevision => {
      revisionRef.current = nextRevision
      dirtyRef.current = false
      setDirty(false)
      if (mounted.current) setMessage('操作成功')
    }).catch(error => {
      if (mounted.current) setMessage(error instanceof Error ? error.message : '操作失败，配置未改变')
    }).finally(() => {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    })
  }
  const providerEntries = Array.from(new Map([
    ...providers.map(provider => [provider.id, provider] as const),
    ...Object.keys(bindings).filter(id => !providers.some(provider => provider.id === id)).map(id => [id, { id, name: `${id}（当前离线）` }] as const),
    ...(status?.routes ?? []).filter(route => !providers.some(provider => provider.id === route.providerId)).map(route => [route.providerId, { id: route.providerId, name: `${route.providerId}（状态报告）` }] as const),
  ]).values())

  const previewCandidates = () => {
    if (!api.getCandidateStates) {
      setCandidateMessage('当前宿主不支持候选预览；不会发起搜索测试。')
      return
    }
    const request = ++candidateRequest.current
    setCandidateLoading(true)
    setCandidateMessage('正在读取候选引用状态…')
    setCandidateStates([])
    Promise.resolve().then(() => api.getCandidateStates!(candidateOperation, candidateProvider || null, sessionId.trim() || null)).then(next => {
      if (!mounted.current || request !== candidateRequest.current) return
      setCandidateStates(next)
      setCandidateMessage('候选顺序已读取；就绪状态仅代表引用可读，不代表认证已验证。')
    }).catch(error => {
      if (mounted.current && request === candidateRequest.current) setCandidateMessage(error instanceof Error ? error.message : '候选预览读取失败')
    }).finally(() => {
      if (mounted.current && request === candidateRequest.current) setCandidateLoading(false)
    })
  }

  const loadSession = () => {
    const id = sessionId.trim()
    if (!id) return
    const request = ++sessionRequest.current
    setLoadingSession(true)
    setMessage('')
    Promise.resolve().then(() => api.getSessionOverride(id)).then(next => {
      if (mounted.current && request === sessionRequest.current) setSession(next)
    }).catch(error => {
      if (mounted.current && request === sessionRequest.current) setMessage(error instanceof Error ? error.message : '读取会话覆盖失败')
    }).finally(() => {
      if (mounted.current && request === sessionRequest.current) setLoadingSession(false)
    })
  }
  const updateSession = (operation: Operation, id: string | null) => {
    if (!session || sessionSavingRef.current || savingRef.current) return
    const expectedRevision = session.revision
    const request = ++sessionMutation.current
    sessionSavingRef.current = true
    setSessionSaving(true); setMessage('')
    const selectedSession = sessionId.trim()
    void Promise.resolve().then(() => api.setSessionOverride(selectedSession, operation, id, expectedRevision)).then(next => {
      if (mounted.current && request === sessionMutation.current) { setSession(next); setMessage('会话覆盖已更新') }
    }).catch(error => {
      if (mounted.current && request === sessionMutation.current) setMessage(error instanceof Error ? error.message : '会话覆盖更新失败')
    }).finally(() => {
      if (request === sessionMutation.current) { sessionSavingRef.current = false; if (mounted.current) setSessionSaving(false) }
    })
  }

  return <div className="dsh-stack">
    <SectionCard title="路由与覆盖" description="Search 与 Fetch 分开决策。未启用渠道会列出但不可选，请在渠道管理中启用并保存；千帆仅支持Search。会话覆盖优先于全局覆盖，再落到provider绑定；配置不代表凭证已验证或原生后端已接管。" actions={dirty ? <Badge tone="warning">有未保存编辑</Badge> : undefined}>
      <div className="dsh-route-grid">
        <div className="dsh-route-card">
          <div className="dsh-route-card-header"><div><h3>全局覆盖</h3><p>所有未被会话覆盖的请求</p></div><Badge tone="neutral">配置意向</Badge></div>
          {operations.map(operation => <div className="dsh-route-row" key={`global-${operation}`}>
            <span className="dsh-route-operation">{operationLabel(operation)}</span>
            <div>{select(operation, global[operation], id => setGlobal(previous => ({ ...previous, [operation]: id })))}</div>
            <span className="dsh-route-effective">{global[operation] ? `覆盖渠道：${global[operation]}` : '继承 provider 绑定'}</span>
          </div>)}
        </div>
        {providerEntries.length === 0 ? <EmptyState title="暂无 Provider">状态或配置中还没有可展示的 provider 绑定。</EmptyState> : providerEntries.map(provider => <div className="dsh-route-card" key={provider.id}>
          <div className="dsh-route-card-header"><div><h3>{provider.name}</h3><p><code>{provider.id}</code></p></div><Badge tone="neutral">Provider 绑定</Badge></div>
          {operations.map(operation => {
            const actual = providerRoute(status, provider.id, operation)
            return <div className="dsh-route-row" key={`${provider.id}-${operation}`}>
              <span className="dsh-route-operation">{operationLabel(operation)}</span>
              <div>{select(operation, bindings[provider.id]?.[operation], id => setBindings(previous => { const next = { ...previous }; const entry = { ...(next[provider.id] ?? {}) }; if (id) entry[operation] = id; else delete entry[operation]; if (Object.keys(entry).length) next[provider.id] = entry; else delete next[provider.id]; return next }))}</div>
              <span className="dsh-route-effective">{actual ? <><RouteBadge ready={actual.ready} reason={actual.reason} />{actual.channelId && <span> · {actual.channelId}</span>}</> : '尚无运行时状态证据'}</span>
            </div>
          })}
        </div>)}
      </div>
      <FailoverEditor settings={failover} writable={writable} saving={saving} onChange={changeFailover} />
      <div className="dsh-candidate-preview">
        <div className="dsh-route-card-header"><div><h3>候选顺序预览</h3><p>只读取已保存配置与凭证就绪状态，不包含未保存编辑；不会发起搜索测试或抓取测试请求，也不会回显凭证。</p></div><Badge tone="neutral">预览</Badge></div>
        <div className="dsh-form-row">
          <label>候选预览操作<Select aria-label="候选预览操作" value={candidateOperation} disabled={saving || candidateLoading} onValueChange={value => { setCandidateOperation(value as Operation); setCandidateStates([]) }}><option value="search">Search</option><option value="fetch">Fetch</option></Select></label>
          <label>候选预览 Provider<Select aria-label="候选预览 Provider" value={candidateProvider} disabled={saving || candidateLoading} onValueChange={value => { setCandidateProvider(value); setCandidateStates([]) }}><option value="">无绑定（按全局/配置顺序）</option>{providerEntries.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select></label>
          <button type="button" disabled={saving || candidateLoading || !api.getCandidateStates} onClick={previewCandidates}>{candidateLoading ? '读取中…' : '预览候选顺序'}</button>
        </div>
        {candidateMessage && <p className="dsh-action-note" role="status">{candidateMessage}</p>}
        {candidateStates.length > 0 && <ol className="dsh-candidate-list">{candidateStates.map((candidate, index) => <li key={`${candidate.channelId}-${index}`}><strong>#{index + 1} {candidate.channelId}</strong><span>{candidate.capabilities.map(operation => operationLabel(operation)).join(' / ')}</span><Badge tone={candidate.credentialReady ? 'success' : 'warning'}>{candidate.credentialReady ? '凭证引用可读' : candidate.reason || '未就绪'}</Badge></li>)}</ol>}
      </div>
      <div className="dsh-toolbar" style={{ marginTop: 14 }}><span className="dsh-toolbar-spacer" /><button className="dsh-button-primary" type="button" disabled={!writable || saving} onClick={saveRouting}>保存绑定与全局覆盖</button></div>
    </SectionCard>

    <SectionCard title="会话覆盖" description="按会话读取并单独写入 Search / Fetch 覆盖；只传会话 ID，不读取会话正文。" className="dsh-session-box">
      <div className="dsh-toolbar"><label>会话 ID <input value={sessionId} onChange={event => { sessionRequest.current += 1; sessionMutation.current += 1; sessionSavingRef.current = false; setSessionSaving(false); setSessionId(event.target.value); setSession(null); setLoadingSession(false) }} /></label><button type="button" disabled={!sessionId.trim() || loadingSession || sessionSaving} onClick={loadSession}>{loadingSession ? '读取中…' : '读取会话覆盖'}</button></div>
      {session && <div className="dsh-session-result">
        <p className="dsh-inline-note">会话 revision：<code>{session.revision}</code>；修改会立即进行 revision fencing。</p>
        {operations.map(operation => <div className="dsh-route-row" key={`session-${operation}`}>
          <span className="dsh-route-operation">{operationLabel(operation)}</span>
          <div>{select(operation, session[operation], id => updateSession(operation, id), true)}</div>
          <span className="dsh-route-effective">{session[operation] ? `会话覆盖：${session[operation]}` : '不覆盖，继续继承'}</span>
        </div>)}
      </div>}
      {message && <p className="dsh-action-note" role="status">{message}</p>}
    </SectionCard>
  </div>
}
