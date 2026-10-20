import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../../src/index.ts'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'
import { routeStatus, routingDiagnostics, webSelection } from '../../src/host/diagnostics.ts'

it('实际WebRuntime选择优先于设置描述，不能把配置意向当作接管成功', () => {
  const ctx = new Context(); new TypertRegistry(ctx)
  ctx.provide('profileContext', { name: 'test', home: mkdtempSync(join(tmpdir(), 'billing-diagnostics-')) })
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'web', value: { searchProvider: 'web-search-metered', fetchProvider: 'web-fetch-metered' } }] } as never)
  ctx.provide('llm', { listProviders: () => [{ id: 'official', name: '官方模型' }] } as never)
  const live = { searchProvider: { get: () => 'deepseek-search-api' }, fetchProvider: { get: () => 'web-fetch-metered' } }
  new WebRuntime(ctx, live as never)
  ctx.provide('configEditor', { entries: () => [{ options: { id: 'web', name: '@deepseek-ai/dsh-web' }, fiber: { config: live } }] } as never)
  const config = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, { get: () => value }]))
  plugin.apply(ctx, config as never)
  const status = ctx.webSearchBilling.getStatus()
  expect(status.active).toBe(false)
  expect(status).toMatchObject({ operations: { search: { providerId: 'deepseek-search-api', metered: false }, fetch: { providerId: 'web-fetch-metered', metered: true } }, totalAttempts: 0, lastAttemptAt: null })
  expect(status.routes?.[0]?.search).toMatchObject({ channelId: null, ready: false, source: 'none' })
  expect(status.issues?.join(' ')).toContain('未绑定')
})
it('存在多个Web运行时entry时不随意认定第一个就是当前实例', () => {
  const ctx = new Context()
  const config = { searchProvider: { get: () => 'web-search-metered' }, fetchProvider: { get: () => 'web-fetch-metered' } }
  ctx.provide('configEditor', { entries: () => [
    { options: { name: '@deepseek-ai/dsh-web' }, fiber: { config } },
    { options: { name: '@deepseek-ai/dsh-web' }, fiber: { config } },
  ] } as never)
  expect(webSelection(ctx).trusted).toBe(false)
})
it('仅设置快照/自动选择未知不能冒充实际接管；路由不把未知费率视作不可用', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providerBindings.source = { search: 'deepseek-official-api', fetch: 'local-http' }
  config.channels[0]!.prices.search!.perThousand = null
  const state = routingDiagnostics(config, [{ id: 'source', name: '来源' }], { search: 'web-search-metered', fetch: undefined }, false, 'settings-only')
  expect(state.active).toBe(false)
  expect(state.operations.search).toMatchObject({ metered: false, selectionSource: 'settings-only', registered: null, available: null })
  expect(state.routes[0]).toMatchObject({ search: { channelId: 'deepseek-official-api', ready: true }, fetch: { channelId: 'local-http', ready: true } })
})
it('没有注册/不可用证据不能确认接管，全局无Provider的失效覆盖也必须报告', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.globalOverrides.search = 'missing'
  const state = routingDiagnostics(config, [], { search: 'web-search-metered', fetch: 'web-fetch-metered' }, true, 'runtime-entry', { search: { registered: false, available: true }, fetch: { registered: true, available: false } })
  expect(state.active).toBe(false)
  expect(state.operations.search.metered).toBe(false)
  expect(state.operations.fetch.metered).toBe(false)
  expect(state.issues.join(' ')).toContain('全局')
})
it('有序模式没有绑定时显示首个支持该能力的候选，而非谎报必然拒绝', () => {
  const config = { channels: [{ id: 's', enabled: true, capabilities: ['search'] }], providerBindings: {}, globalOverrides: {}, failover: { search: { enabled: true, attemptTimeoutMs: 20000, totalTimeoutMs: 60000 } } } as never
  expect(routeStatus(config, 'p', 'search')).toMatchObject({ channelId: 's', ready: true })
})
