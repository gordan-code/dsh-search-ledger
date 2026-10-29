// 熔断判定只读账本终态与复位标记，不引入额外运行状态；同一输入永远得到同一结论。
import type { BreakerSettings, BreakerView, Outcome } from '../contracts.ts'

/** 请求已发出但结果未知时保守计入失败：宁可提前冷却，也不重复消耗额度。 */
const FAILURE: ReadonlySet<Outcome> = new Set<Outcome>(['failed', 'unknown'])

export interface BreakerObservation {
  channelId: string
  outcome: Outcome
  /** 与账本一致的 UTC ISO 时间。 */
  startedAt: string
}

export interface BreakerChannel {
  id: string
  name: string
}

function millis(iso: string): number {
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

function isoOrNull(value: number): string | null {
  return Number.isFinite(value) ? new Date(value).toISOString() : null
}

/**
 * 逐渠道推导熔断状态。
 *
 * - 只统计窗口内、复位标记之后的终态记录；
 * - 从最近一条向前连续计数 failed/unknown，遇到成功即中断；
 * - 连续失败达到阈值且仍在冷却期内才算开启，冷却结束自动闭合。
 */
export function breakerViews(
  observations: readonly BreakerObservation[],
  channels: readonly BreakerChannel[],
  settings: BreakerSettings,
  resets: Readonly<Record<string, string>>,
  nowMs: number,
): Map<string, BreakerView> {
  const views = new Map<string, BreakerView>()
  for (const channel of channels) {
    const resetAt = resets[channel.id]
    const resetMs = resetAt === undefined ? Number.NEGATIVE_INFINITY : millis(resetAt)
    const floor = nowMs - settings.windowMs
    const recent = observations
      .filter(item => item.channelId === channel.id)
      .map(item => ({ outcome: item.outcome, at: millis(item.startedAt) }))
      .filter(item => item.at >= floor && item.at > resetMs)
      .sort((left, right) => right.at - left.at)
    let failures = 0
    for (const item of recent) {
      if (!FAILURE.has(item.outcome)) break
      failures += 1
    }
    const lastFailureMs = failures > 0 ? recent[0]!.at : Number.NEGATIVE_INFINITY
    const cooldownMs = settings.cooldownMs
    const open = settings.enabled && failures >= settings.failureThreshold && lastFailureMs + cooldownMs > nowMs
    views.set(channel.id, {
      channelId: channel.id,
      channelName: channel.name,
      open,
      failures,
      threshold: settings.failureThreshold,
      cooldownUntil: open ? isoOrNull(lastFailureMs + cooldownMs) : null,
      lastFailureAt: failures > 0 ? isoOrNull(lastFailureMs) : null,
      resetAt: resetAt ?? null,
    })
  }
  return views
}

/** 处于冷却中的渠道集合；调用方据此在派发前剔除候选。 */
export function coolingChannels(views: ReadonlyMap<string, BreakerView>): Set<string> {
  const cooling = new Set<string>()
  for (const view of views.values()) if (view.open) cooling.add(view.channelId)
  return cooling
}
