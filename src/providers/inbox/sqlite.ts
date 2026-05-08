import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { InboxStore } from '../../core/interfaces.js'
import type { InboxItem, Priority, InboxItemType, Attachment } from '../../core/types.js'

interface Row {
  id: string
  source_id: string
  channel: string
  thread_id: string | null
  from_id: string
  from_name: string
  from_handle: string
  subject: string | null
  body: string
  body_truncated: number
  attachments: string
  timestamp: string
  priority: string
  type: string
  reply_to: string | null
  thread_summary: string | null
  raw_ref: string
  read: number
}

function rowToItem(row: Row): InboxItem {
  return {
    id: row.id,
    sourceId: row.source_id,
    channel: row.channel,
    threadId: row.thread_id,
    from: { id: row.from_id, name: row.from_name, channelHandle: row.from_handle },
    subject: row.subject,
    body: row.body,
    bodyTruncated: row.body_truncated === 1,
    attachments: JSON.parse(row.attachments) as Attachment[],
    timestamp: row.timestamp,
    priority: row.priority as Priority,
    type: row.type as InboxItemType,
    replyTo: row.reply_to,
    threadSummary: row.thread_summary,
    rawRef: row.raw_ref,
  }
}

export class SQLiteInboxStore implements InboxStore {
  private stmts: ReturnType<typeof this.prepare>

  constructor(private db: Database.Database) {
    this.stmts = this.prepare()
  }

  private prepare() {
    return {
      insert: this.db.prepare(`
        INSERT OR IGNORE INTO inbox
          (id, source_id, channel, thread_id, from_id, from_name, from_handle,
           subject, body, body_truncated, attachments, timestamp, priority, type,
           reply_to, thread_summary, raw_ref, read)
        VALUES
          (@id, @source_id, @channel, @thread_id, @from_id, @from_name, @from_handle,
           @subject, @body, @body_truncated, @attachments, @timestamp, @priority, @type,
           @reply_to, @thread_summary, @raw_ref, 0)
      `),
      fetch: this.db.prepare<[number]>(`
        SELECT * FROM inbox WHERE read = 0
        ORDER BY
          CASE priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            WHEN 'low' THEN 3
          END,
          timestamp ASC
        LIMIT ?
      `),
      markRead: this.db.prepare<[string]>(`
        UPDATE inbox SET read = 1 WHERE id = ?
      `),
      unreadCount: this.db.prepare(`
        SELECT COUNT(*) as count FROM inbox WHERE read = 0
      `),
    }
  }

  async push(item: InboxItem): Promise<void> {
    this.stmts.insert.run({
      id: item.id || randomUUID(),
      source_id: item.sourceId,
      channel: item.channel,
      thread_id: item.threadId,
      from_id: item.from.id,
      from_name: item.from.name,
      from_handle: item.from.channelHandle,
      subject: item.subject,
      body: item.body,
      body_truncated: item.bodyTruncated ? 1 : 0,
      attachments: JSON.stringify(item.attachments),
      timestamp: item.timestamp,
      priority: item.priority,
      type: item.type,
      reply_to: item.replyTo,
      thread_summary: item.threadSummary,
      raw_ref: item.rawRef,
    })
  }

  async pushMany(items: InboxItem[]): Promise<void> {
    const insertMany = this.db.transaction((items: InboxItem[]) => {
      for (const item of items) {
        this.stmts.insert.run({
          id: item.id || randomUUID(),
          source_id: item.sourceId,
          channel: item.channel,
          thread_id: item.threadId,
          from_id: item.from.id,
          from_name: item.from.name,
          from_handle: item.from.channelHandle,
          subject: item.subject,
          body: item.body,
          body_truncated: item.bodyTruncated ? 1 : 0,
          attachments: JSON.stringify(item.attachments),
          timestamp: item.timestamp,
          priority: item.priority,
          type: item.type,
          reply_to: item.replyTo,
          thread_summary: item.threadSummary,
          raw_ref: item.rawRef,
        })
      }
    })
    insertMany(items)
  }

  async fetch(options?: { limit?: number; budgetTokens?: number }): Promise<InboxItem[]> {
    const limit = options?.limit ?? 20
    const rows = this.stmts.fetch.all(limit) as Row[]
    return rows.map(rowToItem)
  }

  async markRead(ids: string[]): Promise<void> {
    const markMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.stmts.markRead.run(id)
      }
    })
    markMany(ids)
  }

  async getUnreadCount(): Promise<number> {
    const row = this.stmts.unreadCount.get() as { count: number }
    return row.count
  }
}
