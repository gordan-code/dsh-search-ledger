// @vitest-environment jsdom
import React from 'react'
import { changeControl } from './controls.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChannelCredential } from '../../src/client/ChannelCredential.tsx'
import { Channels } from '../../src/client/Channels.tsx'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const state = { channelId: 'c', credentialRef: 'REF', configured: true, writable: true, keyCount: 2, source: 'pool' as const }
const batch = { operationId: 'batch', channelId: 'c', operation: 'search', source: 'input', results: [{ index: 1, state: 'success', status: 200, attemptId: 'a', code: null }, { index: 2, state: 'limited', status: 429, attemptId: 'b', code: 'UPSTREAM_FAILED' }] }
function setup(capabilities: ('search' | 'fetch')[] = ['search', 'fetch']) {
  const api = { getChannelCredential: vi.fn(async () => state), setChannelCredential: vi.fn(async () => state), unsetChannelCredential: vi.fn(async () => state), testChannelKeys: vi.fn(async () => batch) }
  const channel = { ...structuredClone(DEFAULT_CONFIG.channels[0]!), id: 'c', name: '渠道', credentialRef: 'REF', capabilities }
  const props = { channelId: 'c', name: '渠道', credentialRef: 'REF', channel, capabilities, ready: true, writable: true, busy: false, epoch: 0, api: api as never, acquire: vi.fn(() => true), release: vi.fn() }
  return { ...render(<ChannelCredential {...props} />), api, props }
}
it('测试先确认费用、逐Key结果，保留输入供保存，不自动写入', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const { api } = setup()
  await screen.findByText('2 个 Key · 未验证')
  const input = screen.getByLabelText('API Keys · 渠道') as HTMLTextAreaElement
  changeControl(input, { target: { value: 'synthetic-a\nsynthetic-b\nsynthetic-a' } })
  fireEvent.click(screen.getByRole('button', { name: '测试 Key' }))
  await waitFor(() => expect(api.testChannelKeys).toHaveBeenCalledWith('c', 'REF', 'search', ['synthetic-a', 'synthetic-b'], 2, expect.any(String)))
  expect(confirm.mock.calls[0]![0]).toMatch(/2.*search.*可能收费/)
  await screen.findByText('Key #1'); await screen.findByText(/限流或额度限制/)
  expect(input.value).toBe('synthetic-a\nsynthetic-b\nsynthetic-a')
  expect(api.setChannelCredential).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '替换整个 Key 池' }))
  await waitFor(() => expect(api.setChannelCredential).toHaveBeenCalledWith('c', 'REF', ['synthetic-a', 'synthetic-b']))
})
it('空输入测试已保存池，取消确认零请求；Fetch明确目标', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { api } = setup()
  await screen.findByText('2 个 Key · 未验证')
  changeControl(screen.getByLabelText('Key测试操作'), { target: { value: 'fetch' } })
  fireEvent.click(screen.getByRole('button', { name: '测试 Key' }))
  expect(api.testChannelKeys).not.toHaveBeenCalled()
  expect(confirm.mock.calls[0]![0]).toContain('https://example.com/')
  confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: '测试 Key' }))
  await waitFor(() => expect(api.testChannelKeys).toHaveBeenCalledWith('c', 'REF', 'fetch', null, 2, expect.any(String)))
})
it('千帆只提供Search，错误脱敏并保留输入', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const { api } = setup(['search'])
  api.testChannelKeys.mockRejectedValue(new Error('private-key raw-body'))
  await screen.findByText('2 个 Key · 未验证')
  fireEvent.click(screen.getByLabelText('Key测试操作'))
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.keyDown(screen.getByLabelText('Key测试操作'), { key: 'Escape' })
  const input = screen.getByLabelText('API Keys · 渠道') as HTMLTextAreaElement
  changeControl(input, { target: { value: 'synthetic' } }); fireEvent.click(screen.getByRole('button', { name: '测试 Key' }))
  await screen.findByText(/测试未完成或结果未确认/)
  expect(document.body.textContent).not.toContain('private-key'); expect(input.value).toBe('synthetic')
})
it('改动输入或操作清除旧测试结果，陈旧响应不会回来覆盖', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const { api, props, rerender } = setup()
  let complete!: (result: any) => void
  api.testChannelKeys.mockImplementationOnce(async () => new Promise(resolve => { complete = resolve }))
  await screen.findByText('2 个 Key · 未验证')
  fireEvent.click(screen.getByRole('button', { name: '测试 Key' }))
  rerender(<ChannelCredential {...props} credentialRef="NEW_REF" />)
  complete(batch)
  await waitFor(() => expect(screen.queryByText('Key #1')).toBeNull())
  await waitFor(() => expect((screen.getByRole('button', { name: '测试 Key' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '测试 Key' }))
  await screen.findByText('Key #1')
  changeControl(screen.getByLabelText('API Keys · 渠道'), { target: { value: 'changed' } })
  expect(screen.queryByText('Key #1')).toBeNull()
})
it('测试与配置保存/更换池互斥，重复点击只发一个RPC，自己输入不被busy清空', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  let complete!: (result: any) => void
  const api = { getChannelCredential: vi.fn(async () => state), setChannelCredential: vi.fn(async () => state), unsetChannelCredential: vi.fn(async () => state), testChannelKeys: vi.fn(async () => new Promise(resolve => { complete = resolve })), listChannelStates: vi.fn(async () => []) }
  render(<Channels config={structuredClone(DEFAULT_CONFIG)} revision={1} writable api={api as never} save={vi.fn(async () => 2)} />)
  await screen.findByText('2 个 Key · 未验证')
  const input = screen.getByLabelText('API Keys · DeepSeek 官方 API') as HTMLTextAreaElement
  changeControl(input, { target: { value: 'synthetic-a' } })
  const button = screen.getByRole('button', { name: '测试 Key' }); fireEvent.click(button); fireEvent.click(button)
  expect(api.testChannelKeys).toHaveBeenCalledTimes(1)
  expect(input.value).toBe('synthetic-a'); expect(input.disabled).toBe(true)
  expect((screen.getByRole('button', { name: '保存渠道配置' }) as HTMLButtonElement).disabled).toBe(true)
  complete(batch)
  await screen.findByText('Key #1')
  expect(input.value).toBe('synthetic-a')
})
