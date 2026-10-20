// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { Select } from '../../src/client/Select.tsx'
import { Channels } from '../../src/client/Channels.tsx'
import { Routing } from '../../src/client/Routing.tsx'
import { Usage } from '../../src/client/Usage.tsx'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'
import { App } from '../../src/client/App.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const options = <><option value="">继承</option><option value="a">Alpha</option><option value="x" disabled>不可用</option><option value="b">Beta</option></>

it('展开只更新本地菜单，不提交值，也不创建系统select', () => {
  const change = vi.fn()
  const { container } = render(<Select aria-label="渠道" value="a" onValueChange={change}>{options}</Select>)
  const trigger = screen.getByRole('combobox', { name: '渠道' })
  expect(container.querySelector('select')).toBeNull()
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.click(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getAllByRole('option')).toHaveLength(4)
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
  expect(change).toHaveBeenCalledExactlyOnceWith('b')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('键盘方向/Home/End/输入定位/确认跳过禁用项，Escape与Tab不写入', () => {
  const change = vi.fn()
  render(<Select aria-label="渠道" value="a" onValueChange={change}>{options}</Select>)
  const trigger = screen.getByRole('combobox')
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toContain('Beta')
  fireEvent.keyDown(trigger, { key: 'Enter' })
  expect(change).toHaveBeenLastCalledWith('b')
  change.mockClear()
  for (const key of ['Home', 'End', 'Escape']) fireEvent.keyDown(trigger, { key })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(change).not.toHaveBeenCalled()
  fireEvent.keyDown(trigger, { key: 'b' })
  expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toContain('Beta')
  fireEvent.keyDown(trigger, { key: 'Tab' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})

it('禁用、外点、失焦、卸载及选项变化关闭菜单且不误提交', () => {
  const change = vi.fn()
  const { rerender } = render(<Select aria-label="渠道" value="a" onValueChange={change}>{options}</Select>)
  const trigger = screen.getByRole('combobox')
  fireEvent.click(trigger); fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.click(trigger); fireEvent.focusIn(document.body)
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.click(trigger)
  rerender(<Select aria-label="渠道" value="a" disabled onValueChange={change}>{options}</Select>)
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.click(trigger)
  expect(screen.queryByRole('listbox')).toBeNull()
  rerender(<Select aria-label="渠道" value="a" onValueChange={change}>{options}</Select>)
  fireEvent.click(trigger)
  rerender(<Select aria-label="渠道" value="a" onValueChange={change}><option value="a">Alpha</option></Select>)
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})

it('长列表只渲染可见窗口，End能选最后一项，无监听泄漏', () => {
  const change = vi.fn()
  const { unmount } = render(<Select aria-label="长列表" value="0" onValueChange={change}>{Array.from({ length: 2000 }, (_, i) => <option key={i} value={String(i)}>渠道 {i}</option>)}</Select>)
  const trigger = screen.getByRole('combobox')
  fireEvent.keyDown(trigger, { key: 'End' })
  expect(within(screen.getByRole('listbox')).getAllByRole('option').length).toBeLessThan(30)
  expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toBe('渠道 1999')
  fireEvent.keyDown(trigger, { key: 'Enter' })
  expect(change).toHaveBeenCalledExactlyOnceWith('1999')
  fireEvent.click(trigger); unmount()
  fireEvent.pointerDown(document.body); fireEvent.scroll(window)
})

it('各页面展开和关闭下拉不保存、不读候选、不刷新账本或测试Key', async () => {
  const api = { getSummary: vi.fn(async () => []), listChannelStates: vi.fn(async () => []), getCandidateStates: vi.fn(), testChannelKeys: vi.fn() }
  const save = vi.fn(async () => 2)
  const config = structuredClone(DEFAULT_CONFIG)
  const { unmount } = render(<Channels config={config} api={api as never} save={save} revision={1} writable />)
  const kinds = screen.getByRole('combobox', { name: '新增渠道类型' })
  fireEvent.click(kinds); fireEvent.keyDown(kinds, { key: 'Escape' })
  expect(save).not.toHaveBeenCalled()
  unmount()
  const routing = render(<Routing config={config} api={api as never} save={save} revision={1} writable providers={[]} />)
  const route = screen.getByRole('combobox', { name: 'search渠道' })
  fireEvent.click(route); fireEvent.keyDown(route, { key: 'Escape' })
  expect(screen.queryByText('有未保存编辑')).toBeNull()
  expect(save).not.toHaveBeenCalled(); expect(api.getCandidateStates).not.toHaveBeenCalled()
  routing.unmount()
  render(<Usage config={config} api={api as never} providers={[]} />)
  await screen.findByText('筛选范围内暂无记录', { selector: 'strong' })
  expect(api.getSummary).toHaveBeenCalledTimes(1)
  for (const control of screen.getAllByRole('combobox')) { fireEvent.click(control); fireEvent.keyDown(control, { key: 'Escape' }) }
  expect(api.getSummary).toHaveBeenCalledTimes(1)
  expect(api.testChannelKeys).not.toHaveBeenCalled()
  expect(document.querySelector('select')).toBeNull()
})

it('已有历史账目提示不再暗示渠道被禁用，启用开关仍可编辑', async () => {
  const config = structuredClone(DEFAULT_CONFIG)
  const save = vi.fn(async () => 2)
  render(<Channels config={config} save={save} revision={1} writable api={{ listChannelStates: async () => [{ id: config.channels[0]!.id, used: true, canDelete: false, reason: '已有历史账目，仍可正常使用；不可删除或更换地址归属，不再使用时可停用', references: [] }] } as never} />)
  expect(await screen.findByText(/已有历史账目，仍可正常使用/)).toBeTruthy()
  const toggle = screen.getAllByRole('checkbox', { name: '启用' })[0] as HTMLInputElement
  expect(toggle.checked).toBe(true); expect(toggle.disabled).toBe(false)
})

it('保存中有可见提示，成功及revision快照更新后下拉立即恢复，不等待状态查询', async () => {
  let finish!: (revision: number) => void
  const save = vi.fn(() => new Promise<number>(resolve => { finish = resolve }))
  const api = { listChannelStates: vi.fn(async () => await new Promise(() => {})) }
  const config = structuredClone(DEFAULT_CONFIG)
  const { rerender } = render(<Channels config={config} api={api as never} save={save} revision={1} writable />)
  fireEvent.click(screen.getByRole('button', { name: '保存渠道配置' }))
  expect(screen.getByRole('button', { name: '保存中…' })).toBeTruthy()
  rerender(<Channels config={structuredClone(config)} api={api as never} save={save} revision={2} writable />)
  finish(2)
  await screen.findByText('已保存渠道配置')
  const trigger = screen.getByRole('combobox', { name: '新增渠道类型' }) as HTMLButtonElement
  expect(trigger.disabled).toBe(false)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('option', { name: '百度千帆 Search' }))
  expect(trigger.value).toBe('qianfan')
})

it('真实表单式通知更新成功后能重复展开，拒绝或抛错也不会永久禁用', async () => {
  let snapshot = { value: structuredClone(DEFAULT_CONFIG), revision: 1, writable: true }
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    mutate: vi.fn(async () => { snapshot = { ...snapshot, value: structuredClone(snapshot.value), revision: snapshot.revision + 1 }; listeners.forEach(fn => fn()); return true }),
  }
  render(<App form={form as never} api={{ getStatus: async () => ({ active: true }), listProviders: async () => [], listChannelStates: async () => [] } as never} />)
  for (const outcome of ['success', 'false', 'throw']) {
    if (outcome === 'false') form.mutate.mockResolvedValueOnce(false)
    if (outcome === 'throw') form.mutate.mockRejectedValueOnce(new Error('synthetic-save-error'))
    fireEvent.click(screen.getByRole('button', { name: '保存渠道配置' }))
    const trigger = screen.getByRole('combobox', { name: '新增渠道类型' }) as HTMLButtonElement
    await waitFor(() => expect(trigger.disabled).toBe(false))
    for (let i = 0; i < 3; i++) {
      fireEvent.click(trigger)
      expect(screen.getByRole('listbox')).toBeTruthy()
      fireEvent.keyDown(trigger, { key: 'Escape' })
    }
  }
  expect(form.mutate).toHaveBeenCalledTimes(3)
})

it('停用千帆在Search中可见并说明未启用，不出现在Fetch，不自动启用或保存', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.channels.push({ ...config.channels[0]!, id: 'qianfan-draft', name: '百度千帆', kind: 'qianfan', billingClass: 'service', enabled: false, capabilities: ['search'] })
  const save = vi.fn(async () => 2)
  render(<Routing config={config} api={{} as never} save={save} revision={1} writable providers={[]} />)
  const trigger = screen.getByRole('combobox', { name: 'search渠道' })
  fireEvent.click(trigger)
  const option = screen.getByRole('option', { name: /百度千帆.*未启用/ })
  expect(option.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(option)
  expect((trigger as HTMLButtonElement).value).toBe('')
  fireEvent.keyDown(trigger, { key: 'Escape' })
  fireEvent.click(screen.getByRole('combobox', { name: 'fetch渠道' }))
  expect(screen.queryByRole('option', { name: /百度千帆/ })).toBeNull()
  expect(config.channels.at(-1)!.enabled).toBe(false)
  expect(save).not.toHaveBeenCalled()
})

it('展开前的延迟滚动事件不误关闭，真正移动触发器时关闭，窗口事件不抛错', () => {
  render(<Select aria-label="渠道" value="a" onValueChange={vi.fn()}>{options}</Select>)
  const trigger = screen.getByRole('combobox')
  fireEvent.click(trigger)
  fireEvent.scroll(window)
  expect(screen.getByRole('listbox')).toBeTruthy()
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 0, right: 100, bottom: 134, height: 34, width: 100 } as DOMRect)
  fireEvent.scroll(document)
  expect(screen.queryByRole('listbox')).toBeNull()
})

