import { node } from './run.mjs'
import { existsSync, lstatSync, rmSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
const workspace = resolve('.')
const output = resolve('lib')
if (dirname(output) !== workspace || basename(output) !== 'lib') throw new Error('构建输出必须位于项目lib目录')
if (existsSync(output)) {
  if (lstatSync(output).isSymbolicLink()) throw new Error('拒绝清理符号链接构建目录')
  rmSync(output, { recursive: true, force: true })
}
// 先生成严格Remote，再输出两端声明和独立bundle。禁止只打包空反射。
node('scripts/generate-remote.mjs')
node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.host.json', '--emitDeclarationOnly')
node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json', '--emitDeclarationOnly')
node('node_modules/tsdown/dist/run.mjs')
node('--test', 'tests/packaging/manifest.test.mjs', 'tests/packaging/renderer.test.mjs', 'tests/packaging/desktop-cli.test.mjs')
