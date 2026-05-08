import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { OutboxStore } from '../../core/interfaces.js'
import type { OutboxItem, OutboxStatus } from '../../core/types.js'

interface Row {
  id: string
  channel: string
  to: string
  content: string
  attachments: string
  reply_to: string | null
  thread_id: string | null
  status: string
  created_at: string
  sent_at: string | null
  error: string | null
}

function rowToItem(row: Row): OutboxItem {
  return {
    id: row.id,
    channel: row.channel,
    to: row.to,
    content: row.content,
    attachments: JSON.parse(row.attachments ?? '[]') as string[],
    replyTo: row.reply_to,
    threadId: row.thread_id,
    status: row.status as OutboxStatus,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    error: row.error,
  }
}

export class SQLiteOutboxStore implements OutboxStore {
  private stmts: ReturnType<typeof this.prepare>

  constructor(private db: Database.Database) {
    this.stmts = this.prepare()
  }

  private prepare() {
    return {
      insert: this.db.prepare(`
        INSERT INTO outbox (id, channel, "to", content, attachments, reply_to, thread_id, status, created_at)
        VALUES (@id, @channel, @to, @content, @attachments, @reply_to, @thread_id, 'pending', @created_at)
      `),
      fetchPending: this.db.prepare(`
        SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC
      `),
      markSent: this.db.prepare<[string, string]>(`
        UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?
      `),
      markFailed: this.db.prepare<[string, string]>(`
        UPDATE outbox SET status = 'failed', error = ? WHERE id = ?
      `),
    }
  }

  async enqueue(item: Pick<OutboxItem, 'channel' | 'to' | 'content' | 'attachments' | 'replyTo' | 'threadId'>): Promise<string> {
    const id = randomUUID()
    this.stmts.insert.run({
      id,
      channel: item.channel,
      to: item.to,
      content: item.content,
      attachments: JSON.stringify(item.attachments ?? []),
      reply_to: item.replyTo,
      thread_id: item.threadId,
      created_at: new Date().toISOString(),
    })
    return id
  }

  async fetchPending(): Promise<OutboxItem[]> {
    const rows = this.stmts.fetchPending.all() as Row[]
    return rows.map(rowToItem)
  }

  async markSent(id: string): Promise<void> {
    this.stmts.markSent.run(new Date().toISOString(), id)
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.stmts.markFailed.run(error, id)
  }
}
