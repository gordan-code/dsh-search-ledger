// 验证外部插件安装必需的清单，而不导入尚未实现的运行时代码。
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import test from 'node:test'
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
test('bundle具有实际patch及独立Host/Client/Remote导出', () => {
  assert.equal(pkg.engines.dsh, '0.2.1-rc.2')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const key of ['.', './client', './typert', './remote']) assert.ok(pkg.exports[key])
  assert.ok(existsSync(new URL('../../cordis.patch.yml', import.meta.url)), '安装patch尚未创建')
})

test('发布名统一为dsh-search-ledger，保留旧配置与凭据及账本身份', () => {
  assert.equal(pkg.name, 'dsh-search-ledger')
  for (const word of ['dsh', 'web-search', 'web-fetch', 'billing']) assert.ok(pkg.keywords.includes(word))
  const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /name: dsh-search-ledger\b/)
  assert.match(patch, /id: web-search-billing\b/)
  const host = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /directory = join\(home, 'web-search-billing'\)/)
  const credentials = readFileSync(new URL('../../src/host/channel-credentials.ts', import.meta.url), 'utf8')
  assert.match(credentials, /'web-search-billing'/)
  const client = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(client, /configForms\.get<RoutingConfig>\('web-search-billing'\)/)
  assert.match(client, /label: \(\) => 'DSH 搜索账本'/)
})

test('中英文README可互相切换且随包发布，不携带代理工作文档', () => {
  const chinese = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const english = readFileSync(new URL('../../README.en.md', import.meta.url), 'utf8')
  assert.match(chinese, /\[English\]\(\.\/README\.en\.md\)/)
  assert.match(english, /\[简体中文\]\(\.\/README\.md\)/)
  assert.ok(pkg.files.includes('README.md'))
  assert.ok(pkg.files.includes('README.en.md'))
  assert.equal(pkg.files.some(path => /(?:helloagents|agents\.md|\.tgz)/i.test(path)), false)
})

test('发布入口、声明和严格Remote反射均存在且可加载', async () => {
  assert.equal(existsSync(new URL('../../lib/index.mjs', import.meta.url)), false, '不应携带旧构建的残留入口')
  for (const entry of Object.values(pkg.exports)) {
    for (const path of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      assert.ok(existsSync(new URL(`../../${path}`, import.meta.url)), `缺少发布文件：${path}`)
    }
  }
  const host = await import('../../lib/index.js')
  assert.equal(typeof host.apply, 'function')
  const { TYPERT } = await import('../../lib/typert.host.js')
  assert.ok(JSON.stringify(TYPERT).includes('webSearchBilling'))
  assert.ok(JSON.stringify(TYPERT).includes('getSummary'))
  const { TYPERT_REMOTE } = await import('../../lib/typert.remote-client.js')
  assert.ok(TYPERT_REMOTE)
  const client = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /from ["']node:|node:sqlite|credential-subject\.salt/)
})
