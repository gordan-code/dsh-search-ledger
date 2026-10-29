// 原生WebRuntime选择计量router，未绑定时明确失败而不是暗中使用收费官方渠道。
import { it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as plugin from '../../src/index.ts'
import { DEFAULT_CONFIG } from '../../src/routing/resolver.ts'
import { TYPERT } from '../../lib/typert.host.js'
it('Host贡献仅由Typert Loader登记，插件apply不能抢先注册导致重载冲突', () => {
  const ctx = new Context(); const registry = new TypertRegistry(ctx)
  ctx.provide('profileContext', { name: 'test', home: mkdtempSync(join(tmpdir(), 'billing-typert-')) })
  ctx.provide('credentials', { resolve: async () => undefined })
  new WebRuntime(ctx, { searchProvider: { get: () => 'web-search-metered' }, fetchProvider: { get: () => 'web-fetch-metered' } } as never)
  const config = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, { get: () => value }]))
  plugin.apply(ctx, config as never)
  expect(registry.getPackage('dsh-search-ledger', 'host')).toBeUndefined()
  expect(() => registry.register(TYPERT)).not.toThrow()
})
it('Host入口能注册两个router并通过宿主available预检查', async () => {
  expect(typeof plugin.apply).toBe('function')
  const ctx = new Context(); new TypertRegistry(ctx)
  ctx.provide('profileContext', { name: 'test', home: mkdtempSync(join(tmpdir(), 'billing-plugin-')) })
  ctx.provide('credentials', { resolve: async () => undefined })
  new WebRuntime(ctx, { searchProvider: { get: () => 'web-search-metered' }, fetchProvider: { get: () => 'web-fetch-metered' } } as never)
  const config = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, { get: () => value }]))
  plugin.apply(ctx, config as never)
  await expect(ctx.web.search({ query: 'synthetic' })).rejects.toMatchObject({ code: 'ROUTE_UNBOUND' })
  expect(ctx.searchLedger.getStatus().profileId).toBe('test')
  expect(ctx.searchLedger.getSummary({})).toEqual([])
})
it('插件卸载清理provider，重新加载没有重复ID', async () => {
  const ctx = new Context(); new TypertRegistry(ctx)
  ctx.provide('profileContext', { name: 'test', home: mkdtempSync(join(tmpdir(), 'billing-reload-')) })
  ctx.provide('credentials', { resolve: async () => undefined })
  new WebRuntime(ctx, { searchProvider: { get: () => 'web-search-metered' }, fetchProvider: { get: () => 'web-fetch-metered' } } as never)
  const config = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, { get: () => value }]))
  const mount = () => ctx.plugin({ name: 'smoke-wrapper', apply: child => plugin.apply(child, config as never) })
  const fiber = await mount()
  await expect(ctx.web.search({ query: 'synthetic' })).rejects.toMatchObject({ code: 'ROUTE_UNBOUND' })
  await fiber.dispose()
  await expect(ctx.web.search({ query: 'synthetic' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  const reloaded = await mount()
  await expect(ctx.web.search({ query: 'synthetic' })).rejects.toMatchObject({ code: 'ROUTE_UNBOUND' })
  await reloaded.dispose()
})
it('会话覆盖使用真实AgentRegistry，跨profile或未打开会话拒绝', () => {
  const ctx = new Context(); new TypertRegistry(ctx); const agents = new AgentRegistry(ctx)
  ctx.provide('profileContext', { name: 'local', home: mkdtempSync(join(tmpdir(), 'billing-session-')) })
  ctx.provide('credentials', { resolve: async () => undefined })
  new WebRuntime(ctx, { searchProvider: { get: () => 'web-search-metered' }, fetchProvider: { get: () => 'web-fetch-metered' } } as never)
  const config = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, { get: () => value }]))
  plugin.apply(ctx, config as never)
  agents.enter({ id: 'opened-session', session: { id: 'opened-session' } } as never, undefined)
  expect(ctx.searchLedger.setSessionOverride('opened-session', 'search', 'deepseek-official-api', 0)).toMatchObject({ revision: 1, search: 'deepseek-official-api' })
  expect(ctx.searchLedger.getSessionOverride('opened-session').search).toBe('deepseek-official-api')
  expect(() => ctx.searchLedger.getSessionOverride('other-profile-session')).toThrow('未在本profile')
  expect(ctx.searchLedger.setSessionOverride('opened-session', 'search', null, 1)).toMatchObject({ revision: 2, search: null })
})
