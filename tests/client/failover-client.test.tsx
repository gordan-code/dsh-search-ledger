// @vitest-environment jsdom
import React from 'react'
import { changeControl } from './controls.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Channels } from '../../src/client/Channels.tsx'
import { Routing } from '../../src/client/Routing.tsx'
import { Usage } from '../../src/client/Usage.tsx'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'

afterEach(cleanup)

it('新增TinyFish与千帆使用官方地址、凭证引用和能力元数据', () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), channels: [] }
  render(<Channels config={config} revision={1} writable save={vi.fn(async () => 2)} />)
  const kind = screen.getByRole('combobox', { name: '新增渠道类型' })
  changeControl(kind, { target: { value: 'tinyfish' } })
  fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
  expect(screen.getByDisplayValue('https://api.search.tinyfish.ai')).toBeTruthy()
  expect(screen.getByDisplayValue('TINYFISH_API_KEY')).toBeTruthy()
  expect(screen.getAllByText('search').length).toBeGreaterThan(0)
  expect(screen.getAllByText('fetch').length).toBeGreaterThan(0)
})

it('Tavily旧free渠道只有显式勾选才增加免费Fetch', () => {
  const tavily = {
    id: 'old-tavily', name: '旧 Tavily', kind: 'tavily' as const, billingClass: 'free' as const, enabled: true,
    endpointBase: 'https://api.tavily.com', credentialRef: 'TAVILY_API_KEY', capabilities: ['search' as const],
    prices: { search: { perThousand: '0', currency: 'CNY' as const, policy: 'free' as const } }, monthlyCredits: 1000,
  }
  const save = vi.fn(async () => 2)
  render(<Channels config={{ ...structuredClone(DEFAULT_CONFIG), channels: [tavily] }} revision={1} writable save={save} />)
  expect(screen.queryByText('fetch')).toBeNull()
  expect(screen.queryByText('启用 Tavily Fetch（免费）')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: /启用 Tavily Fetch/ }))
  fireEvent.click(screen.getByRole('button', { name: '保存渠道配置' }))
  expect((save.mock.calls[0]![0] as any).channels[0]).toMatchObject({
    billingClass: 'free', capabilities: ['search', 'fetch'],
    prices: { fetch: { perThousand: '0', policy: 'free' } },
  })
})

it('凭证引用清空后以undefined保存，并允许渠道顺序跨归档项调整', () => {
  const channels = [
    { ...structuredClone(DEFAULT_CONFIG.channels[0]!), id: 'first', name: '首个' },
    { ...structuredClone(DEFAULT_CONFIG.channels[0]!), id: 'archived', name: '归档', archived: true, enabled: false },
    { ...structuredClone(DEFAULT_CONFIG.channels[0]!), id: 'last', name: '末个' },
  ]
  const save = vi.fn(async () => 2)
  render(<Channels config={{ ...structuredClone(DEFAULT_CONFIG), channels }} revision={1} writable save={save} />)
  changeControl(screen.getAllByDisplayValue('DEEPSEEK_API_KEY')[0]!, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '上移渠道 末个' }))
  fireEvent.click(screen.getByRole('button', { name: '保存渠道配置' }))
  const saved = (save.mock.calls[0]![0] as any).channels
  expect(saved.map((item: any) => item.id)).toEqual(['last', 'first', 'archived'])
  expect(saved.find((item: any) => item.id === 'first').credentialRef).toBeUndefined()
})

