// 使用固定版本的真实浏览器ModuleLoader，按classic script执行发布产物。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createContext, Script } from 'node:vm'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { apply as installGatewayClient } from '@deepseek-ai/dsh-api-gateway/client'
const require = createRequire(import.meta.url)
test('Renderer实际Loader可注册并materialize插件，依赖只使用宿主React种子', async () => {
  const queue = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration) } }
  const context = createContext({ window: { __ModuleLoader__: queue }, console, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout })
  const loaderCode = readFileSync(require.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8')
  new Script(loaderCode, { filename: 'official-client-modules.js' }).runInContext(context)
  const bootstrap = queue.pendingQueue.pop()
  assert.equal(bootstrap.id, '@deepseek-ai/dsh-client-modules')
  const exports = bootstrap.factory(name => { throw new Error(`Loader本身不应依赖其他模块：${name}`) })
  const modules = new exports.ClientModuleSystem({
    manifest: { rev: 'test', modules: [], plugins: [] },
    staticModules: { react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime') },
    bootstrapModule: { id: bootstrap.id, exports }, registrationTarget: queue,
    loadBundle: async () => { throw new Error('本测试禁止网络') },
  })
  const clientCode = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  new Script(clientCode, { filename: 'dsh-web-search-billing-client.js' }).runInContext(context)
  const client = await modules.import('dsh-web-search-billing')
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(Array.from(client.inject), ['remote'])
  // 进一步经过真实Cordis和Remote挂载，不只是检查包里有没有某段文本。
  const ctx = new Context(); new TypertRegistry(ctx)
  ctx.provide('connection', { interactions: 'none', rpc: { open() { throw new Error('禁止网络') } }, generation: { getSnapshot: () => undefined, subscribe: () => () => {} } })
  installGatewayClient(ctx)
  let panel = null; let removed = false
  ctx.provide('configForms', {
    get: id => { assert.equal(id, 'web-search-billing'); return {} },
    whileServed: (names, register) => { assert.deepEqual(Array.from(names), ['web-search-billing']); return register(new Set(names)) },
  })
  // 配置页必须挂到设置侧边栏（settings.section），而不是插件管理器的内置插件列表。
  ctx.provide('slots', {
    inject: (name, register) => { assert.equal(name, 'settings.section'); return register() },
    register: (meta, component) => {
      assert.equal(meta.name, 'settings.section')
      assert.equal(meta.id, 'web-search-billing')
      assert.equal(meta.order, 21)
      assert.equal(meta.label(), '搜索渠道与费用')
      panel = component; return () => { removed = true }
    },
  })
  const fiber = await ctx.plugin(client)
  assert.equal(typeof ctx.remote.webSearchBilling.getSummary, 'function')
  assert.equal(typeof panel, 'function', 'Remote挂载后配置页必须实际激活')
  await fiber.dispose()
  assert.equal(removed, true)
})
