// 安装级随机盐不包含API凭证；指纹只在Host用于跨profile共享本地额度。
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BillingError } from '../contracts.ts'
export function installationSubject(directory: string): (credential: string) => string {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink()) throw new BillingError('STORE_PATH_INVALID', '插件数据目录不能是符号链接')
  const root = realpathSync(directory); const saltPath = join(root, 'installation-salt'); const dbPath = join(root, 'usage.sqlite')
  if (!existsSync(saltPath)) {
    if (existsSync(dbPath)) throw new BillingError('INSTALLATION_MATERIAL_MISSING', '安装材料缺失，不能静默重置已有额度；请恢复原安装数据')
    try { writeFileSync(saltPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new BillingError('STORE_UNAVAILABLE', '无法创建安装材料') }
  }
  if (lstatSync(saltPath).isSymbolicLink() || (existsSync(dbPath) && lstatSync(dbPath).isSymbolicLink())) throw new BillingError('STORE_PATH_INVALID', '插件数据文件不能是符号链接')
  const salt = readFileSync(saltPath, 'utf8')
  if (!/^[a-f0-9]{64}$/.test(salt)) throw new BillingError('INSTALLATION_MATERIAL_INVALID', '安装材料未完整写入或损坏，请恢复原数据')
  const stamp = createHash('sha256').update(salt).digest('hex')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS installation_identity (id INTEGER PRIMARY KEY CHECK(id=1), stamp TEXT NOT NULL)')
    db.prepare('INSERT OR IGNORE INTO installation_identity(id, stamp) VALUES(1, ?)').run(stamp)
    if ((db.prepare('SELECT stamp FROM installation_identity WHERE id=1').get() as { stamp: string }).stamp !== stamp) throw new BillingError('INSTALLATION_MATERIAL_MISMATCH', '安装材料与账本不匹配，禁止重置额度')
  } finally { db.close() }
  return credential => createHmac('sha256', salt).update(credential).digest('hex')
}
