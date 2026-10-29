import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { BillingError } from '../contracts.ts'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts'
import { V1_SCHEMA_SQL } from './schema-v1.ts'

function failure(): never { throw new BillingError('DB_SCHEMA_INVALID', '账本版本或结构不兼容；请停止所有DSH进程后检查备份，未派发请求') }
function version(db: DatabaseSync): number { return Number(db.prepare('PRAGMA user_version').get()?.user_version) }
function canonical(sql: string): string { return sql.replace(/IF NOT EXISTS/gi, '').replace(/[\s"`\[\];]/g, '').toLowerCase() }
function attemptDefinition(name: string, old = false): string {
  const sql = (old ? V1_SCHEMA_SQL : SCHEMA_SQL).match(/CREATE TABLE IF NOT EXISTS attempts \([\s\S]*?\n      \);/)?.[0]
  if (!sql) return failure()
  return sql.replace('IF NOT EXISTS attempts', name)
}
const externalTables: Record<string, string> = {
  installation_identity: 'CREATE TABLE installation_identity (id INTEGER PRIMARY KEY CHECK(id=1), stamp TEXT NOT NULL)',
  channel_identities: 'CREATE TABLE channel_identities (profile_id TEXT NOT NULL, channel_id TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(profile_id,channel_id))',
  channel_retirements: 'CREATE TABLE channel_retirements (profile_id TEXT NOT NULL, channel_id TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(profile_id,channel_id))',
  breaker_resets: 'CREATE TABLE breaker_resets (profile_id TEXT NOT NULL, channel_id TEXT NOT NULL, reset_at TEXT NOT NULL, PRIMARY KEY(profile_id,channel_id))',
}
function definitions(current: number): Map<string, string> {
  const sql = current === 1 ? V1_SCHEMA_SQL : SCHEMA_SQL
  return new Map([...sql.matchAll(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)[\s\S]*?;/g)].map(match => [match[1]!, canonical(match[0])]))
}
function assertSchema(db: DatabaseSync, current: number): void {
  const required = definitions(current)
  const seen = new Set<string>()
  for (const row of db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL").all()) {
    const name = String(row.name)
    const expected = required.get(name) ?? externalTables[name]
    if (!expected || canonical(String(row.sql)) !== canonical(expected)) failure()
    seen.add(name)
  }
  for (const name of required.keys()) if (!seen.has(name)) failure()
  const meta = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get()?.value
  if (meta !== String(current)) failure()
}
/** 无查询正文或Key；哈希用于校验整库备份及迁移前后所有非元数据表。 */
function contentSnapshot(db: DatabaseSync): string {
  const hash = createHash('sha256')
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'schema_meta' ORDER BY name").all()
  for (const { name } of tables) {
    if (typeof name !== 'string' || !/^[a-z_]+$/.test(name)) failure()
    const statement = db.prepare(`SELECT * FROM ${name}`); statement.setReadBigInts(true)
    hash.update(name)
    const rows = statement.all().map(row => JSON.stringify(row, (_key, value: unknown) => typeof value === 'bigint' ? `${value}n` : value)).sort()
    for (const row of rows) { hash.update(String(Buffer.byteLength(row))); hash.update(':'); hash.update(row) }
  }
  return hash.digest('hex')
}
function assertIntegrity(db: DatabaseSync): void {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length !== 0) failure()
}
function backup(db: DatabaseSync, path: string): void {
  if (path === ':memory:') return
  const destination = `${path}.v1-backup-${Date.now()}-${randomUUID()}.sqlite`
  db.prepare('VACUUM main INTO ?').run(destination)
  const saved = new DatabaseSync(destination, { readOnly: true })
  try {
    if (version(saved) !== 1) failure()
    assertSchema(saved, 1); assertIntegrity(saved)
    if (contentSnapshot(saved) !== contentSnapshot(db)) failure()
  } finally { saved.close() }
}

/** 必须停用所有旧DSH进程后升级；写锁不代表支持新旧插件混跑。 */
export function initializeDatabase(db: DatabaseSync, path: string): void {
  const current = version(db)
  if (current > SCHEMA_VERSION || ![0, 1, SCHEMA_VERSION].includes(current)) failure()
  if (current === 0) {
    for (const row of db.prepare('SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL').all()) {
      const expected = externalTables[String(row.name)]
      if (!expected || canonical(String(row.sql)) !== canonical(expected)) failure()
    }
    db.exec('BEGIN IMMEDIATE')
    try { db.exec(SCHEMA_SQL); db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`); assertSchema(db, 2); assertIntegrity(db); db.exec('COMMIT') }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* 保留初始化错误。 */ }; throw error }
    return
  }
  assertSchema(db, current)
  assertIntegrity(db)
  if (current === SCHEMA_VERSION) return
  // 不执行未知对象SQL；有外部扩展时保守拒绝，而非丢弃索引/触发器。
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE (tbl_name='attempts' OR type='view' OR type='trigger') AND sql IS NOT NULL AND name<>'attempts'").all()
  if (objects.some(row => row.type !== 'index' || row.name !== 'attempts_profile_started' || canonical(String(row.sql)) !== canonical('CREATE INDEX attempts_profile_started ON attempts(profile_id, started_at DESC, attempt_id DESC)'))) failure()
  backup(db, path)
  db.exec('PRAGMA foreign_keys=OFF')
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 0) failure()
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (version(db) !== 1) failure()
      assertSchema(db, 1)
      const original = contentSnapshot(db)
      db.exec(attemptDefinition('attempts_v2'))
      const columns = db.prepare('PRAGMA table_info(attempts)').all().map(row => String(row.name)).join(',')
      db.exec(`INSERT INTO attempts_v2 (${columns}) SELECT ${columns} FROM attempts`)
      if (db.prepare('SELECT * FROM attempts EXCEPT SELECT * FROM attempts_v2').get() || db.prepare('SELECT * FROM attempts_v2 EXCEPT SELECT * FROM attempts').get()) failure()
      db.exec('DROP TABLE attempts; ALTER TABLE attempts_v2 RENAME TO attempts; CREATE INDEX attempts_profile_started ON attempts(profile_id, started_at DESC, attempt_id DESC);')
      if (contentSnapshot(db) !== original) failure()
      assertIntegrity(db)
      db.prepare("UPDATE schema_meta SET value=? WHERE key='version'").run(String(SCHEMA_VERSION))
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (error) { try { db.exec('ROLLBACK') } catch { /* 保留原始故障。 */ }; throw error }
  } finally {
    db.exec('PRAGMA foreign_keys=ON')
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) failure()
  }
  assertSchema(db, SCHEMA_VERSION); assertIntegrity(db)
}
