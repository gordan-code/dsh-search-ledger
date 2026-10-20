// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChannelCredential } from '../../src/client/ChannelCredential.tsx'
import { Channels } from '../../src/client/Channels.tsx'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'
import { billingStyles } from '../../src/client/styles.ts'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('折叠容器内直接使用border-box，避免textarea边框padding额外溢出', () => {
  expect(billingStyles).toContain('.dsh-web-billing *, .dsh-web-billing *::before, .dsh-web-billing *::after { box-sizing: border-box; }')
})
const state = { channelId: 'c', credentialRef: 'C_KEY', configured: false, writable: true, keyCount: 0, source: 'none' as const }
function setup(overrides: Record<string, unknown> = {}) {
  const api = { getChannelCredential: vi.fn(async () => state), setChannelCredential: vi.fn(async () => ({ ...state, configured: true, source: 'pool', keyCount: 2 })), unsetChannelCredential: vi.fn(async () => state) }
  const props = { channelId: 'c', name: '渠道', credentialRef: 'C_KEY', ready: true, writable: true, busy: false, epoch: 0, api: api as never, acquire: vi.fn(() => true), release: vi.fn(), ...overrides }
  const view = render(<ChannelCredential {...props} />)
  return { api, props, ...view }
}
it('直接输入多行Key，只提交去重后的本次输入，不回读已有Key', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const { api } = setup()
  await screen.findByText('未配置 API Key')
  const input = screen.getByLabelText('API Keys · 渠道') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'synthetic-a\nsynthetic-b\nsynthetic-a' } })
  fireEvent.click(screen.getByRole('button', { name: '保存 Key 池' }))
  expect(input.value).toBe('')
  await waitFor(() => expect(api.setChannelCredential).toHaveBeenCalledWith('c', 'C_KEY', ['synthetic-a', 'synthetic-b']))
  await screen.findByText(/2 个 Key/)
  expect(document.body.textContent).not.toContain('synthetic-')
})
it('失败也清空，不显示底层Key错误', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const { api } = setup()
  api.setChannelCredential.mockRejectedValue(new Error('secret-key private-path'))
  await screen.findByText('未配置 API Key')
  const input = screen.getByLabelText('API Keys · 渠道') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'synthetic-a' } }); fireEvent.click(screen.getByRole('button', { name: '保存 Key 池' }))
  await screen.findByText(/凭据操作失败或结果未确认/)
  expect(input.value).toBe(''); expect(document.body.textContent).not.toContain('secret-key')
})
it('校验失败后能直接重新输入，不必刷新宿主状态', async () => {
  setup()
  await screen.findByText('未配置 API Key')
  const input = screen.getByLabelText('API Keys · 渠道') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'invalid key' } })
  fireEvent.click(screen.getByRole('button', { name: '保存 Key 池' }))
  await screen.findByText(/请输入1–32个有效Key/)
  expect(input.disabled).toBe(false)
  fireEvent.change(input, { target: { value: 'synthetic-valid' } })
  expect(input.value).toBe('synthetic-valid')
})
it('写入期间刷新世代变化，结束后不能卡在pending', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  let complete!: (value: any) => void
  const { api, props, rerender } = setup()
  await screen.findByText('未配置 API Key')
  api.setChannelCredential.mockImplementation(async () => new Promise(resolve => { complete = resolve }))
  fireEvent.change(screen.getByLabelText('API Keys · 渠道'), { target: { value: 'synthetic' } })
  fireEvent.click(screen.getByRole('button', { name: '保存 Key 池' }))
  rerender(<ChannelCredential {...props} epoch={1} />)
  await screen.findByText('未配置 API Key')
  api.getChannelCredential.mockResolvedValue({ ...state, configured: true, source: 'pool', keyCount: 2 } as never)
  complete({ ...state, configured: true, source: 'pool', keyCount: 2 })
  await waitFor(() => expect((screen.getByLabelText('API Keys · 渠道') as HTMLTextAreaElement).disabled).toBe(false))
  await screen.findByText(/2 个 Key/)
})
it('草稿/脏配置不能录入Key，引用变化清空本次输入', async () => {
  const { props, rerender, api } = setup({ ready: false })
  expect((screen.getByLabelText('API Keys · 渠道') as HTMLTextAreaElement).disabled).toBe(true)
  expect(api.getChannelCredential).not.toHaveBeenCalled()
  rerender(<ChannelCredential {...props} ready />)
  await screen.findByText('未配置 API Key')
  fireEvent.change(screen.getByLabelText('API Keys · 渠道'), { target: { value: 'synthetic' } })
  rerender(<ChannelCredential {...props} ready credentialRef="NEW_REF" />)
  await waitFor(() => expect((screen.getByLabelText('API Keys · 渠道') as HTMLTextAreaElement).value).toBe(''))
})
it('移除池需确认，引用回退仍生效时明确告知', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { api, props, rerender } = setup()
  api.getChannelCredential.mockResolvedValue({ ...state, configured: true, keyCount: 2, source: 'pool' } as never)
  rerender(<ChannelCredential {...props} epoch={1} />)
  await screen.findByText(/2 个 Key/)
  fireEvent.click(screen.getByRole('button', { name: '移除 Key 池' })); expect(api.unsetChannelCredential).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  api.unsetChannelCredential.mockResolvedValue({ ...state, configured: true, keyCount: 1, source: 'reference' } as never)
  fireEvent.click(screen.getByRole('button', { name: '移除 Key 池' }))
  await screen.findByText(/兼容凭证引用仍生效/)
})
it('陈旧状态响应不能覆盖新的引用状态', async () => {
  let old!: (state: unknown) => void
  const { api, props, rerender } = setup({ ready: false })
  api.getChannelCredential.mockImplementationOnce(async () => new Promise(resolve => { old = resolve as never }))
  rerender(<ChannelCredential {...props} ready />)
  await waitFor(() => expect(api.getChannelCredential).toHaveBeenCalledTimes(1))
  rerender(<ChannelCredential {...props} ready credentialRef="NEW_REF" />)
  await screen.findByText('未配置 API Key')
  old({ ...state, configured: true, keyCount: 9, source: 'pool' })
  await waitFor(() => expect(screen.queryByText(/9 个 Key/)).toBeNull())
})
it('Key写入期间与配置保存、编辑共用互斥锁，重复点击不多写', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  let finish!: (value: unknown) => void
  const api = { getChannelCredential: vi.fn(async () => ({ ...state, channelId: 'deepseek-official-api', credentialRef: 'DEEPSEEK_API_KEY' })), setChannelCredential: vi.fn(async () => new Promise(resolve => { finish = resolve })), unsetChannelCredential: vi.fn(async () => state), listChannelStates: vi.fn(async () => []) }
  const save = vi.fn(async () => 2)
  render(<Channels config={structuredClone(DEFAULT_CONFIG)} writable revision={1} save={save} api={api as never} />)
  await screen.findByText('未配置 API Key')
  fireEvent.change(screen.getByLabelText('API Keys · DeepSeek 官方 API'), { target: { value: 'synthetic-a' } })
  const button = screen.getByRole('button', { name: '保存 Key 池' })
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(api.setChannelCredential).toHaveBeenCalledTimes(1))
  expect((screen.getByRole('button', { name: '保存渠道配置' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByDisplayValue('DeepSeek 官方 API') as HTMLInputElement).disabled).toBe(true)
  finish(state)
  await waitFor(() => expect((screen.getByRole('button', { name: '保存渠道配置' }) as HTMLButtonElement).disabled).toBe(false))
  expect(save).not.toHaveBeenCalled()
})
