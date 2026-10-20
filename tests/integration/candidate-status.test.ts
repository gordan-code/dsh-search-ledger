import { expect, it, vi } from 'vitest'
import { candidateStates } from '../../src/host/candidate-status.ts'
import type { RoutingConfig } from '../../src/contracts.ts'

it('候选就绪状态脱敏，缺Key跳过且无Key引擎不读凭证', async () => {
  const config = { channels: [
    { id: 't', kind: 'tavily', enabled: true, capabilities: ['search', 'fetch'], credentialRef: 'TAVILY_KEY' },
    { id: 's', kind: 'searxng', enabled: true, capabilities: ['search'] },
    { id: 'q', kind: 'qianfan', enabled: true, capabilities: ['search'], credentialRef: 'BAIDU_KEY' },
  ], providerBindings: {}, globalOverrides: {} } as RoutingConfig
  const resolve = vi.fn(async (ref: string) => { if (ref === 'TAVILY_KEY') throw new Error('secret-exception'); return 'secret-value' })
  const rows = await candidateStates(config, 'search', null, {}, resolve)
  expect(rows).toEqual([
    { channelId: 't', capabilities: ['search', 'fetch'], credentialReady: false, reason: '凭证暂不可读取' },
    { channelId: 's', capabilities: ['search'], credentialReady: true, reason: null },
    { channelId: 'q', capabilities: ['search'], credentialReady: true, reason: null },
  ])
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(rows)).not.toMatch(/secret|TAVILY_KEY|BAIDU_KEY/)
  expect((await candidateStates(config, 'fetch', null, {}, async () => undefined)).map(r => r.channelId)).toEqual(['t'])
})

it('候选预览预算耗尽后不再解析其他Key引用', async () => {
  vi.useFakeTimers()
  const config = { channels: ['one', 'two'].map(id => ({ id, kind: 'tavily', enabled: true, capabilities: ['search'], credentialRef: `${id}_KEY` })), providerBindings: {}, globalOverrides: {} } as RoutingConfig
  const resolve = vi.fn(async () => await new Promise<string>(() => {}))
  try {
    const pending = candidateStates(config, 'search', null, {}, resolve)
    await vi.advanceTimersByTimeAsync(5001)
    expect(await pending).toHaveLength(2)
    expect(resolve).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})
