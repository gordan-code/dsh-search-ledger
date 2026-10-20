// 唯一账本结构定义；迁移与新建共用，不重算历史金额。
export const SCHEMA_VERSION = 2
export const SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      INSERT INTO schema_meta(key, value) VALUES ('version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        operation_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        session_id TEXT,
        source_provider_id TEXT,
        source_model TEXT,
        owner_token TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('search', 'fetch')),
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        channel_kind TEXT NOT NULL,
        endpoint_origin TEXT NOT NULL,
        price_per_thousand TEXT,
        currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD')),
        billing_policy TEXT NOT NULL CHECK (billing_policy IN ('official-nonempty', 'http-200', 'free', 'provider-success')),
        config_revision TEXT NOT NULL,
        started_at TEXT NOT NULL,
        dispatched_at TEXT,
        completed_at TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('prepared', 'dispatching', 'billable', 'empty', 'failed', 'unknown')),
        transport_status INTEGER,
        result_count INTEGER,
        has_content INTEGER,
        unit_micros INTEGER,
        amount_micros INTEGER,
        quota_credits INTEGER NOT NULL DEFAULT 0,
        quota_subject TEXT,
        quota_window TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS attempts_profile_started
        ON attempts(profile_id, started_at DESC, attempt_id DESC);
      CREATE TABLE IF NOT EXISTS quota_subjects (
        subject TEXT NOT NULL,
        window TEXT NOT NULL,
        limit_credits INTEGER NOT NULL,
        reserved_credits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(subject, window)
      );
      CREATE TABLE IF NOT EXISTS quota_reservations (
        attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        window TEXT NOT NULL,
        credits INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS quota_reservations_subject_window
        ON quota_reservations(subject, window);
      CREATE TABLE IF NOT EXISTS session_overrides (
        profile_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        search_channel_id TEXT,
        fetch_channel_id TEXT,
        PRIMARY KEY(profile_id, session_id)
      );
`
