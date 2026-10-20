// @vitest-environment jsdom
// 面板必须明确显示估算边界，配置保存不能无声覆盖已变化的revision。
import React from 'react'
import { changeControl } from './controls.ts'
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { App } from '../../src/client/App.tsx'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'
afterEach(cleanup)
it('显示计费覆盖范围并允许只刷新本地用量', async () => {
  const api = { getStatus: async () => ({ active: true, configError: null }), listProviders: async () => [{ id: 'relay', name: '中转' }], getSummary: vi.fn(async () => []), listAttempts: async () => ({ items: [], nextCursor: null }) }
  const form = { getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: { channels: [], providerBindings: {}, globalOverrides: {} } }), subscribe: () => () => {}, mutate: vi.fn(async () => true) }
  render(<App api={api as never} form={form as never} />)
  expect(screen.getByText(/仅统计经本插件执行的请求/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '用量与费用' }))
  await screen.findByRole('button', { name: '刷新本地账本' })
  fireEvent.click(screen.getByRole('button', { name: '刷新本地账本' }))
  expect(api.getSummary).toHaveBeenCalled()
})
it('无效价格在客户端保存前拒绝，不能显示伪成功', async () => {
  const api = { getStatus: async () => ({ active: true }), listProviders: async () => [] }
  const form = { getSnapshot: () => ({ writable: true, revision: 3, value: DEFAULT_CONFIG }), subscribe: () => () => {}, mutate: vi.fn(async () => true) }
  render(<App api={api as never} form={form as never} />)
  changeControl(screen.getAllByLabelText('每千次价格')[0]!, { target: { value: '-1' } })
  fireEvent.click(screen.getByRole('button', { name: '保存渠道配置' }))
  await screen.findByText('渠道字段、费率或操作配置无效')
  expect(form.mutate).not.toHaveBeenCalled()
})
