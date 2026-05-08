import type Database from 'better-sqlite3'
import type {
  MemoryStore,
} from '../../core/interfaces.js'
import type {
  MemoryEntry, MemoryIndexEntry, MemoryType,
} from '../../core/types.js'

interface Row {
  key: string
  version: number
  value: string
  summary: string
  type: string
  pinned: number
  related: string
  ttl: string | null
  deleted: number
  created_at: string
  updated_at: string
  access_count: number
  last_accessed: string
}

function rowToEntry(row: Row): MemoryEntry {
  return {
    key: row.key,
    value: row.value,
    summary: row.summary,
    type: row.type as MemoryType,
    pinned: row.pinned === 1,
    related: JSON.parse(row.related ?? '[]') as string[],
    ttl: row.ttl,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
  }
}

export class SQLiteMemoryStore implements MemoryStore {
  private stmts: ReturnType<typeof this.prepare>

  constructor(private db: Database.Database) {
    this.stmts = this.prepare()
  }

  private prepare() {
    return {
      getCurrent: this.db.prepare<[string]>(`
        SELECT * FROM memory
        WHERE key = ?
        ORDER BY version DESC LIMIT 1
      `),
      getMaxVersion: this.db.prepare<[string]>(`
        SELECT COALESCE(MAX(version), 0) as max_version
        FROM memory WHERE key = ?
      `),
      insert: this.db.prepare(`
        INSERT INTO memory (key, version, value, summary, type, pinned, related, ttl, deleted,
                            created_at, updated_at, access_count, last_accessed)
        VALUES (@key, @version, @value, @summary, @type, @pinned, @related, @ttl, @deleted,
                @created_at, @updated_at, @access_count, @last_accessed)
      `),
      touchAccess: this.db.prepare<[string, string, number]>(`
        UPDATE memory SET access_count = access_count + 1, last_accessed = ?
        WHERE key = ? AND version = ?
      `),
      updatePinned: this.db.prepare<[number, string, string]>(`
        UPDATE memory SET pinned = ?
        WHERE key = ? AND version = (
          SELECT MAX(version) FROM memory WHERE key = ? AND deleted = 0
        )
      `),
      listByPrefix: this.db.prepare<[string]>(`
        SELECT m.* FROM memory m
        INNER JOIN (
          SELECT key, MAX(version) as mv FROM memory GROUP BY key
        ) latest ON m.key = latest.key AND m.version = latest.mv
        WHERE m.deleted = 0 AND m.key LIKE ? || '%'
        ORDER BY m.key
      `),
      getIndex: this.db.prepare(`
        SELECT m.key, m.summary, m.type, m.pinned, m.updated_at
        FROM memory m
        INNER JOIN (
          SELECT key, MAX(version) as mv FROM memory GROUP BY key
        ) latest ON m.key = latest.key AND m.version = latest.mv
        WHERE m.deleted = 0
        ORDER BY m.key
      `),
      getPinned: this.db.prepare(`
        SELECT m.* FROM memory m
        INNER JOIN (
          SELECT key, MAX(version) as mv FROM memory GROUP BY key
        ) latest ON m.key = latest.key AND m.version = latest.mv
        WHERE m.deleted = 0 AND m.pinned = 1
        ORDER BY m.key
      `),
      getHistory: this.db.prepare<[string]>(`
        SELECT * FROM memory WHERE key = ? ORDER BY version DESC
      `),
      getVersion: this.db.prepare<[string, number]>(`
        SELECT * FROM memory WHERE key = ? AND version = ?
      `),
      ftsDel: this.db.prepare<[string]>(`
        DELETE FROM memory_fts WHERE key = ?
      `),
      ftsInsert: this.db.prepare(`
        INSERT INTO memory_fts (key, summary, value) VALUES (@key, @summary, @value)
      `),
      ftsSearch: this.db.prepare<[string, number]>(`
        SELECT key FROM memory_fts WHERE memory_fts MATCH ? LIMIT ?
      `),
      gcExpired: this.db.prepare<[string]>(`
        SELECT key, MAX(version) as version, ttl, updated_at
        FROM memory WHERE deleted = 0
        GROUP BY key HAVING ttl IS NOT NULL AND updated_at < ?
      `),
    }
  }

  private nextVersion(key: string): number {
    const row = this.stmts.getMaxVersion.get(key) as { max_version: number }
    return row.max_version + 1
  }

  private now(): string {
    return new Date().toISOString()
  }

  async get(key: string): Promise<MemoryEntry | null> {
    const row = this.stmts.getCurrent.get(key) as Row | undefined
    if (!row || row.deleted) return null
    this.stmts.touchAccess.run(this.now(), key, row.version)
    return rowToEntry(row)
  }

