import Database from 'better-sqlite3'

export function openDatabase(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      key         TEXT    NOT NULL,
      version     INTEGER NOT NULL,
      value       TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      type        TEXT    NOT NULL,
      pinned      INTEGER NOT NULL DEFAULT 0,
      related     TEXT    NOT NULL DEFAULT '[]',
      ttl         TEXT,
      deleted     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT  NOT NULL,
      PRIMARY KEY (key, version)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_current
      ON memory(key, version DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      key, summary, value
    );

    CREATE TABLE IF NOT EXISTS ticks (
      id               TEXT PRIMARY KEY,
      agent_id         TEXT NOT NULL,
      tick_number      INTEGER NOT NULL,
      triggered_by     TEXT NOT NULL,
      started_at       TEXT NOT NULL,
      duration_ms      INTEGER NOT NULL,
      status           TEXT NOT NULL,
      input_tokens     INTEGER NOT NULL,
      output_tokens    INTEGER NOT NULL,
      actions_executed INTEGER NOT NULL,
      memory_ops_executed INTEGER NOT NULL,
      error            TEXT
    );

    CREATE TABLE IF NOT EXISTS inbox (
      id          TEXT PRIMARY KEY,
      source_id   TEXT NOT NULL,
      channel     TEXT NOT NULL,
      thread_id   TEXT,
      from_id     TEXT NOT NULL,
      from_name   TEXT NOT NULL,
      from_handle TEXT NOT NULL,
      subject     TEXT,
      body        TEXT NOT NULL,
      body_truncated INTEGER NOT NULL DEFAULT 0,
      attachments TEXT NOT NULL DEFAULT '[]',
      timestamp   TEXT NOT NULL,
      priority    TEXT NOT NULL DEFAULT 'normal',
      type        TEXT NOT NULL DEFAULT 'message',
      reply_to    TEXT,
      thread_summary TEXT,
      raw_ref     TEXT NOT NULL,
      read        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_unread
      ON inbox(read, priority, timestamp DESC);

    CREATE TABLE IF NOT EXISTS outbox (
      id          TEXT PRIMARY KEY,
      channel     TEXT NOT NULL,
      "to"        TEXT NOT NULL,
      content     TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',
      reply_to    TEXT,
      thread_id   TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TEXT NOT NULL,
      sent_at     TEXT,
      error       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_pending
      ON outbox(status) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS agent_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // Migrations for existing databases
  const migrations = [
    `ALTER TABLE outbox ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE memory ADD COLUMN related TEXT NOT NULL DEFAULT '[]'`,
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }
}
