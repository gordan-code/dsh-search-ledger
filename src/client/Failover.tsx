import React from 'react'
import type { FailoverSettings, Operation } from '../contracts.ts'

export const DEFAULT_FAILOVER_SETTINGS: FailoverSettings = {
  enabled: false,
  attemptTimeoutMs: 20_000,
  totalTimeoutMs: 60_000,
}

export type FailoverMap = Record<Operation, FailoverSettings>

export interface FailoverEditorProps {
  settings: FailoverMap
  writable: boolean
  saving: boolean
  onChange(operation: Operation, patch: Partial<FailoverSettings>): void
}

function seconds(value: number): string {
  return String(value / 1000)
}

function milliseconds(value: string): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.round(parsed * 1000)
}

function operationLabel(operation: Operation): string {
  return operation === 'search' ? 'Search' : 'Fetch'
}

/**
 * Failover 的所有编辑状态由 Routing 持有；这里仅负责把可读的秒数输入转换为契约要求的毫秒。
 */
export function FailoverEditor({ settings, writable, saving, onChange }: FailoverEditorProps) {
  return <div className="dsh-failover-box">
    <div className="dsh-failover-intro">
      <strong>故障转移（Failover）</strong>
      <p>首选渠道优先，其余按配置顺序尝试；缺少凭证的渠道会跳过，失败或超时才切换。取消会停止后续尝试，超时可能已经产生服务商费用。关闭后沿用旧的单渠道行为。</p>
    </div>
    <div className="dsh-route-grid dsh-failover-grid">
      {(['search', 'fetch'] as const).map(operation => {
        const setting = settings[operation]
        const label = operationLabel(operation)
        return <div className="dsh-route-card dsh-failover-card" key={operation}>
          <div className="dsh-route-card-header">
            <div><h3>{label} 故障转移</h3><p>独立开关与预算，不影响另一个操作。</p></div>
            <label className="dsh-check"><input type="checkbox" aria-label={`启用 ${label} 故障转移`} checked={setting.enabled} disabled={!writable || saving} onChange={event => onChange(operation, { enabled: event.target.checked })} />启用</label>
          </div>
          <div className="dsh-form-row dsh-failover-inputs">
            <label>{label} 单次超时（秒）<input type="number" min="0.001" max="30" step="0.001" aria-label={`${label} 单次超时（秒）`} value={seconds(setting.attemptTimeoutMs)} disabled={!writable || saving} onChange={event => { const value = milliseconds(event.target.value); if (value !== undefined) onChange(operation, { attemptTimeoutMs: value }) }} /></label>
            <label>{label} 总预算（秒）<input type="number" min="0.001" max="300" step="0.001" aria-label={`${label} 总预算（秒）`} value={seconds(setting.totalTimeoutMs)} disabled={!writable || saving} onChange={event => { const value = milliseconds(event.target.value); if (value !== undefined) onChange(operation, { totalTimeoutMs: value }) }} /></label>
          </div>
          <p className="dsh-inline-note">保存值：{setting.attemptTimeoutMs} ms 单项 / {setting.totalTimeoutMs} ms 总预算</p>
        </div>
      })}
    </div>
  </div>
}
