import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { desktopPackageRuntime } from '../../scripts/desktop-cli.mjs'
test('桌面CLI显式使用内置pnpm，不通过PATH调用全局pnpm', () => {
  mkdirSync('.validation', { recursive: true })
  const app = mkdtempSync(resolve('.validation/desktop-runtime-'))
  mkdirSync(join(app, 'node_modules/pnpm/bin'), { recursive: true })
  writeFileSync(join(app, 'node_modules/pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: '11.8.0' }))
  writeFileSync(join(app, 'node_modules/pnpm/bin/pnpm.cjs'), '')
  const runtime = desktopPackageRuntime(app)
  assert.equal(runtime.command, process.execPath)
  assert.deepEqual(runtime.args, [join(app, 'node_modules/pnpm/bin/pnpm.cjs')])
  assert.equal(runtime.version, '11.8.0')
  assert.throws(() => desktopPackageRuntime(join(app, 'missing')), /pnpm/)
})

test('发布时间豁免只能显式启用，作为本次pnpm参数且不转发给DSH CLI', () => {
  mkdirSync('.validation', { recursive: true })
  const app = mkdtempSync(resolve('.validation/desktop-policy-'))
  mkdirSync(join(app, 'node_modules/pnpm/bin'), { recursive: true })
  writeFileSync(join(app, 'node_modules/pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: '11.8.0' }))
  writeFileSync(join(app, 'node_modules/pnpm/bin/pnpm.cjs'), '')
  mkdirSync(join(app, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
  writeFileSync(join(app, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(app, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    'export async function runCli(options) { console.log(JSON.stringify({ options, argv: process.argv.slice(2) })) }')
  const args = ['plugin', '--profile', 'desktop', 'add', 'fixture.tgz', '--ignore-scripts']
  const invoke = extra => {
    const result = spawnSync(process.execPath, [resolve('scripts/desktop-cli.mjs'), ...extra, ...args], {
      env: { ...process.env, DSH_DESKTOP_APP_ROOT: app }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return { ...JSON.parse(result.stdout), stderr: result.stderr }
  }
  const safeDefault = invoke([])
  assert.deepEqual(safeDefault.options.packageManager.args, [join(app, 'node_modules/pnpm/bin/pnpm.cjs')])
  assert.deepEqual(safeDefault.argv, args)
  const optedIn = invoke(['--desktop-release-policy'])
  assert.deepEqual(optedIn.options.packageManager.args, [join(app, 'node_modules/pnpm/bin/pnpm.cjs'), '--config.minimumReleaseAge=0'])
  assert.deepEqual(optedIn.argv, args)
  assert.equal(optedIn.options.manageDesktopProfile, true)
  assert.match(optedIn.stderr, /仅本次.*发布时间/)
  assert.doesNotMatch(safeDefault.stderr, /仅本次/)
})
