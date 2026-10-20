// @vitest-environment jsdom
import React from 'react'
import { changeControl } from './controls.ts'
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { Channels } from '../../src/client/Channels.tsx'
import { Routing } from '../../src/client/Routing.tsx'
import { Usage } from '../../src/client/Usage.tsx'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'
afterEach(cleanup)
it('渠道保存保留未知价格，传递原revision，冲突可见', async () => {
  const save = vi.fn(async () => { throw new Error('revision 冲突') })
  render(<Channels config={structuredClone(DEFAULT_CONFIG)} revision={4} writable save={save} />)
  changeControl(screen.getAllByLabelText('每千次价格')[0]!, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '保存渠道配置' }))
  await screen.findByText('revision 冲突')
  expect(save.mock.calls[0]![1]).toBe(4)
  expect((save.mock.calls[0]![0] as any).channels[0].prices.search.perThousand).toBe(null)
})
it('provider两操作独立，清除会话覆盖使用会话revision', async () => {
  const save = vi.fn(async () => 3)
  const api = { getSessionOverride: vi.fn(async () => ({ revision: 9, search: 'deepseek-official-api', fetch: null })), setSessionOverride: vi.fn(async () => ({ revision: 10, search: null, fetch: null })) }
  render(<Routing config={structuredClone(DEFAULT_CONFIG)} providers={[{ id: 'relay', name: '中转' }]} api={api as never} revision={2} writable save={save} />)
  changeControl(screen.getAllByLabelText('search渠道')[1]!, { target: { value: 'deepseek-official-api' } })
  changeControl(screen.getAllByLabelText('fetch渠道')[1]!, { target: { value: 'local-http' } })
  fireEvent.click(screen.getByRole('button', { name: '保存绑定与全局覆盖' }))
  expect(save).toHaveBeenCalledWith({ providerBindings: { relay: { search: 'deepseek-official-api', fetch: 'local-http' } }, globalOverrides: {} }, 2)
  await screen.findByText('操作成功')
  fireEvent.click(screen.getByRole('button', { name: '保存绑定与全局覆盖' }))
  expect(save.mock.calls[1]![1]).toBe(3)
  changeControl(screen.getByLabelText('会话 ID'), { target: { value: 'session-test' } })
  fireEvent.click(screen.getByRole('button', { name: '读取会话覆盖' }))
  await waitFor(() => expect(screen.getAllByLabelText('search渠道')).toHaveLength(3))
  changeControl(screen.getAllByLabelText('search渠道')[2]!, { target: { value: '' } })
  await waitFor(() => expect(api.setSessionOverride).toHaveBeenCalledWith('session-test', 'search', null, 9))
})
it('用量默认查询本地当天，未知与分币种金额独立显示', async () => {
  const base = { channelId: 'c', channelName: '渠道', operation: 'search', total: 2, billable: 1, empty: 0, failed: 0, unknown: 1, priceUnknown: 1, quotaCredits: 0 }
  const api = { getSummary: vi.fn(async () => [{ ...base, currency: 'CNY', amountMicros: '5000' }, { ...base, currency: 'USD', amountMicros: '0' }]) }
  render(<Usage config={DEFAULT_CONFIG} providers={[]} api={api as never} />)
  fireEvent.click(screen.getByRole('button', { name: '刷新本地账本' }))
  await screen.findByText('CNY 0.005000')
  expect(screen.getByText('USD 0.000000')).toBeTruthy()
  expect(api.getSummary.mock.calls[0]![0]).toHaveProperty('from')
  expect(api.getSummary.mock.calls[0]![0]).toHaveProperty('to')
})
