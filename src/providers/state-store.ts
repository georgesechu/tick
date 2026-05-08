import type Database from 'better-sqlite3'
import type { AgentStateStore } from '../orchestrator/orchestrator.js'

export class SQLiteAgentStateStore implements AgentStateStore {
  private stmts: ReturnType<typeof this.prepare>

  constructor(private db: Database.Database) {
    this.stmts = this.prepare()
  }

  private prepare() {
    return {
      get: this.db.prepare<[string]>('SELECT value FROM agent_state WHERE key = ?'),
      set: this.db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (@key, @value)'),
    }
  }

  get(key: string): string | null {
    const row = this.stmts.get.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.stmts.set.run({ key, value })
  }
}
