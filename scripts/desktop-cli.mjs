// 本机桌面修复入口：沿用官方CLI事务与兼容检查，显式绑定安装自带的pnpm。
// 不切换全局store、不删除依赖树、不绕过官方插件管理。
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
export function desktopPackageRuntime(appRoot, { desktopReleasePolicy = false } = {}) {
  const root = resolve(appRoot)
  const manifest = join(root, 'node_modules/pnpm/package.json')
  const entry = join(root, 'node_modules/pnpm/bin/pnpm.cjs')
  if (!existsSync(manifest) || !existsSync(entry)) throw new Error('桌面安装目录没有内置pnpm，请检查DSH_DESKTOP_APP_ROOT')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  if (pkg.name !== 'pnpm' || !/^\d+\.\d+\.\d+/.test(pkg.version)) throw new Error('桌面内置pnpm清单无效')
  // 与桌面withDesktopPnpmPolicy一致，但仅在用户显式选择本次豁免时启用。
  const args = desktopReleasePolicy ? [entry, '--config.minimumReleaseAge=0'] : [entry]
  return { command: process.execPath, args, version: pkg.version }
}
export async function main(args = process.argv.slice(2)) {
  const desktopReleasePolicy = args[0] === '--desktop-release-policy'
  const cliArgs = desktopReleasePolicy ? args.slice(1) : args
  const root = resolve(process.env.DSH_DESKTOP_APP_ROOT ?? 'D:/DevelopTools/dsh-desktop/DSH Desktop/resources/app')
  const runtime = desktopPackageRuntime(root, { desktopReleasePolicy })
  const cli = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!existsSync(cli)) throw new Error('桌面安装目录缺少DSH CLI')
  if (!cliArgs.length) throw new Error('请传入plugin --profile desktop add <修复包路径>')
  console.error(`使用桌面内置pnpm ${runtime.version}；不会修改全局pnpm/store配置`)
  if (desktopReleasePolicy) console.error('仅本次沿用桌面官方策略：跳过所有依赖的发布时间检查；不写入用户配置')
  const { runCli } = await import(pathToFileURL(cli).href)
  process.argv = [process.execPath, cli, ...cliArgs]
  await runCli({ manageDesktopProfile: true, packageManager: { command: runtime.command, args: runtime.args } })
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
