// 测试临时数据固定在项目中，不依赖Windows共享临时目录权限。
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const tmp = resolve('.validation/tmp'); mkdirSync(tmp, { recursive: true })
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, TEMP: tmp, TMP: tmp } })
process.exit(result.status ?? 1)
