// @vitest-environment jsdom
import React from 'react'
import { changeControl } from './controls.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Channels } from '../../src/client/Channels.tsx'
import { Routing } from '../../src/client/Routing.tsx'
import { Usage } from '../../src/client/Usage.tsx'
import { App } from '../../src/client/App.tsx'
import { billingStyles } from '../../src/client/styles.ts'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('原生计量设置界面', () => {
  it('通过单一下拉选择渠道类型，点击添加只创建草稿', () => {
    const save = vi.fn(async () => 5)
    render(<Channels config={structuredClone(DEFAULT_CONFIG)} revision={4} writable save={save} />)
    const kinds = screen.getByRole('combobox', { name: '新增渠道类型' })
    fireEvent.click(kinds)
    expect(screen.getAllByRole('option')).toHaveLength(6)
    fireEvent.keyDown(kinds, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: '添加 searxng' })).toBeNull()
    changeControl(kinds, { target: { value: 'searxng' } })
    expect(screen.queryByDisplayValue('https://请填写实例地址')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
    expect(screen.getByDisplayValue('https://请填写实例地址')).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })

  it('窄容器布局允许控件收缩且状态标签独立换行', () => {
    expect(billingStyles).toContain('.dsh-web-billing .dsh-route-select { width: 100%; max-width: 100%; min-width: 0; }')
    expect(billingStyles).toMatch(/\.dsh-route-effective \{[^}]*grid-column: 2;[^}]*overflow-wrap: anywhere;/)
    expect(billingStyles).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr))')
    expect(billingStyles).toContain('.dsh-web-billing input[type="datetime-local"] { width: 100%; max-width: 100%; min-width: 0; }')
    expect(billingStyles).toMatch(/\.dsh-web-billing button \{[^}]*white-space: nowrap;/)
  })

  it('读取渠道状态并按 revision 安全归档未使用渠道', async () => {
    const save = vi.fn(async () => 5)
    const api = {
      listChannelStates: vi.fn(async () => [{ id: 'deepseek-official-api', used: false, canDelete: true, reason: null, references: [] }]),
      deleteChannel: vi.fn(async () => 6),
    }
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Channels api={api as never} config={structuredClone(DEFAULT_CONFIG)} revision={4} writable save={save} />)

    await screen.findByText('可以安全删除')
    fireEvent.click(screen.getByRole('button', { name: '删除渠道 DeepSeek 官方 API' }))

    await waitFor(() => expect(api.deleteChannel).toHaveBeenCalledWith('deepseek-official-api', 4))
    expect(screen.queryByText('DeepSeek 官方 API')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('渠道已归档')
  })

  it('保留被引用渠道并阻止破坏性删除', async () => {
    const api = {
      listChannelStates: vi.fn(async () => [{ id: 'deepseek-official-api', used: true, canDelete: false, reason: '仍被 relay/search 引用', references: ['relay/search'] }]),
    }
    render(<Channels api={api as never} config={structuredClone(DEFAULT_CONFIG)} revision={4} writable save={vi.fn(async () => 5)} />)

    expect(await screen.findByText(/仍被 relay\/search 引用/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '删除渠道 DeepSeek 官方 API' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('显示真实路由状态并从路由选项排除已归档渠道', async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.channels.push({ ...config.channels[0]!, id: 'archived-channel', name: '历史渠道', archived: true, enabled: false })
    render(<Routing
      config={config}
      providers={[{ id: 'relay', name: '中转' }]}
      status={{
        version: '0.2.0', profileId: 'p', namespace: 'n', coverage: 'local', active: true, configError: null,
        routes: [{ providerId: 'relay', search: { channelId: 'deepseek-official-api', source: 'binding', ready: true, reason: null }, fetch: { channelId: null, source: 'none', ready: false, reason: '未绑定' } }],
      }}
      api={{ getSessionOverride: vi.fn(), setSessionOverride: vi.fn() } as never}
      revision={2}
      writable
      save={vi.fn(async () => 3)}
    />)

    expect(screen.getByText('默认渠道已配置')).toBeTruthy()
    expect(screen.getByText('未绑定')).toBeTruthy()
    const route = screen.getAllByRole('combobox', { name: 'search渠道' })[0]!
    fireEvent.click(route)
    expect(screen.getByRole('option', { name: /DeepSeek 官方 API/ })).toBeTruthy()
    expect(screen.queryAllByRole('option', { name: /历史渠道/ })).toHaveLength(0)
    fireEvent.keyDown(route, { key: 'Escape' })
  })

  it('自动加载用量并忽略筛选变更后的旧响应', async () => {
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    const first = new Promise(resolve => { resolveFirst = resolve })
    const second = new Promise(resolve => { resolveSecond = resolve })
    const api = { getSummary: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) }
    render(<Usage config={DEFAULT_CONFIG} providers={[]} api={api as never} />)

    await waitFor(() => expect(api.getSummary).toHaveBeenCalledTimes(1))
    changeControl(screen.getByLabelText('筛选币种'), { target: { value: 'USD' } })
    await waitFor(() => expect(api.getSummary).toHaveBeenCalledTimes(2))
    resolveSecond([{ channelId: 'c2', channelName: '新结果', operation: 'search', currency: 'USD', total: 1, billable: 1, empty: 0, failed: 0, unknown: 0, priceUnknown: 0, amountMicros: '2', quotaCredits: 0 }])
    await screen.findByText('新结果')
    resolveFirst([{ channelId: 'c1', channelName: '旧结果', operation: 'search', currency: 'CNY', total: 1, billable: 1, empty: 0, failed: 0, unknown: 0, priceUnknown: 0, amountMicros: '1', quotaCredits: 0 }])
    await waitFor(() => expect(screen.queryByText('旧结果')).toBeNull())
  })

  it('限制原生样式作用域并在应用外壳显示运行状态', async () => {
    const form = { getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: structuredClone(DEFAULT_CONFIG) }), subscribe: () => () => {}, mutate: vi.fn(async () => true) }
    render(<App initialTab={1} api={{ getStatus: async () => ({ version: '0.2.0', profileId: 'p', namespace: 'n', coverage: 'local', active: true, configError: null, issues: ['未配置 fetch 路由'] }), listProviders: async () => [], getSummary: async () => [], listAttempts: async () => ({ items: [], nextCursor: null }) } as never} form={form as never} />)
    expect(document.querySelector('style')?.textContent).toContain('.dsh-web-billing')
    await screen.findByText('未配置 fetch 路由')
  })

  it('渠道保存期间锁定编辑并防止重复提交，失败后恢复编辑', async () => {
    let rejectSave!: (reason: Error) => void
    const pending = new Promise<number>((_, reject) => { rejectSave = reject })
    const save = vi.fn(() => pending)
    render(<Channels config={structuredClone(DEFAULT_CONFIG)} revision={4} writable save={save as never} />)

    const name = screen.getByDisplayValue('DeepSeek 官方 API') as HTMLInputElement
    changeControl(name, { target: { value: '保存前编辑' } })
    const saveButton = screen.getByRole('button', { name: '保存渠道配置' })
    fireEvent.click(saveButton)
    fireEvent.click(saveButton)

    expect(save).toHaveBeenCalledTimes(1)
    expect(name.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '添加渠道' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('combobox', { name: '新增渠道类型' }) as HTMLSelectElement).disabled).toBe(true)
    changeControl(name, { target: { value: '保存期间编辑' } })
    expect(name.value).toBe('保存前编辑')

    rejectSave(new Error('保存失败'))
    await screen.findByText('保存失败')
    expect(name.disabled).toBe(false)
    changeControl(name, { target: { value: '失败后可编辑' } })
    expect(name.value).toBe('失败后可编辑')
  })

  it('路由保存期间锁定选择并防止重复提交，失败后恢复编辑', async () => {
    let rejectSave!: (reason: Error) => void
    const pending = new Promise<number>((_, reject) => { rejectSave = reject })
    const save = vi.fn(() => pending)
    render(<Routing config={structuredClone(DEFAULT_CONFIG)} providers={[{ id: 'relay', name: '中转' }]} api={{} as never} revision={4} writable save={save as never} />)

    const search = screen.getAllByLabelText('search渠道')[0] as HTMLSelectElement
    changeControl(search, { target: { value: 'deepseek-official-api' } })
    const saveButton = screen.getByRole('button', { name: '保存绑定与全局覆盖' })
    fireEvent.click(saveButton)
    fireEvent.click(saveButton)

    expect(save).toHaveBeenCalledTimes(1)
    expect(search.disabled).toBe(true)
    changeControl(search, { target: { value: '' } })
    expect(search.value).toBe('deepseek-official-api')

    rejectSave(new Error('路由保存失败'))
    await screen.findByText('路由保存失败')
    expect(search.disabled).toBe(false)
    changeControl(search, { target: { value: '' } })
    expect(search.value).toBe('')
  })

  it('移除未保存草稿只改本地且保留其它草稿', async () => {
    const api = {
      listChannelStates: vi.fn(async () => []),
      deleteChannel: vi.fn(async () => 9),
    }
    render(<Channels api={api as never} config={structuredClone(DEFAULT_CONFIG)} revision={4} writable save={vi.fn(async () => 5)} />)

    await waitFor(() => expect(api.listChannelStates).toHaveBeenCalled())
    changeControl(screen.getByRole('combobox', { name: '新增渠道类型' }), { target: { value: 'searxng' } })
    fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
    const draftButton = await screen.findByRole('button', { name: /删除渠道 searxng-/ })
    fireEvent.click(draftButton)

    expect(api.deleteChannel).not.toHaveBeenCalled()
    expect(screen.getByText('DeepSeek 官方 API')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '本地 HTTP 抓取' })).toBeTruthy()
    expect(screen.queryAllByText(/searxng-/)).toHaveLength(0)
  })

  it('混合已知与未知价格时显示已知部分并提示总额不完整', async () => {
    const base = { channelId: 'c', channelName: '渠道', operation: 'search' as const, total: 1, billable: 1, empty: 0, failed: 0, unknown: 0, quotaCredits: 0 }
    const api = {
      getSummary: vi.fn(async () => [
        { ...base, currency: 'CNY' as const, amountMicros: '5000', priceUnknown: 0 },
        { ...base, currency: 'CNY' as const, amountMicros: '0', priceUnknown: 1 },
      ]),
    }
    render(<Usage config={DEFAULT_CONFIG} providers={[]} api={api as never} />)

    expect(await screen.findByText('CNY 已知 0.005000')).toBeTruthy()
    expect(screen.getByText(/总额不完整/)).toBeTruthy()
  })

  it('已知金额保留且分别提示未确认与未知价格次数', async () => {
    const api = {
      getSummary: vi.fn(async () => [{
        channelId: 'c', channelName: '渠道', operation: 'search' as const, currency: 'CNY' as const,
        total: 4, billable: 1, empty: 1, failed: 1, unknown: 1, priceUnknown: 2,
        amountMicros: '5000', quotaCredits: 0,
      }]),
    }
    render(<Usage config={DEFAULT_CONFIG} providers={[]} api={api as never} />)

    expect(await screen.findByText('CNY 已知 0.005000')).toBeTruthy()
    expect(screen.getByText(/未确认 1 次/)).toBeTruthy()
    expect(screen.getByText(/未知价格 2 次/)).toBeTruthy()
    expect(screen.getByText(/总额不完整/)).toBeTruthy()
  })

  it('筛选变更加载期间清空旧结果，完成后只显示新结果', async () => {
    let resolveSecond!: (value: unknown) => void
    const second = new Promise(resolve => { resolveSecond = resolve })
    const oldRow = { channelId: 'old', channelName: '旧结果', operation: 'search' as const, currency: 'CNY' as const, total: 1, billable: 1, empty: 0, failed: 0, unknown: 0, priceUnknown: 0, amountMicros: '1', quotaCredits: 0 }
    const newRow = { channelId: 'new', channelName: '新结果', operation: 'search' as const, currency: 'USD' as const, total: 1, billable: 1, empty: 0, failed: 0, unknown: 0, priceUnknown: 0, amountMicros: '2', quotaCredits: 0 }
    const api = { getSummary: vi.fn().mockResolvedValueOnce([oldRow]).mockReturnValueOnce(second) }
    render(<Usage config={DEFAULT_CONFIG} providers={[]} api={api as never} />)

    await screen.findByText('旧结果')
    changeControl(screen.getByLabelText('筛选币种'), { target: { value: 'USD' } })
    await waitFor(() => expect(api.getSummary).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('旧结果')).toBeNull()

    resolveSecond([newRow])
    await screen.findByText('新结果')
  })

  it('读取已保存渠道状态失败时锁定地址但允许草稿编辑', async () => {
    const api = { listChannelStates: vi.fn(async () => { throw new Error('状态读取失败') }) }
    render(<Channels api={api as never} config={structuredClone(DEFAULT_CONFIG)} revision={4} writable save={vi.fn(async () => 5)} />)

    await screen.findByText('状态读取失败')
    expect((screen.getByDisplayValue('https://api.deepseek.com/v1/tools') as HTMLInputElement).disabled).toBe(true)
    changeControl(screen.getByRole('combobox', { name: '新增渠道类型' }), { target: { value: 'searxng' } })
    fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
    const draftEndpoint = await screen.findByDisplayValue('https://请填写实例地址')
    expect((draftEndpoint as HTMLInputElement).disabled).toBe(false)
  })

  it('缺少已保存渠道状态时锁定地址但允许草稿编辑', async () => {
    const api = { listChannelStates: vi.fn(async () => []) }
    render(<Channels api={api as never} config={structuredClone(DEFAULT_CONFIG)} revision={4} writable save={vi.fn(async () => 5)} />)

    await waitFor(() => expect(api.listChannelStates).toHaveBeenCalled())
    expect((screen.getByDisplayValue('https://api.deepseek.com/v1/tools') as HTMLInputElement).disabled).toBe(true)
    changeControl(screen.getByRole('combobox', { name: '新增渠道类型' }), { target: { value: 'searxng' } })
    fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
    const draftEndpoint = await screen.findByDisplayValue('https://请填写实例地址')
    expect((draftEndpoint as HTMLInputElement).disabled).toBe(false)
  })

  it('渠道样式限制卡片列宽并保持表单控件整体布局', () => {
    expect(billingStyles).toMatch(/\.dsh-web-billing \{[\s\S]*width: 100%;[\s\S]*min-width: 0;[\s\S]*overflow-wrap: anywhere;/)
    expect(billingStyles).toContain('.dsh-channel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); align-items: start;')
    expect(billingStyles).toContain('.dsh-web-billing .dsh-form-grid { display: grid; grid-template-columns: minmax(0, 1fr);')
    expect(billingStyles).toContain('.dsh-web-billing .dsh-price-row > label { display: grid;')
    expect(billingStyles).toMatch(/@media \(max-width: 760px\) \{[\s\S]*\.dsh-web-billing \.dsh-card-header \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/)
  })
})