  async set(params: {
    key: string; value: string; summary: string;
    type: MemoryType; pinned?: boolean; related?: string[]; ttl?: string
  }): Promise<void> {
    const now = this.now()
    const version = this.nextVersion(params.key)
    const existing = this.stmts.getCurrent.get(params.key) as Row | undefined
    const existingRelated = existing ? JSON.parse(existing.related ?? '[]') : []

    this.db.transaction(() => {
      this.stmts.insert.run({
        key: params.key,
        version,
        value: params.value,
        summary: params.summary,
        type: params.type,
        pinned: (params.pinned ?? existing?.pinned ?? false) ? 1 : 0,
        related: JSON.stringify(params.related ?? existingRelated),
        ttl: params.ttl ?? existing?.ttl ?? null,
        deleted: 0,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        access_count: 0,
        last_accessed: now,
      })
      this.stmts.ftsDel.run(params.key)
      this.stmts.ftsInsert.run({
        key: params.key,
        summary: params.summary,
        value: params.value,
      })
    })()
  }

  async delete(key: string): Promise<void> {
    const now = this.now()
    const version = this.nextVersion(key)

    this.db.transaction(() => {
      this.stmts.insert.run({
        key,
        version,
        value: '',
        summary: '[deleted]',
        type: 'state',
        pinned: 0,
        related: '[]',
        ttl: null,
        deleted: 1,
        created_at: now,
        updated_at: now,
        access_count: 0,
        last_accessed: now,
      })
      this.stmts.ftsDel.run(key)
    })()
  }

  async append(key: string, value: string): Promise<void> {
    const existing = await this.get(key)
    if (!existing) {
      throw new Error(`Cannot append to non-existent key: ${key}`)
    }
    await this.set({
      key,
      value: existing.value + '\n' + value,
      summary: existing.summary,
      type: existing.type,
    })
  }

  async list(prefix: string): Promise<MemoryEntry[]> {
    const rows = this.stmts.listByPrefix.all(prefix) as Row[]
    return rows.map(rowToEntry)
  }

  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const ftsRows = this.stmts.ftsSearch.all(query, limit) as { key: string }[]
    const entries: MemoryEntry[] = []
    for (const { key } of ftsRows) {
      const entry = await this.get(key)
      if (entry) entries.push(entry)
    }
    return entries
  }

  async pin(key: string): Promise<void> {
    this.stmts.updatePinned.run(1, key, key)
  }

  async unpin(key: string): Promise<void> {
    this.stmts.updatePinned.run(0, key, key)
  }

  async setTTL(key: string, ttl: string): Promise<void> {
    const existing = await this.get(key)
    if (!existing) return
    await this.set({
      key,
      value: existing.value,
      summary: existing.summary,
      type: existing.type,
      ttl,
    })
  }

  async history(key: string): Promise<MemoryEntry[]> {
    const rows = this.stmts.getHistory.all(key) as Row[]
    return rows.map(rowToEntry)
  }

  async rollback(key: string, toVersion: number): Promise<void> {
    const row = this.stmts.getVersion.get(key, toVersion) as Row | undefined
    if (!row) throw new Error(`Version ${toVersion} not found for key: ${key}`)
    await this.set({
      key,
      value: row.value,
      summary: row.summary,
      type: row.type as MemoryType,
      pinned: row.pinned === 1,
      ttl: row.ttl ?? undefined,
    })
  }

  async getIndex(): Promise<MemoryIndexEntry[]> {
    const rows = this.stmts.getIndex.all() as Row[]
    return rows.map(r => ({
      key: r.key,
      summary: r.summary,
      type: r.type as MemoryType,
      pinned: r.pinned === 1,
      related: JSON.parse(r.related ?? '[]') as string[],
      updatedAt: r.updated_at,
    }))
  }

  async getPinned(): Promise<MemoryEntry[]> {
    const rows = this.stmts.getPinned.all() as Row[]
    return rows.map(rowToEntry)
  }

  async gc(): Promise<void> {
    // For now just expire TTL'd entries
    // TTL format: "1h", "30m", "7d" — parsed relative to updated_at
    const now = new Date()
    const index = await this.getIndex()

    for (const entry of index) {
      const full = await this.get(entry.key)
      if (!full?.ttl) continue

      const expiresAt = parseTTL(full.ttl, new Date(full.updatedAt))
      if (now > expiresAt) {
        await this.delete(entry.key)
      }
    }
  }
}

function parseTTL(ttl: string, from: Date): Date {
  const match = ttl.match(/^(\d+)([smhd])$/)
  if (!match) return new Date(from.getTime() + 3600_000) // default 1h

  const [, n, unit] = match
  const ms = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }
  return new Date(from.getTime() + parseInt(n!) * ms[unit as keyof typeof ms])
}
