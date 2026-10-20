// 只提交本次输入；现存Key从不发送到浏览器，也不放入ConfigForm。
import React, { useEffect, useRef, useState } from 'react'
import { Select } from './Select.tsx'
import type { Channel, ChannelCredentialState, KeyTestBatch, Operation } from '../contracts.ts'
import type { BillingApi } from './api.ts'
import { Badge } from './components.tsx'
import { KeyTestResults } from './KeyTestResults.tsx'
import { channelTestSignature } from '../channel-test.ts'
interface Props {
  channelId: string; name: string; credentialRef: string; ready: boolean; writable: boolean
  busy: boolean; epoch: number; api?: BillingApi
  acquire(): boolean; release(): void
  onState?(state: ChannelCredentialState | null): void
  capabilities?: Operation[]
  channel?: Channel
}
const defaultCapabilities: Operation[] = ['search']
export function ChannelCredential({ channelId, name, credentialRef, ready, writable, busy, epoch, api, acquire, release, onState, capabilities = defaultCapabilities, channel }: Props) {
  const [state, setState] = useState<ChannelCredentialState | null>(null)
  const [draft, setDraft] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [testing, setTesting] = useState(false)
  const [testOperation, setTestOperation] = useState<Operation>(() => capabilities.includes('search') ? 'search' : 'fetch')
  const [testResults, setTestResults] = useState<KeyTestBatch | null>(null)
  const requestId = useRef(0), pendingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const supported = !!(api?.getChannelCredential && api?.setChannelCredential && api?.unsetChannelCredential)
  useEffect(() => {
    const request = ++requestId.current
    setDraft(''); setRevealed(false); setState(null); onState?.(null); setMessage(''); setError(''); setTestResults(null)
    if (!ready || !supported) { setLoading(false); return }
    setLoading(true)
    Promise.resolve().then(() => api!.getChannelCredential!(channelId, credentialRef)).then(next => {
      if (request === requestId.current) { setState(next); onState?.(next) }
    }).catch(() => {
      if (request === requestId.current) setError('无法读取凭证状态，请刷新后重试。')
    }).finally(() => { if (request === requestId.current) setLoading(false) })
    return () => { requestId.current++ }
  }, [api, channelId, credentialRef, ready, supported, epoch, refresh])
  useEffect(() => { if (!writable || (busy && !pendingRef.current)) { setDraft(''); setRevealed(false); setTestResults(null) } }, [writable, busy])
  const capabilitiesKey = capabilities.join(',')
  useEffect(() => {
    if (!capabilities.includes(testOperation)) { setTestOperation(capabilities.includes('search') ? 'search' : 'fetch'); setTestResults(null) }
  }, [capabilitiesKey, testOperation])
  const enabled = ready && supported && writable && !busy && !pending && !loading && !!state?.writable
  const finish = (request: number) => {
    pendingRef.current = false
    if (mounted.current) {
      setPending(false); setTesting(false)
      if (request !== requestId.current) setRefresh(value => value + 1)
    }
    release()
  }
  const test = async () => {
    if (!enabled || pendingRef.current || !api?.testChannelKeys || !channel || !capabilities.includes(testOperation)) return
    const input = draft.trim() ? [...new Set(draft.split(/\r?\n/).map(key => key.trim()).filter(Boolean))] : null
    const count = input?.length ?? state?.keyCount ?? 0
    if (!count || count > 32 || input?.some(key => key.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(key))) { setError('请输入1–32个有效Key，每行一个；或先配置已保存池。'); return }
    const target = testOperation === 'fetch' ? ' Fetch固定测试目标：https://example.com/。' : ''
    const signature = channelTestSignature(channel, testOperation)
    if (!window.confirm(`将测试“${name}”${count}个${input ? '本次输入' : '已保存池'}Key，操作${testOperation}，可能收费并计入账本。${target} 不自动保存、不切换其他渠道；形成使用记录后地址将被锁定。单Key10秒，总计最多60秒。继续？`)) return
    if (!acquire()) return
    pendingRef.current = true; setPending(true); setTesting(true); setError(''); setMessage(''); setTestResults(null); setRevealed(false)
    const request = ++requestId.current
    try {
      const result = await api.testChannelKeys(channelId, credentialRef, testOperation, input, count, signature)
      if (request === requestId.current) setTestResults(result)
    } catch {
      if (request === requestId.current) setError('测试未完成或结果未确认，请检查本地账本；不要盲目重复测试。')
    } finally { finish(request) }
  }
  const run = async (remove: boolean) => {
    if (!enabled || pendingRef.current) return
    const keys = [...new Set(draft.split(/\r?\n/).map(key => key.trim()).filter(Boolean))]
    if (!remove && (!keys.length || keys.length > 32 || keys.some(key => key.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(key)))) {
      setDraft(''); setError('请输入1–32个有效Key，每行一个；单个最长8192字符，不含空白。'); return
    }
    const prompt = remove
      ? `移除“${name}”的整个Key池？不会删除旧凭证引用；旧引用或环境凭证可能继续生效。`
      : `替换“${name}”的整个Key池为本次输入的${keys.length}个Key？旧池中的Key不会保留，其他渠道与模型凭证不受影响。`
    if (typeof window === 'undefined' || !window.confirm(prompt)) return
    if (!acquire()) return
    pendingRef.current = true; setPending(true); setDraft(''); setRevealed(false); setMessage(''); setError(''); setTestResults(null)
    const request = ++requestId.current
    try {
      const next = await (remove ? api!.unsetChannelCredential!(channelId, credentialRef) : api!.setChannelCredential!(channelId, credentialRef, keys))
      if (request !== requestId.current) return
      setState(next)
      onState?.(next)
      setMessage(remove ? next.source === 'reference' ? 'Key池已移除；兼容凭证引用仍生效。' : 'Key池已移除。' : 'Key池已保存；下次请求生效，未进行网络认证测试。')
    } catch {
      if (request === requestId.current) { setState(null); onState?.(null); setError('凭据操作失败或结果未确认，请刷新状态后再试。') }
    } finally {
      finish(request)
    }
  }
  return <div className="dsh-credential-box">
    <div className="dsh-toolbar">
      <strong>API Key</strong>
      <Badge tone={state?.configured ? 'success' : 'neutral'}>{loading ? '读取状态…' : !state ? '状态待确认' : state.configured ? `${state.keyCount} 个 Key · 未验证` : '未配置 API Key'}</Badge>
      {state && !state.writable && <Badge tone="warning">宿主存储只读</Badge>}
    </div>
    {state?.source === 'reference' && <p className="dsh-inline-note">当前使用兼容凭证引用；保存私有Key池后优先使用池，不影响模型同名凭证。</p>}
    <label className="dsh-credential-label">每行一个 API Key
      <textarea aria-label={`API Keys · ${name}`} rows={3} autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={263000}
        placeholder={state?.configured ? '已保存的 Key 不回显。输入后将替换整个 Key 池，每行一个。' : '每行一个 API Key，支持多 Key 顺序轮换'}
        style={{ WebkitTextSecurity: revealed ? 'none' : 'disc' } as React.CSSProperties}
        value={draft} disabled={!enabled} onChange={event => { if (!pendingRef.current && enabled) { setDraft(event.target.value); setTestResults(null) } }} />
    </label>
    <div className="dsh-toolbar">
      <button className="dsh-button-primary" type="button" disabled={!enabled || !draft.trim()} onClick={() => void run(false)}>{pending ? '处理中…' : state?.source === 'pool' ? '替换整个 Key 池' : '保存 Key 池'}</button>
      <button type="button" disabled={!enabled || state?.source !== 'pool'} onClick={() => void run(true)}>移除 Key 池</button>
      <button type="button" disabled={!ready || !supported || busy || pending || loading} onClick={() => { setDraft(''); setRefresh(value => value + 1) }}>刷新 Key 状态</button>
      <label className="dsh-check"><input type="checkbox" checked={revealed} disabled={!enabled || !draft} onChange={event => setRevealed(event.target.checked)} />显示本次输入</label>
    </div>
    <div className="dsh-key-test-toolbar">
      <label>测试操作<Select aria-label="Key测试操作" value={testOperation} disabled={!enabled} onValueChange={value => { if (!pendingRef.current && enabled) { setTestOperation(value as Operation); setTestResults(null) } }}>{capabilities.map(operation => <option key={operation} value={operation}>{operation === 'search' ? 'Search' : 'Fetch'}</option>)}</Select></label>
      <button type="button" aria-label="测试 Key" disabled={!enabled || !channel || !api?.testChannelKeys || (!draft.trim() && !state?.configured)} onClick={() => void test()}>{testing ? '逐个测试中…' : '测试 Key'}</button>
      <span className="dsh-inline-note">{draft.trim() ? '测试本次输入，不自动保存' : '测试已保存池，不回显Key'} · 可能收费</span>
    </div>
    {testResults && <KeyTestResults batch={testResults} />}
    <p className="dsh-inline-note">正常请求按顺序轮换起点；失败或超时先尝试本渠道下一个Key。测试仅在点击并确认后进行。</p>
    {!ready && <p className="dsh-action-note">请先保存渠道配置，再设置 Key。</p>}
    {!supported && <p className="dsh-action-note">宿主暂不支持Key管理，请升级插件并重启DSH。</p>}
    {message && <p className="dsh-action-note" role="status">{message}</p>}
    {error && <p className="dsh-error-note" role="alert">{error}</p>}
  </div>
}
