// Key通过独立宿主接口设置，永不混入渠道配置；新增渠道不会自动收费。
import React, { useEffect, useRef, useState } from 'react'
import type { Channel, ChannelState, ChannelCredentialState, RoutingConfig } from '../contracts.ts'
import type { BillingApi } from './api.ts'
import { Badge, EmptyState, SectionCard } from './components.tsx'
import { ChannelCredential } from './ChannelCredential.tsx'
import { Select } from './Select.tsx'

type ChannelApi = BillingApi & {
  listChannelStates?: () => Promise<ChannelState[]>
  deleteChannel?: (id: string, expectedRevision: number) => Promise<number>
}

export interface EditorProps {
  config: RoutingConfig
  revision: number | undefined
  writable: boolean
  save(patch: Partial<RoutingConfig>, revision: number | undefined): Promise<number>
  api?: BillingApi
}

const channelKinds: Channel['kind'][] = ['deepseek-api', 'searxng', 'tavily', 'local-http', 'tinyfish', 'qianfan']
const channelKindLabels: Record<Channel['kind'], string> = {
  'deepseek-api': 'DeepSeek API / 中转', searxng: 'SearXNG 自建搜索', tavily: 'Tavily 搜索', 'local-http': '本地 HTTP 抓取',
  tinyfish: 'TinyFish Search / Fetch', qianfan: '百度千帆 Search',
}
const operations: Channel['capabilities'][number][] = ['search', 'fetch']
const savingBusyId = '__saving__'

function cloneChannels(channels: Channel[]): Channel[] {
  return structuredClone(channels)
}

function stateTone(state: ChannelState | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (!state) return 'neutral'
  if (state.canDelete && !state.used && (state.references ?? []).length === 0) return 'success'
  return state.reason || (state.references ?? []).length > 0 ? 'warning' : 'neutral'
}

function makeChannel(kind: Channel['kind']): Channel {
  const id = `${kind}-${Date.now().toString(36)}`
  const fetchOnly = kind === 'local-http'
  const paid = kind === 'deepseek-api'
  const service = kind === 'tinyfish' || kind === 'qianfan'
  const tavily = kind === 'tavily'
  const price = {
    perThousand: paid || service || tavily ? null : '0', currency: 'CNY' as const,
    policy: paid ? 'official-nonempty' as const : service || tavily ? 'provider-success' as const : 'free' as const,
  }
  const capabilities: Channel['capabilities'] = fetchOnly ? ['fetch'] : kind === 'qianfan' ? ['search'] : paid || tavily || kind === 'tinyfish' ? ['search', 'fetch'] : ['search']
  const endpointBase = kind === 'tavily' ? 'https://api.tavily.com'
    : kind === 'tinyfish' ? 'https://api.search.tinyfish.ai'
      : kind === 'qianfan' ? 'https://qianfan.baidubce.com/v2/ai_search/web_search'
        : kind === 'local-http' ? '' : 'https://请填写实例地址'
  const credentialRef = paid ? 'RELAY_API_KEY' : tavily ? 'TAVILY_API_KEY' : kind === 'tinyfish' ? 'TINYFISH_API_KEY' : kind === 'qianfan' ? 'QIANFAN_API_KEY' : undefined
  const prices: Channel['prices'] = {}
  for (const operation of capabilities) prices[operation] = { ...price }
  return {
    id, name: id, kind, billingClass: paid ? 'relay' : service || tavily ? 'service' : 'free', enabled: false,
    endpointBase, ...(credentialRef ? { credentialRef } : {}), capabilities, prices,
    ...(tavily ? { monthlyCredits: 1000 } : {}),
  }
}

function isCredentialChannel(kind: Channel['kind']): boolean {
  return kind === 'deepseek-api' || kind === 'tavily' || kind === 'tinyfish' || kind === 'qianfan'
}

function freeTavilyFetchPrice(): NonNullable<Channel['prices']['fetch']> {
  return { perThousand: '0', currency: 'CNY', policy: 'free' }
}

