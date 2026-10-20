// 仅用于已安装插件的项目隔离profile；禁止读取真实DSH_HOME、发外网请求或调用LLM。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolve, join } from 'node:path'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
const root = resolve('.validation/dsh-home')
process.env.DSH_HOME = root
process.env.DSH_TELEMETRY_DISABLED = '1'
const profile = process.argv[2] ?? 'billing-v020-test'
if (!/^billing-(test|package-test|v020-test)$/.test(profile)) throw new Error('仅允许项目隔离测试profile')
const overlay = join(root, 'profiles', profile, 'cordis.patch.yml')
// 重复验收时保留已归档ID；不能靠重写夹具复活渠道或擦除旧账本。
const database = join(root, 'web-search-billing', 'usage.sqlite')
let retired = []
let priorFallback = []
if (existsSync(database)) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_retirements'").get()) {
      retired = db.prepare('SELECT channel_id, identity FROM channel_retirements WHERE profile_id=?').all(profile)
      for (const row of retired) {
        assert.match(row.channel_id, /^smoke-unused(?:-[a-f0-9-]+)?$/)
        assert.deepEqual(JSON.parse(row.identity), ['searxng', 'free', 'https://unused.example.test'])
      }
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_identities'").get()) {
      priorFallback = db.prepare("SELECT channel_id FROM channel_identities WHERE profile_id=? AND channel_id LIKE 'smoke-fallback-first-%'").all(profile)
      for (const row of priorFallback) assert.match(row.channel_id, /^smoke-fallback-first-[a-f0-9-]+$/)
    }
  } finally { db.close() }
}
const unused = `smoke-unused-${randomUUID()}`
const unusedChannel = (id, archived) => `      - id: ${id}
        name: 可删除的未用渠道
        kind: searxng
        billingClass: free
        enabled: false
        archived: ${archived}
        endpointBase: https://unused.example.test
        capabilities: [search]
        prices:
          search: { perThousand: '0', currency: CNY, policy: free }
`
const previousChannel = id => `      - id: ${id}
        name: 历史接力渠道
        kind: searxng
        billingClass: free
        enabled: false
        endpointBase: https://search.example.test/first
        capabilities: [search]
        prices:
          search: { perThousand: '0', currency: CNY, policy: free }
`
const service = (kind, endpointBase, capabilities) => ({
  id: `smoke-missing-${kind}`, name: `无Key的${kind}`, kind, billingClass: 'service', enabled: true,
  endpointBase, capabilities, prices: Object.fromEntries(capabilities.map(operation => [operation, { perThousand: null, currency: 'CNY', policy: 'provider-success' }])),
})
const services = [service('tinyfish', 'https://api.search.tinyfish.ai', ['search', 'fetch']), service('qianfan', 'https://qianfan.baidubce.com/v2/ai_search/web_search', ['search']), service('tavily', 'https://api.tavily.com', ['search', 'fetch'])]
mkdirSync(resolve('.validation'), { recursive: true })
writeFileSync(overlay, `- id: web-search-billing
  config:
    channels:
      - id: smoke-searxng
        name: 隔离模拟搜索
        kind: searxng
        billingClass: free
        enabled: true
        endpointBase: https://search.example.test
        capabilities: [search]
        prices:
          search: { perThousand: '0', currency: CNY, policy: free }
${services.map(channel => `      - ${JSON.stringify(channel)}\n`).join('')}${retired.map(row => unusedChannel(row.channel_id, true)).join('')}${priorFallback.map(row => previousChannel(row.channel_id)).join('')}${unusedChannel(unused, false)}\
    globalOverrides: { search: smoke-searxng }
`)
const originalFetch = globalThis.fetch
let calls = 0
let fallback = false
let manualMode = false, manualCalls = 0
globalThis.fetch = async (url, init) => {
  const origin = new URL(String(url)).origin
  if (manualMode && ['https://api.search.tinyfish.ai', 'https://api.fetch.tinyfish.ai'].includes(origin)) {
    manualCalls++
    if (new Headers(init?.headers).get('X-API-Key') === 'synthetic-pool-a') return new Response('{}', { status: 401 })
    return new Response(JSON.stringify({ results: [{ title: 'synthetic', url: 'https://example.com/', text: 'synthetic fetch', content: 'synthetic' }] }))
  }
  assert.equal(new URL(String(url)).origin, 'https://search.example.test', '测试禁止其他网络请求')
  calls++
  if (fallback && new URL(String(url)).pathname.startsWith('/first/')) return new Response('{}', { status: 429 })
  return new Response(JSON.stringify({ results: [{ title: '合成结果', url: 'https://example.test/doc', content: '合成摘要' }] }), { status: 200 })
}
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('dsh', root), profile, patchFiles: [], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
try {
  assert.equal(ctx.profileContext.home, root)
  const status = ctx.webSearchBilling.getStatus()
  assert.equal(status.version, '0.5.1', '必须验证新版而非旧安装缓存')
  assert.ok(ctx.typert.getPackage('dsh-web-search-billing', 'host'), 'Host反射须由真实Typert Loader登记')
  assert.equal(status.active, true)
  assert.equal(status.configError, null)
  assert.ok(ctx.settings.describe().some(row => String(row.ns) === 'web-search-billing'))
  const before = ctx.webSearchBilling.getSummary({}).reduce((n, row) => n + row.total, 0)
  const result = await ctx.web.search({ query: 'synthetic smoke', maxResults: 1 })
  assert.equal(result.sources.length, 1)
  const rows = ctx.webSearchBilling.getSummary({})
  assert.equal(rows.reduce((n, row) => n + row.total, 0), before + 1)
  assert.equal(rows[0].amountMicros, '0')
  assert.equal(calls, 1)
  const revision = ctx.settings.describe().find(row => String(row.ns) === 'web-search-billing').revision
  await assert.rejects(ctx.webSearchBilling.deleteChannel(unused, revision + 1), /changed|revision/i)
  assert.equal(ctx.webSearchBilling.listChannelStates().find(row => row.id === unused).canDelete, true)
  const nextRevision = await ctx.webSearchBilling.deleteChannel(unused, revision)
  assert.ok(nextRevision > revision)
  const updated = ctx.settings.describe().find(row => String(row.ns) === 'web-search-billing').value
  assert.equal(updated.channels.find(row => row.id === unused).archived, true)
  await assert.rejects(ctx.webSearchBilling.deleteChannel('smoke-searxng', nextRevision), { code: 'CHANNEL_IN_USE' })
  assert.equal(ctx.webSearchBilling.getSummary({}).reduce((n, row) => n + row.total, 0), before + 1)
  assert.equal(calls, 1, '诊断和渠道管理不能发送Web请求')
  const active = ctx.settings.describe().find(row => String(row.ns) === 'web-search-billing')
  const old = structuredClone(active.value)
  const first = { ...old.channels.find(row => row.id === 'smoke-searxng'), id: `smoke-fallback-first-${randomUUID()}`, name: '模拟限流', endpointBase: 'https://search.example.test/first' }
  await ctx.settings.mutate('web-search-billing', [
    { op: 'set', path: ['channels'], value: [...services, first, ...old.channels.filter(channel => !services.some(service => service.id === channel.id))] },
    { op: 'set', path: ['globalOverrides'], value: {} },
    { op: 'set', path: ['failover'], value: { search: { enabled: true, attemptTimeoutMs: 1000, totalTimeoutMs: 5000 } } },
  ], active.revision)
  fallback = true
  const result2 = await ctx.web.search({ query: 'synthetic fallback', maxResults: 1 })
  assert.equal(result2.sources.length, 1)
  assert.equal(calls, 3, '三种缺Key渠道零请求，SearXNG限流后仅向下一项发一次')
  const related = ctx.webSearchBilling.listAttempts({}, null, 200).items
  const firstRow = related.find(row => row.channelId === first.id)
  assert.equal(firstRow.outcome, 'failed')
  assert.equal(related.filter(row => row.operationId === firstRow.operationId).length, 2)
  const candidateStatus = await ctx.webSearchBilling.getCandidateStates('search', null, null)
  assert.equal(candidateStatus.filter(row => row.channelId.startsWith('smoke-missing-')).every(row => row.credentialReady === false), true)
  assert.equal(calls, 3, '读取候选就绪状态不发送请求')
  const poolId = 'smoke-missing-tinyfish'
  assert.equal((await ctx.webSearchBilling.getChannelCredential(poolId, '')).keyCount, 0)
  const stored = await ctx.webSearchBilling.setChannelCredential(poolId, '', ['synthetic-pool-a', 'synthetic-pool-b'])
  assert.equal(stored.keyCount, 2); assert.equal(stored.source, 'pool')
  assert.equal(JSON.stringify(stored).includes('synthetic-pool'), false)
  assert.equal((await ctx.webSearchBilling.getChannelCredential(poolId, '')).keyCount, 2)
  assert.equal((await ctx.webSearchBilling.getCandidateStates('search', null, null)).find(row => row.channelId === poolId).credentialReady, true)
  assert.equal((await ctx.webSearchBilling.unsetChannelCredential(poolId, '')).configured, false)
  assert.equal(calls, 3, 'Key管理只读写隔离宿主凭据，不发送请求')
  const testChannel = ctx.settings.describe().find(row => String(row.ns) === 'web-search-billing').value.channels.find(channel => channel.id === poolId)
  const signature = operation => { const price = testChannel.prices[operation]; return JSON.stringify([testChannel.id, testChannel.name, testChannel.kind, testChannel.billingClass, testChannel.enabled, testChannel.archived ?? false, testChannel.endpointBase, testChannel.credentialRef ?? '', [...testChannel.capabilities].sort(), operation, price?.perThousand ?? null, price?.currency ?? null, price?.policy ?? null, testChannel.monthlyCredits ?? 1000]) }
  manualMode = true
  const tested = await ctx.webSearchBilling.testChannelKeys(poolId, '', 'search', ['synthetic-pool-a', 'synthetic-pool-b'], 2, signature('search'))
  assert.deepEqual(tested.results.map(row => row.state), ['auth-rejected', 'success'])
  assert.equal(JSON.stringify(tested).includes('synthetic-pool'), false)
  const fetchTest = await ctx.webSearchBilling.testChannelKeys(poolId, '', 'fetch', ['synthetic-pool-b'], 1, signature('fetch'))
  assert.equal(fetchTest.results[0].state, 'success')
  assert.equal(manualCalls, 3, '手动测试只对指定渠道逐Key各一次')
  const attempts = ctx.webSearchBilling.listAttempts({}, null, 200).items
  assert.equal(attempts.filter(row => row.operationId === tested.operationId).length, 2)
  assert.equal(attempts.filter(row => row.operationId === fetchTest.operationId).length, 1)
  assert.equal((await ctx.webSearchBilling.getChannelCredential(poolId, '')).configured, false, '输入测试不自动保存Key')
  console.log('隔离profile：Key输入Search/Fetch测试、401/成功、3次实际模拟请求=3条账目、不转渠道/不保存通过')
  console.log('隔离profile：多Key宿主持久化、脱敏状态、候选池就绪与移除通过')
  console.log('隔离profile：Loader/Settings/Remote/WebRuntime、模拟落账、真实revision冲突和安全删除通过')
  console.log('隔离profile：三种新渠道缺Key跳过、有序限流接力、共享operationId及逐尝试计量通过')
} finally {
  globalThis.fetch = originalFetch
  await shutdown.shutdown(0)
}
