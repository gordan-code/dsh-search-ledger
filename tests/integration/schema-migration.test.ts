import { readFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { BillingDatabase } from '../../src/storage/database.ts'

function fixture() {
  const directory = mkdtempSync(resolve('.validation/tmp/migration-'))
  const path = join(directory, 'usage.sqlite')
  const db = new DatabaseSync(path)
  db.exec(readFileSync(resolve('tests/fixtures/usage-v1.sql'), 'utf8'))
  db.exec(`INSERT INTO attempts(attempt_id,operation_id,profile_id,owner_token,operation,channel_id,channel_name,channel_kind,endpoint_origin,currency,billing_policy,config_revision,started_at,outcome,amount_micros,quota_credits,quota_subject,quota_window)
    VALUES('old','operation','desktop','owner','search','t','Tavily','tavily','https://api.tavily.com','USD','free','revision','2026-10-19T00:00:00Z','dispatching',123,1,'subject','2026-10');
    INSERT INTO quota_subjects VALUES('subject','2026-10',1000,1);
    INSERT INTO quota_reservations VALUES('old','subject','2026-10',1);
    INSERT INTO session_overrides VALUES('desktop','session',2,'t',NULL);
    CREATE TABLE installation_identity(id INTEGER PRIMARY KEY CHECK(id=1), stamp TEXT NOT NULL); INSERT INTO installation_identity VALUES(1,'opaque');
    CREATE TABLE channel_identities(profile_id TEXT NOT NULL, channel_id TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(profile_id,channel_id)); INSERT INTO channel_identities VALUES('desktop','t','locked');
    CREATE TABLE channel_retirements(profile_id TEXT NOT NULL, channel_id TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(profile_id,channel_id)); INSERT INTO channel_retirements VALUES('desktop','archived','locked');`)
  db.exec(`INSERT INTO attempts(attempt_id,operation_id,profile_id,owner_token,operation,channel_id,channel_name,channel_kind,endpoint_origin,currency,billing_policy,config_revision,started_at,outcome)
    VALUES('prepared','pending-op','desktop','pending-owner','search','t','Tavily','tavily','https://api.tavily.com','USD','free','revision','2026-10-19T00:00:01Z','prepared')`)
  db.close()
  return { path, directory }
}
function snapshot(db: DatabaseSync) {
  return Object.fromEntries(['attempts', 'quota_subjects', 'quota_reservations', 'session_overrides', 'installation_identity', 'channel_identities', 'channel_retirements'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
}
describe('schema v2 migration', () => {
  it('creates v2 for a fresh database', () => {
    const directory = mkdtempSync(resolve('.validation/tmp/migration-'))
    const path = join(directory, 'new.sqlite')
    const billing = new BillingDatabase(path); billing.close()
    const db = new DatabaseSync(path)
    try { expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 }) } finally { db.close() }
  })
  it('旧CHECK明确拒绝新策略，v2可通过真实prepare/dispatch/finish且外键级联有效', () => {
    const { path } = fixture(); const old = new DatabaseSync(path)
    try { expect(() => old.exec("UPDATE attempts SET billing_policy='provider-success'")).toThrow() } finally { old.close() }
    const billing = new BillingDatabase(path)
    billing.prepare({ attemptId: 'new', operationId: 'new-op', ownerToken: 'o', operation: 'fetch', profileId: 'desktop', channelId: 'tiny', channelName: 'tiny', channelKind: 'tinyfish', endpointOrigin: 'https://api.fetch.tinyfish.ai', price: { perThousand: null, currency: 'CNY', policy: 'provider-success' }, configRevision: 'r', startedAt: new Date().toISOString() })
    expect(billing.dispatch('new', 'o')).toBe(true)
    expect(billing.finish('new', 'o', { outcome: 'billable', completedAt: new Date().toISOString() })).toBe(true)
    billing.close()
    const db = new DatabaseSync(path)
    try { db.exec("PRAGMA foreign_keys=ON; DELETE FROM attempts WHERE attempt_id='old'"); expect(db.prepare('SELECT * FROM quota_reservations').all()).toEqual([]) } finally { db.close() }
  })
  it('v2同样拒绝损坏结构、未知对象和坏数据', () => {
    for (const sql of ['CREATE TABLE unknown_table(value TEXT)', 'CREATE TRIGGER evil AFTER INSERT ON attempts BEGIN DELETE FROM quota_reservations; END', "PRAGMA ignore_check_constraints=ON; UPDATE attempts SET currency='bad'", 'DROP TABLE quota_reservations']) {
      const { path } = fixture(); const billing = new BillingDatabase(path); billing.close()
      const db = new DatabaseSync(path); db.exec(sql); db.close()
      expect(() => new BillingDatabase(path)).toThrow()
    }
  })
  it.each(['CREATE TABLE attempts_v2', 'INSERT INTO attempts_v2', 'CREATE INDEX attempts_profile_started', 'COMMIT'])('迁移%s故障回滚并可重试', fragment => {
    const { path } = fixture(); const before = new DatabaseSync(path); const original = snapshot(before); before.close()
    const exec = DatabaseSync.prototype.exec
    let failedConnection: DatabaseSync | undefined
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes(fragment)) { failedConnection = this; throw new Error('synthetic migration fault') }
      return exec.call(this, sql)
    })
    try { expect(() => new BillingDatabase(path)).toThrow(); expect(failedConnection).toBeTruthy() } finally { spy.mockRestore() }
    const after = new DatabaseSync(path)
    try { expect(snapshot(after)).toEqual(original); expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 }) } finally { after.close() }
    const retry = new BillingDatabase(path); retry.close()
  })
  it('未来版本拒绝后不改变journal mode', () => {
    const { path } = fixture(); const db = new DatabaseSync(path); const journal = db.prepare('PRAGMA journal_mode').get(); db.exec('PRAGMA user_version=9'); db.close()
    expect(() => new BillingDatabase(path)).toThrow()
    const after = new DatabaseSync(path)
    try { expect(after.prepare('PRAGMA journal_mode').get()).toEqual(journal) } finally { after.close() }
  })
  it('备份失败不修改原库，WAL中尚未checkpoint的数据也包含在备份', () => {
    const { path, directory } = fixture(); const raw = new DatabaseSync(path)
    raw.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE attempts SET amount_micros=456")
    const original = snapshot(raw)
    const prepare = DatabaseSync.prototype.prepare
    const fault = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('VACUUM')) throw new Error('synthetic backup failure')
      return prepare.call(this, sql)
    })
    try { expect(() => new BillingDatabase(path)).toThrow(); expect(snapshot(raw)).toEqual(original); expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 }) } finally { fault.mockRestore() }
    const migrated = new BillingDatabase(path); migrated.close(); raw.close()
    const backup = readdirSync(directory).find(name => name.includes('v1-backup'))!
    const saved = new DatabaseSync(join(directory, backup), { readOnly: true })
    try { expect(snapshot(saved)).toEqual(original) } finally { saved.close() }
  })
  it('写锁占用时拒绝迁移，解除后可重试', () => {
    const { path } = fixture(); const lock = new DatabaseSync(path); lock.exec('BEGIN IMMEDIATE')
    const exec = DatabaseSync.prototype.exec
    const shortWait = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) { return exec.call(this, sql.replace('busy_timeout = 5000', 'busy_timeout = 1')) })
    try { expect(() => new BillingDatabase(path)).toThrow() } finally { shortWait.mockRestore(); lock.exec('ROLLBACK'); lock.close() }
    const retry = new BillingDatabase(path); retry.close()
  })
  it('preserves every historical column, reservation and identity, backs up v1 and accepts the new policy', () => {
    const { path, directory } = fixture()
    const before = new DatabaseSync(path); const original = snapshot(before); before.close()
    const billing = new BillingDatabase(path); billing.close()
    const db = new DatabaseSync(path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      expect(snapshot(db)).toEqual(original)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      db.exec("UPDATE attempts SET billing_policy='provider-success' WHERE attempt_id='old'")
    } finally { db.close() }
    const backups = readdirSync(directory).filter(name => name.includes('v1-backup'))
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(directory, backups[0]!), { readOnly: true })
    try { expect(snapshot(backup)).toEqual(original); expect(backup.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 }) } finally { backup.close() }
    const again = new BillingDatabase(path); again.close()
    expect(readdirSync(directory).filter(name => name.includes('v1-backup'))).toEqual(backups)
  })
  it('rejects future versions without rewriting metadata', () => {
    const { path } = fixture(); const raw = new DatabaseSync(path); raw.exec('PRAGMA user_version=9'); raw.close()
    expect(() => new BillingDatabase(path)).toThrow()
    const db = new DatabaseSync(path)
    try { expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 }) } finally { db.close() }
  })
  it('rejects conflicting metadata and unknown dependent objects without dropping them', () => {
    for (const sql of ["UPDATE schema_meta SET value='8' WHERE key='version'", 'CREATE INDEX unexpected_index ON attempts(channel_name)']) {
      const { path } = fixture(); const raw = new DatabaseSync(path); raw.exec(sql); const original = snapshot(raw); raw.close()
      expect(() => new BillingDatabase(path)).toThrow()
      const db = new DatabaseSync(path)
      try { expect(snapshot(db)).toEqual(original); expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 }) } finally { db.close() }
    }
  })
  it('rolls back a failed copy and can retry after the corrupt row is repaired', () => {
    const { path } = fixture(); const raw = new DatabaseSync(path)
    raw.exec("PRAGMA ignore_check_constraints=ON; UPDATE attempts SET currency='INVALID';")
    const original = snapshot(raw); raw.close()
    expect(() => new BillingDatabase(path)).toThrow()
    const db = new DatabaseSync(path)
    try {
      expect(snapshot(db)).toEqual(original)
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='attempts_v2'").get()).toBeUndefined()
      db.exec("UPDATE attempts SET currency='USD'")
    } finally { db.close() }
    const retry = new BillingDatabase(path); retry.close()
  })
})