export function Channels({ config, revision, writable, save, api }: EditorProps) {
  const channelApi = api as ChannelApi | undefined
  const [items, setItems] = useState<Channel[]>(() => cloneChannels(config.channels))
  const [states, setStates] = useState<Record<string, ChannelState>>({})
  const [stateLoading, setStateLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [stateError, setStateError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [newKind, setNewKind] = useState<Channel['kind']>('deepseek-api')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [credentialEpoch, setCredentialEpoch] = useState(0)
  const [credentialStates, setCredentialStates] = useState<Record<string, ChannelCredentialState | null>>({})
  const busyRef = useRef<string | null>(null)
  const savedIds = useRef(new Set(config.channels.map(channel => channel.id)))
  const revisionRef = useRef(revision)
  const dirtyRef = useRef(false)
  const mounted = useRef(true)
  const externalKey = useRef(JSON.stringify({ revision, channels: config.channels }))
  const stateRequest = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refreshStates = () => {
    if (!channelApi?.listChannelStates) return
    const request = ++stateRequest.current
    setStateLoading(true)
    setStateError('')
    Promise.resolve().then(() => channelApi.listChannelStates!()).then(next => {
      if (!mounted.current || request !== stateRequest.current) return
      setStates(Object.fromEntries(next.map(state => [state.id, state])))
    }).catch(error => {
      if (!mounted.current || request !== stateRequest.current) return
      setStateError(error instanceof Error ? error.message : '无法读取渠道使用状态')
    }).finally(() => {
      if (mounted.current && request === stateRequest.current) setStateLoading(false)
    })
  }

  useEffect(() => { refreshStates() }, [api, revision])

  // 干净编辑器跟随宿主最新快照；脏编辑器不被新快照静默替换，需由用户处理冲突。
  useEffect(() => {
    const key = JSON.stringify({ revision, channels: config.channels })
    if (key === externalKey.current) return
    externalKey.current = key
    if (dirtyRef.current) {
      setMessage('配置已在其他页面更新；当前未保存编辑已保留，请先保存或重新打开面板。')
      return
    }
    revisionRef.current = revision
    setItems(cloneChannels(config.channels))
    savedIds.current = new Set(config.channels.map(channel => channel.id))
  }, [config, revision])

  const markDirty = () => { dirtyRef.current = true; setDirty(true) }
  const change = (id: string, patch: Partial<Channel>) => {
    if (busyRef.current) return
    markDirty()
    setItems(previous => previous.map(value => value.id === id ? { ...value, ...patch } : value))
  }
  const changePrice = (channel: Channel, operation: Channel['capabilities'][number], patch: Partial<NonNullable<Channel['prices'][typeof operation]>>) => {
    const current = channel.prices[operation]
    if (!current) return
    change(channel.id, { prices: { ...channel.prices, [operation]: { ...current, ...patch } } })
  }
  const toggleTavilyFetch = (channel: Channel, enabled: boolean) => {
    if (channel.kind !== 'tavily' || channel.billingClass !== 'free') return
    const capabilities = enabled
      ? Array.from(new Set([...channel.capabilities, 'fetch'])) as Channel['capabilities']
      : channel.capabilities.filter(operation => operation !== 'fetch')
    const prices = { ...channel.prices }
    if (enabled) prices.fetch = freeTavilyFetchPrice()
    else delete prices.fetch
    change(channel.id, { capabilities, prices })
  }
  const moveChannel = (id: string, direction: -1 | 1) => {
    if (busyRef.current) return
    const visibleIds = items.filter(channel => !channel.archived).map(channel => channel.id)
    const visibleIndex = visibleIds.indexOf(id)
    const targetId = visibleIndex < 0 ? undefined : visibleIds[visibleIndex + direction]
    if (!targetId) return
    const from = items.findIndex(channel => channel.id === id)
    const to = items.findIndex(channel => channel.id === targetId)
    if (from < 0 || to < 0) return
    markDirty()
    setItems(previous => {
      const next = previous.slice()
      const [moved] = next.splice(from, 1)
      if (!moved) return previous
      next.splice(to, 0, moved)
      return next
    })
  }
  const add = (kind: Channel['kind']) => {
    if (busyRef.current) return
    markDirty()
    setItems(previous => [...previous, makeChannel(kind)])
    setMessage('已添加未保存草稿；不会自动选择收费后端。')
  }

  const removeDraft = (id: string) => {
    if (busyRef.current) return
    setItems(previous => previous.filter(channel => channel.id !== id))
    setMessage('未保存草稿已移除')
    // 移除草稿只改本地状态，其它未保存编辑仍需保留。
    markDirty()
  }

  const removeSaved = async (channel: Channel) => {
    if (busyRef.current) return
    const state = states[channel.id]
    if (channelApi?.listChannelStates && !state) {
      setMessage(stateLoading ? '正在读取渠道使用状态，读取完成前不会执行删除。' : '缺少该渠道的使用状态，未执行删除。')
      return
    }
    if (state && (state.used || !state.canDelete || (state.references ?? []).length > 0)) {
      setMessage(state.reason || (state.used ? '该渠道已有使用记录，不能删除；请先停用。' : '该渠道仍被使用，不能删除；请先解除引用或停用。'))
      return
    }
    if (!channelApi?.deleteChannel) {
      setMessage('当前宿主不支持安全删除，未修改本地配置。')
      return
    }
    const expectedRevision = revisionRef.current
    if (expectedRevision === undefined) {
      setMessage('配置版本尚未读取，未执行删除。')
      return
    }
    if (typeof window === 'undefined' || typeof window.confirm !== 'function' || !window.confirm(`确认归档渠道“${channel.name}”？历史账目和渠道 ID 会保留。`)) return
    busyRef.current = channel.id
    setBusyId(channel.id)
    setMessage('正在归档渠道…')
    try {
      const nextRevision = await channelApi.deleteChannel(channel.id, expectedRevision)
      if (!mounted.current) return
      revisionRef.current = nextRevision
      // 保留已归档身份记录。它会从当前列表隐藏，但后续保存其它草稿时不会意外复活或丢失历史 ID。
      setItems(previous => previous.map(value => value.id === channel.id ? { ...value, archived: true, enabled: false } : value))
      setMessage('渠道已归档，历史账目仍可按渠道 ID 查询')
      refreshStates()
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : '渠道删除失败，配置未改变')
    } finally {
      busyRef.current = null
      if (mounted.current) setBusyId(null)
    }
  }

  const remove = (channel: Channel) => {
    if (busyRef.current) return
    if (!savedIds.current.has(channel.id)) removeDraft(channel.id)
    else void removeSaved(channel)
  }

  const handleSave = () => {
    if (busyRef.current) return
    setMessage('正在保存渠道配置，请稍候…')
    const expectedRevision = revisionRef.current
    busyRef.current = savingBusyId
    setBusyId(savingBusyId)
    let request: Promise<number>
    try {
      request = save({ channels: items }, expectedRevision)
    } catch (error) {
      busyRef.current = null
      if (mounted.current) {
        setBusyId(null)
        setMessage(error instanceof Error ? error.message : '保存失败，配置未改变')
      }
      return
    }
    void Promise.resolve(request).then(nextRevision => {
      if (!mounted.current) return
      revisionRef.current = nextRevision
      savedIds.current = new Set(items.map(channel => channel.id))
      dirtyRef.current = false
      setDirty(false)
      setMessage('已保存渠道配置')
      refreshStates()
    }).catch(error => {
      if (mounted.current) setMessage(error instanceof Error ? error.message : '保存失败，配置未改变')
    }).finally(() => {
      busyRef.current = null
      if (mounted.current) setBusyId(null)
    })
  }

  const visibleItems = items.filter(channel => !channel.archived)
  return <div className="dsh-stack">
    <SectionCard title="渠道管理" description="新增渠道只会创建草稿，不会自动选择或触发收费请求。已有历史账目的渠道仍可正常使用，但不能删除或更换地址归属；不再使用时可停用。" actions={<div className="dsh-add-channel">
      <Select aria-label="新增渠道类型" value={newKind} disabled={!writable || !!busyId} onValueChange={value => { if (!busyRef.current) setNewKind(value as Channel['kind']) }}>
        {channelKinds.map(kind => <option key={kind} value={kind}>{channelKindLabels[kind]}</option>)}
      </Select>
      <button className="dsh-button-primary" type="button" disabled={!writable || !!busyId} onClick={() => add(newKind)}>添加渠道</button>
    </div>}>
      <div className="dsh-toolbar">
        <span className="dsh-inline-note">{stateLoading ? '正在读取使用状态…' : '删除前会检查使用记录、引用与宿主 revision。'}</span>
        <span className="dsh-toolbar-spacer" />
        {dirty && <Badge tone="warning">有未保存编辑</Badge>}
      </div>
      {stateError && <p className="dsh-error-note" role="alert">{stateError}</p>}
      {visibleItems.length === 0 ? <EmptyState title="暂无可用渠道">可添加渠道草稿，保存后才会进入配置。</EmptyState> : <div className="dsh-channel-grid">
        {visibleItems.map(channel => {
          const state = states[channel.id]
          const isDraft = !savedIds.current.has(channel.id)
          const visibleIndex = visibleItems.findIndex(item => item.id === channel.id)
          const canDelete = isDraft ? true : channelApi?.listChannelStates ? !stateLoading && !!state && state.canDelete && !state.used && (state.references ?? []).length === 0 : !state || (state.canDelete && !state.used && (state.references ?? []).length === 0)
          const endpointLocked = !isDraft && !!channelApi?.listChannelStates && (stateLoading || !!stateError || !state || !!state.used)
          return <article className="dsh-channel-card" key={channel.id} aria-disabled={!writable}>
            <details className="dsh-channel-disclosure" open onToggle={event => { if (event.target === event.currentTarget && !event.currentTarget.open) setCredentialEpoch(value => value + 1) }}>
            <summary className="dsh-channel-title">
              <span className="dsh-channel-order">#{visibleIndex + 1}</span>
              <div className="dsh-channel-heading"><h3>{channel.name || '未命名渠道'}</h3><p className="dsh-channel-meta">{channel.capabilities.includes('search') ? '搜索' : ''}{channel.capabilities.length > 1 ? ' · ' : ''}{channel.capabilities.includes('fetch') ? '抓取' : ''} · {credentialStates[channel.id] ? `${credentialStates[channel.id]!.keyCount} Key · 顺序轮换` : channel.kind}</p></div>
              <Badge tone={isDraft ? 'warning' : stateTone(state)}>{isDraft ? '未保存草稿' : state?.used ? '已有使用记录' : state?.canDelete ? '可以安全删除' : '受保护'}</Badge>
            </summary>
            {isCredentialChannel(channel.kind) && <ChannelCredential channelId={channel.id} name={channel.name} credentialRef={channel.credentialRef ?? ''}
              capabilities={channel.capabilities} channel={channel}
              ready={!isDraft && !dirty && revisionRef.current !== undefined} writable={writable} busy={!!busyId} epoch={credentialEpoch} api={api}
              onState={next => setCredentialStates(previous => ({ ...previous, [channel.id]: next }))}
              acquire={() => { if (busyRef.current || dirtyRef.current || !savedIds.current.has(channel.id)) return false; busyRef.current = `key:${channel.id}`; setBusyId(`key:${channel.id}`); return true }}
              release={() => { busyRef.current = null; if (mounted.current) { setBusyId(null); refreshStates() } }} />}
            <details className="dsh-channel-advanced"><summary>渠道地址、费率与高级配置</summary>
            <p className="dsh-channel-meta"><code>{channel.id}</code> · {channel.billingClass}</p>
            <div className="dsh-form-grid">
              <div className="dsh-form-row">
                <label>名称 <input value={channel.name} disabled={!writable || !!busyId} onChange={event => change(channel.id, { name: event.target.value })} /></label>
                <label className="dsh-check"><input type="checkbox" checked={channel.enabled} disabled={!writable || !!busyId} onChange={event => change(channel.id, { enabled: event.target.checked })} />启用</label>
              </div>
              {channel.kind !== 'local-http' && <label>API 完整前缀 <input style={{ width: '100%' }} value={channel.endpointBase} readOnly={['tinyfish', 'qianfan', 'tavily'].includes(channel.kind)} disabled={!writable || !!busyId || endpointLocked} onChange={event => { if (!['tinyfish', 'qianfan', 'tavily'].includes(channel.kind)) change(channel.id, { endpointBase: event.target.value }) }} /></label>}
              {channel.kind === 'tinyfish' && <p className="dsh-inline-note">Search 使用上述官方地址；Fetch 固定使用 https://api.fetch.tinyfish.ai，不向目标网站转发 Key。</p>}
              {isCredentialChannel(channel.kind) && <label>兼容凭证引用（可选，仅未设置Key池时使用）<input style={{ width: '100%' }} value={channel.credentialRef ?? ''} disabled={!writable || !!busyId} onChange={event => change(channel.id, { credentialRef: event.target.value.trim() || undefined })} /></label>}
              {channel.kind === 'searxng' && <label className="dsh-check"><input type="checkbox" checked={!!channel.allowHttp} disabled={!writable || !!busyId} onChange={event => change(channel.id, { allowHttp: event.target.checked })} />明确允许本自建实例使用 HTTP</label>}
              {channel.kind === 'tavily' && channel.billingClass === 'free' && <label className="dsh-check"><input type="checkbox" aria-label="启用 Tavily Fetch（沿用旧费率）" checked={channel.capabilities.includes('fetch')} disabled={!writable || !!busyId} onChange={event => toggleTavilyFetch(channel, event.target.checked)} />启用 Tavily Fetch（沿用本地零价估算，不代表服务商免费；需按次估价请新建渠道）</label>}
              {channel.kind === 'tavily' && <label>同 Key 本地月度 credits 上限 <input type="number" min="0" max="1000" value={channel.monthlyCredits ?? 1000} disabled={!writable || !!busyId} onChange={event => change(channel.id, { monthlyCredits: Number(event.target.value) })} /></label>}
              <div className="dsh-price-grid">
                {operations.filter(operation => channel.capabilities.includes(operation)).map(operation => {
                  const price = channel.prices[operation]
                  if (!price) return null
                  return <div className="dsh-price-row" key={operation}>
                    <span className="dsh-price-label">{operation}</span>
                    <label>每千次价格 <input disabled={channel.billingClass === 'free' || !writable || !!busyId} placeholder="未知" value={price.perThousand ?? ''} onChange={event => changePrice(channel, operation, { perThousand: event.target.value === '' ? null : event.target.value })} /></label>
                    <label>币种 <Select aria-label={`${channel.id}-${operation}-币种`} value={price.currency} disabled={!writable || !!busyId} onValueChange={value => changePrice(channel, operation, { currency: value as 'CNY' | 'USD' })}><option>CNY</option><option>USD</option></Select></label>
                    {channel.billingClass === 'relay' ? <label>口径 <Select aria-label={`${channel.id}-${operation}-计费口径`} value={price.policy} disabled={!writable || !!busyId} onValueChange={value => changePrice(channel, operation, { policy: value as 'official-nonempty' | 'http-200' })}><option value="official-nonempty">200 且有结果</option><option value="http-200">所有 HTTP 200</option></Select></label> : <span className="dsh-inline-note">{price.policy === 'free' ? '免费口径' : price.policy === 'provider-success' ? 'Provider 成功口径' : '官方非空结果'}</span>}
                  </div>
                })}
              </div>
            </div>
            </details>
            {state?.used && <p className="dsh-action-note">已有请求，修改地址请新建渠道；名称、费率和凭证引用仍可按宿主规则编辑。</p>}
            {!isDraft && stateError && <p className="dsh-action-note">使用状态读取失败，已锁定已保存渠道地址；如需修改请新建渠道。</p>}
            {!isDraft && !stateLoading && !stateError && !state && channelApi?.listChannelStates && <p className="dsh-action-note">未读取到已保存渠道状态，已锁定地址；如需修改请新建渠道。</p>}
            {state?.reason && <p className="dsh-error-note">{state.reason}{(state.references ?? []).length > 0 ? `（引用：${(state.references ?? []).join('、')}）` : ''}</p>}
            <div className="dsh-toolbar" style={{ marginTop: 12 }}>
              <button type="button" aria-label={`上移渠道 ${channel.name}`} disabled={!writable || !!busyId || visibleIndex <= 0} onClick={() => moveChannel(channel.id, -1)}>上移</button>
              <button type="button" aria-label={`下移渠道 ${channel.name}`} disabled={!writable || !!busyId || visibleIndex >= visibleItems.length - 1} onClick={() => moveChannel(channel.id, 1)}>下移</button>
              <span className="dsh-toolbar-spacer" />
              <button className="dsh-button-danger" type="button" aria-label={`删除渠道 ${channel.name}`} disabled={!writable || !!busyId || !canDelete} onClick={() => remove(channel)}>{isDraft ? '移除草稿' : busyId === channel.id ? '归档中…' : '删除渠道'}</button>
            </div>
            </details>
          </article>
        })}
      </div>}
      <div className="dsh-toolbar" style={{ marginTop: 14 }}>
        <span className="dsh-toolbar-spacer" />
        <button className="dsh-button-primary" type="button" disabled={!writable || !!busyId} onClick={handleSave}>{busyId === savingBusyId ? '保存中…' : '保存渠道配置'}</button>
      </div>
      {message && <p className="dsh-action-note" role="status">{message}</p>}
    </SectionCard>
  </div>
}