it('当前值已停用或缺失时，打开再确认不擅自清空绑定，方向导航后才能改值', () => {
  const change = vi.fn()
  const { rerender } = render(<Select aria-label="渠道" value="x" onValueChange={change}>{options}</Select>)
  const trigger = screen.getByRole('combobox')
  for (const current of ['x', 'missing']) {
    rerender(<Select aria-label="渠道" value={current} onValueChange={change}>{options}</Select>)
    fireEvent.keyDown(trigger, { key: 'Enter' }); fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(change).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  }
  rerender(<Select aria-label="渠道" value="x" onValueChange={change}>{options}</Select>)
  fireEvent.keyDown(trigger, { key: 'Enter' }); fireEvent.keyDown(trigger, { key: 'ArrowDown' }); fireEvent.keyDown(trigger, { key: 'Enter' })
  expect(change).toHaveBeenCalledExactlyOnceWith('b')
})

it('滚动离开活动项后再次按End仍将末项滚入可视区', () => {
  render(<Select aria-label="长列表" value="0" onValueChange={vi.fn()}>{Array.from({ length: 200 }, (_, i) => <option key={i} value={String(i)}>渠道 {i}</option>)}</Select>)
  const trigger = screen.getByRole('combobox')
  fireEvent.keyDown(trigger, { key: 'End' })
  const list = screen.getByRole('listbox')
  list.scrollTop = 0; fireEvent.scroll(list)
  fireEvent.keyDown(trigger, { key: 'End' })
  expect(list.scrollTop).toBeGreaterThan(0)
})
