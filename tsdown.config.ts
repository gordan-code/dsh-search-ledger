// 仅转换标准装饰器；反射由独立脚本在受控分析工作区生成。
import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
const decorators = typertPlugin()
export default defineConfig([{
  entry: { index: 'src/index.ts', contracts: 'src/contracts.ts' }, format: 'esm', outDir: 'lib', clean: false, dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//, /^node:/, 'zod'] }, plugins: [{ name: 'billing-decorators', transform: decorators.transform }],
}, {
  // DSH使用classic script中的懒CJS factory，不接受顶层ESM import/export。
  entry: { client: 'src/client/index.ts' }, format: 'cjs', platform: 'browser', outDir: 'lib', clean: false, dts: false,
  banner: 'window.__ModuleLoader__.load({ id: "dsh-search-ledger", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
  outExtensions: () => ({ js: '.js' }), deps: { neverBundle: ['react', 'react/jsx-runtime'], alwaysBundle: ['zod', '@deepseek-ai/dsh-typert-protocol/remote-info'] },
}])
