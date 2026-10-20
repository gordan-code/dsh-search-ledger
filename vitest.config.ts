// Host与Client测试使用各自环境，避免将两端Cordis类型混入一个编译上下文。
import { defineConfig } from 'vitest/config'
import ts from 'typescript'
export default defineConfig({
  plugins: [{ name: 'standard-remote-decorators', enforce: 'pre', transform(code, id) {
    if (id.endsWith('.ts') && /^\s*@Remote/m.test(code)) return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }, fileName: id }).outputText
  } }],
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], environment: 'node' },
})