it('路由故障转移独立配置并由同一revision保存，候选预览不发起搜索', async () => {
  const save = vi.fn(async () => 7)
  const getCandidateStates = vi.fn(async () => [{ channelId: 'deepseek-official-api', capabilities: ['search', 'fetch'], credentialReady: false, reason: '未配置凭证' }])
  render(<Routing config={structuredClone(DEFAULT_CONFIG)} providers={[{ id: 'relay', name: '中转' }]} status={undefined} api={{ getCandidateStates } as never} revision={6} writable save={save} />)
  fireEvent.click(screen.getByRole('checkbox', { name: '启用 Search 故障转移' }))
  changeControl(screen.getByLabelText('Search 单次超时（秒）'), { target: { value: '3' } })
  changeControl(screen.getByLabelText('Search 总预算（秒）'), { target: { value: '9' } })
  changeControl(screen.getByRole('combobox', { name: '候选预览操作' }), { target: { value: 'search' } })
  fireEvent.click(screen.getByRole('button', { name: '预览候选顺序' }))
  await waitFor(() => expect(getCandidateStates).toHaveBeenCalledWith('search', null, null))
  expect(screen.getByText(/不会发起搜索测试/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保存绑定与全局覆盖' }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ failover: expect.objectContaining({ search: { enabled: true, attemptTimeoutMs: 3000, totalTimeoutMs: 9000 } }) }), 6)
})

it('用量最近记录显示operationId并明确credits只是本地预留', async () => {
  const api = {
    getSummary: vi.fn(async () => []),
    listAttempts: vi.fn(async () => ({ items: [{ attemptId: 'a', operationId: 'handoff-1', profileId: 'p', sessionId: null, sourceProviderId: null, channelId: 'c', channelName: '渠道', operation: 'search', outcome: 'billable', startedAt: '2026-10-20T00:00:00.000Z', completedAt: '2026-10-20T00:00:01.000Z', status: 200, currency: 'CNY', amountMicros: '1', pricePerThousand: '1', quotaCredits: 1 }], nextCursor: null })),
  }
  render(<Usage config={DEFAULT_CONFIG} providers={[]} api={api as never} />)
  expect(await screen.findByText(/handoff-1/)).toBeTruthy()
  expect(screen.getByText(/本地预留.*不等于.*usage/)).toBeTruthy()
})

it('候选预览与会话读取请求互不取消，修改会话后解除旧预览pending锁', async () => {
  let sessionResult!: (value: any) => void
  let candidatesResult!: (value: any) => void
  const api = {
    getSessionOverride: vi.fn(async () => await new Promise(resolve => { sessionResult = resolve })),
    getCandidateStates: vi.fn(async () => await new Promise(resolve => { candidatesResult = resolve })),
  }
  render(<Routing config={structuredClone(DEFAULT_CONFIG)} providers={[]} api={api as never} revision={1} writable save={vi.fn(async () => 2)} />)
  changeControl(screen.getByRole('textbox', { name: /会话 ID/ }), { target: { value: 'session-a' } })
  fireEvent.click(screen.getByRole('button', { name: '读取会话覆盖' }))
  fireEvent.click(screen.getByRole('button', { name: '预览候选顺序' }))
  await waitFor(() => expect(api.getCandidateStates).toHaveBeenCalled())
  sessionResult({ revision: 3, search: null, fetch: null })
  expect(await screen.findByText(/会话 revision/)).toBeTruthy()
  changeControl(screen.getByRole('textbox', { name: /会话 ID/ }), { target: { value: 'session-b' } })
  await waitFor(() => expect((screen.getByRole('button', { name: '预览候选顺序' }) as HTMLButtonElement).disabled).toBe(false))
  candidatesResult([{ channelId: 'stale-channel', capabilities: ['search'], credentialReady: true, reason: null }])
  await Promise.resolve()
  expect(screen.queryByText(/stale-channel/)).toBeNull()
})

it('会话覆盖写入pending锁住两个选择框，且不把全局配置标为dirty', async () => {
  let finish!: (value: any) => void
  const api = { getSessionOverride: vi.fn(async () => ({ revision: 9, search: null, fetch: null })), setSessionOverride: vi.fn(async () => await new Promise(resolve => { finish = resolve })) }
  render(<Routing config={structuredClone(DEFAULT_CONFIG)} providers={[]} api={api as never} revision={1} writable save={vi.fn(async () => 2)} />)
  changeControl(screen.getByRole('textbox', { name: /会话 ID/ }), { target: { value: 'session-a' } })
  fireEvent.click(screen.getByRole('button', { name: '读取会话覆盖' }))
  await screen.findByText(/会话 revision/)
  changeControl(screen.getAllByRole('combobox', { name: 'search渠道' }).at(-1)!, { target: { value: 'deepseek-official-api' } })
  await waitFor(() => expect(api.setSessionOverride).toHaveBeenCalledTimes(1))
  expect((screen.getAllByRole('combobox', { name: 'fetch渠道' }).at(-1)! as HTMLSelectElement).disabled).toBe(true)
  expect(screen.queryByText('有未保存编辑')).toBeNull()
  finish({ revision: 10, search: 'deepseek-official-api', fetch: null })
  await waitFor(() => expect((screen.getAllByRole('combobox', { name: 'fetch渠道' }).at(-1)! as HTMLSelectElement).disabled).toBe(false))
})

it('预算越界时在调用save前拒绝，固定服务端点只读', async () => {
  const save = vi.fn(async () => 2)
  render(<Routing config={structuredClone(DEFAULT_CONFIG)} providers={[]} api={{} as never} revision={1} writable save={save} />)
  changeControl(screen.getByLabelText('Search 总预算（秒）'), { target: { value: '301' } })
  fireEvent.click(screen.getByRole('button', { name: '保存绑定与全局覆盖' }))
  expect(save).not.toHaveBeenCalled()
  expect(await screen.findByText(/预算.*范围/)).toBeTruthy()
  cleanup()
  render(<Channels config={{ ...structuredClone(DEFAULT_CONFIG), channels: [] }} revision={1} writable save={save} />)
  changeControl(screen.getByRole('combobox', { name: '新增渠道类型' }), { target: { value: 'tinyfish' } })
  fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
  expect((screen.getByDisplayValue('https://api.search.tinyfish.ai') as HTMLInputElement).readOnly).toBe(true)
})
