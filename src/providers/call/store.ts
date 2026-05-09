import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CallStore, CallSession, CallSegment, ActiveCallContext } from './types.js'

export class SQLiteCallStore implements CallStore {
  private stmts: ReturnType<typeof prepareStatements>

  constructor(private db: Database.Database) {
    this.stmts = prepareStatements(db)
  }

  createCall(tabTitle: string, tabUrl: string): string {
    const callId = randomUUID()
    this.stmts.insertCall.run(callId, new Date().toISOString(), tabTitle, tabUrl)
    return callId
  }

  addSegment(callId: string, transcript: string, durationSec: number): void {
    const call = this.stmts.getCall.get(callId) as any
    if (!call) throw new Error(`Call not found: ${callId}`)

    const segmentIndex = (call.total_segments ?? 0)
    const id = randomUUID()
    this.stmts.insertSegment.run(id, callId, segmentIndex, transcript, durationSec, new Date().toISOString())
    this.stmts.updateCallSegmentCount.run(segmentIndex + 1, callId)
  }

  endCall(callId: string): void {
    const now = new Date().toISOString()
    this.stmts.endCall.run(now, now, callId)
  }

  getActiveCall(): ActiveCallContext | null {
    const row = this.stmts.getActiveCall.get() as any
    if (!row) return null

    const startedAt = new Date(row.started_at).getTime()
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)

    // Get latest segment transcript
    const latest = this.stmts.getLatestSegment.get(row.call_id) as any

    return {
      callId: row.call_id,
      tabTitle: row.tab_title,
      tabUrl: row.tab_url,
      elapsedSec,
      totalSegments: row.total_segments,
      latestTranscript: latest?.transcript ?? null,
    }
  }

  getCall(callId: string): CallSession | null {
    const row = this.stmts.getCall.get(callId) as any
    if (!row) return null
    return {
      callId: row.call_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      tabTitle: row.tab_title,
      tabUrl: row.tab_url,
      status: row.status,
      totalSegments: row.total_segments,
      totalDurationSec: row.total_duration_sec,
    }
  }

  getSegments(callId: string): CallSegment[] {
    const rows = this.stmts.getSegments.all(callId) as any[]
    return rows.map(rowToSegment)
  }

  getLatestSegments(callId: string, n: number): CallSegment[] {
    const rows = this.stmts.getLatestSegments.all(callId, n) as any[]
    return rows.map(rowToSegment).reverse() // return in chronological order
  }

  searchTranscripts(query: string, limit = 10): Array<{ callId: string; segmentIndex: number; transcript: string; createdAt: string }> {
    const rows = this.stmts.searchTranscripts.all(query, limit) as any[]
    return rows.map(r => ({
      callId: r.call_id,
      segmentIndex: r.segment_index,
      transcript: r.transcript,
      createdAt: r.created_at,
    }))
  }
}

function rowToSegment(r: any): CallSegment {
  return {
    id: r.id,
    callId: r.call_id,
    segmentIndex: r.segment_index,
    transcript: r.transcript,
    durationSec: r.duration_sec,
    createdAt: r.created_at,
  }
}

function prepareStatements(db: Database.Database) {
  return {
    insertCall: db.prepare(`
      INSERT INTO calls (call_id, started_at, tab_title, tab_url, status, total_segments, total_duration_sec)
      VALUES (?, ?, ?, ?, 'active', 0, 0)
    `),

    insertSegment: db.prepare(`
      INSERT INTO call_segments (id, call_id, segment_index, transcript, duration_sec, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    updateCallSegmentCount: db.prepare(`
      UPDATE calls SET total_segments = ? WHERE call_id = ?
    `),

    endCall: db.prepare(`
      UPDATE calls SET status = 'ended', ended_at = ?,
        total_duration_sec = CAST((julianday(?) - julianday(started_at)) * 86400 AS INTEGER)
      WHERE call_id = ?
    `),

    getCall: db.prepare(`SELECT * FROM calls WHERE call_id = ?`),

    getActiveCall: db.prepare(`SELECT * FROM calls WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`),

    getLatestSegment: db.prepare(`
      SELECT * FROM call_segments WHERE call_id = ? ORDER BY segment_index DESC LIMIT 1
    `),

    getSegments: db.prepare(`
      SELECT * FROM call_segments WHERE call_id = ? ORDER BY segment_index ASC
    `),

    getLatestSegments: db.prepare(`
      SELECT * FROM call_segments WHERE call_id = ? ORDER BY segment_index DESC LIMIT ?
    `),

    searchTranscripts: db.prepare(`
      SELECT cs.* FROM call_segments_fts fts
      JOIN call_segments cs ON cs.rowid = fts.rowid
      WHERE call_segments_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
  }
}
