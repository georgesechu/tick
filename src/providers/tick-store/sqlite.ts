import type Database from 'better-sqlite3'
import type { TickStore } from '../../core/interfaces.js'
import type { TickRecord } from '../../core/types.js'

export class SQLiteTickStore implements TickStore {
  private stmts: ReturnType<typeof this.prepare>

  constructor(private db: Database.Database) {
    this.stmts = this.prepare()
  }

  private prepare() {
    return {
      insert: this.db.prepare(`
        INSERT INTO ticks (id, agent_id, tick_number, triggered_by, started_at,
                           duration_ms, status, input_tokens, output_tokens,
                           actions_executed, memory_ops_executed, error)
        VALUES (@id, @agent_id, @tick_number, @triggered_by, @started_at,
                @duration_ms, @status, @input_tokens, @output_tokens,
                @actions_executed, @memory_ops_executed, @error)
      `),
      getLast: this.db.prepare<[string]>(`
        SELECT * FROM ticks WHERE agent_id = ? ORDER BY tick_number DESC LIMIT 1
      `),
      list: this.db.prepare<[string, number]>(`
        SELECT * FROM ticks WHERE agent_id = ? ORDER BY tick_number DESC LIMIT ?
      `),
    }
  }

  async save(record: TickRecord): Promise<void> {
    this.stmts.insert.run({
      id: record.id,
      agent_id: record.agentId,
      tick_number: record.tickNumber,
      triggered_by: JSON.stringify(record.triggeredBy),
      started_at: record.startedAt,
      duration_ms: record.durationMs,
      status: record.status,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      actions_executed: record.actionsExecuted,
      memory_ops_executed: record.memoryOpsExecuted,
      error: record.error,
    })
  }

  async getLast(agentId: string): Promise<TickRecord | null> {
    const row = this.stmts.getLast.get(agentId) as TickRow | undefined
    return row ? rowToRecord(row) : null
  }

  async list(agentId: string, limit: number): Promise<TickRecord[]> {
    const rows = this.stmts.list.all(agentId, limit) as TickRow[]
    return rows.map(rowToRecord)
  }
}

interface TickRow {
  id: string
  agent_id: string
  tick_number: number
  triggered_by: string
  started_at: string
  duration_ms: number
  status: string
  input_tokens: number
  output_tokens: number
  actions_executed: number
  memory_ops_executed: number
  error: string | null
}

function rowToRecord(row: TickRow): TickRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    tickNumber: row.tick_number,
    triggeredBy: JSON.parse(row.triggered_by),
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    status: row.status as TickRecord['status'],
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    actionsExecuted: row.actions_executed,
    memoryOpsExecuted: row.memory_ops_executed,
    error: row.error,
  }
}
