// 安装标识原子持久化；数据库已有额度时材料丢失必须拒绝静默重置。
import { it, expect } from 'vitest'
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installationSubject } from '../../src/host/installation.ts'
it('同安装相同凭证稳定指纹，材料丢失不重置已有数据库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-install-'))
  const a = installationSubject(dir); const b = installationSubject(dir)
  expect(a('synthetic-secret')).toBe(b('synthetic-secret'))
  expect(a('synthetic-secret')).not.toContain('synthetic-secret')
  writeFileSync(join(dir, 'usage.sqlite'), '')
  unlinkSync(join(dir, 'installation-salt'))
  expect(() => installationSubject(dir)).toThrow('缺失')
})
