import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import { simpleParser } from 'mailparser'
import type { ChannelAdapter } from '../../core/interfaces.js'
import type { InboxItem, OutboxItem, Priority, Attachment } from '../../core/types.js'
import type { Logger } from '../../core/interfaces.js'

export interface GmailConfig {
  email: string
  appPassword: string
  labels?: string[]           // IMAP folders to watch, default ['INBOX']
}

export class GmailChannelAdapter implements ChannelAdapter {
  readonly name = 'gmail'
  private imap: ImapFlow | null = null
  private smtp: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | null = null
  private config: GmailConfig
  private logger: Logger
  private seenIds = new Set<string>()

  constructor(config: GmailConfig, logger: Logger) {
    this.config = config
    this.logger = logger
  }

  async start(): Promise<void> {
    // IMAP connection
    this.imap = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: this.config.email, pass: this.config.appPassword },
      logger: false as any,
    })
    await this.imap.connect()
    this.logger.info('gmail IMAP connected', { email: this.config.email })

    // SMTP transport
    this.smtp = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: this.config.email, pass: this.config.appPassword },
    })
    await this.smtp.verify()
    this.logger.info('gmail SMTP verified')
  }

  async stop(): Promise<void> {
    try { await this.imap?.logout() } catch { /* */ }
    this.smtp?.close()
    this.imap = null
    this.smtp = null
  }

  async poll(): Promise<InboxItem[]> {
    if (!this.imap) return []

    const items: InboxItem[] = []
    const labels = this.config.labels ?? ['INBOX']

    for (const label of labels) {
      try {
        const lock = await this.imap.getMailboxLock(label)
        try {
          // Search for unseen messages
          const uids: number[] = []
          for await (const msg of this.imap.fetch({ seen: false }, { uid: true })) {
            uids.push(msg.uid)
          }

          if (uids.length === 0) continue

          // Fetch full messages
          for (const uid of uids) {
            try {
              const raw = await this.imap.fetchOne(uid, { source: true }, { uid: true }) as any
              if (!raw?.source) continue

              const parsed = await simpleParser(raw.source as Buffer)

              const messageId = parsed.messageId ?? `gmail:${uid}`
              if (this.seenIds.has(messageId)) continue
              this.seenIds.add(messageId)

              // Extract text content
              let body = parsed.text ?? ''
              if (!body && parsed.html) {
                // Strip HTML tags as fallback
                body = parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
              }
              const truncated = body.length > 8000
              if (truncated) body = body.slice(0, 8000)

              // Extract attachments
              const attachments: Attachment[] = (parsed.attachments ?? []).map((att: any, i: number) => ({
                name: att.filename ?? `attachment-${i}`,
                mimeType: att.contentType ?? 'application/octet-stream',
                size: att.size ?? 0,
                ref: `gmail:${label}:${uid}:${i}`,
              }))

              // Determine sender
              const fromAddr = parsed.from?.value?.[0]
              const fromEmail = fromAddr?.address ?? 'unknown'
              const fromName = fromAddr?.name ?? fromEmail

              // Thread info
              const references = parsed.references
                ? (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references)
                : null
              const inReplyTo = parsed.inReplyTo ?? null

              items.push({
                id: randomUUID(),
                sourceId: `gmail:${messageId}`,
                channel: 'gmail',
                threadId: references,
                from: {
                  id: `email:${fromEmail}`,
                  name: fromName,
                  channelHandle: fromEmail,
                },
                subject: parsed.subject ?? null,
                body,
                bodyTruncated: truncated,
                attachments,
                timestamp: (parsed.date ?? new Date()).toISOString(),
                priority: derivePriority(parsed.headers),
                type: 'message',
                replyTo: inReplyTo,
                threadSummary: null,
                rawRef: JSON.stringify({ uid, label, messageId, subject: parsed.subject }),
              })

              // Mark as seen
              await this.imap!.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
            } catch (err) {
              this.logger.error(`gmail: failed to process uid ${uid}`, { error: (err as Error).message })
            }
          }
        } finally {
          lock.release()
        }
      } catch (err) {
        this.logger.error(`gmail: poll failed for ${label}`, { error: (err as Error).message })
        // Reconnect on IMAP errors
        try {
          await this.imap.connect()
        } catch { /* */ }
      }
    }

    if (items.length > 0) {
      this.logger.info(`gmail: ${items.length} new emails`)
    }

    return items
  }

  async send(item: OutboxItem): Promise<void> {
    if (!this.smtp) throw new Error('Gmail SMTP not connected')

    // Extract subject from content: first line if it looks like a subject,
    // or derive from thread context
    let subject = 'Message from your assistant'
    let body = item.content

    // Convention: "Subject: ...\n\n<body>" in content
    const subjectMatch = body.match(/^Subject:\s*(.+)\n\n([\s\S]*)$/)
    if (subjectMatch) {
      subject = subjectMatch[1]!
      body = subjectMatch[2]!
    }

    // If replying, prefix subject with Re:
    if (item.replyTo && !subject.startsWith('Re:')) {
      subject = `Re: ${subject}`
    }

    const mailOptions: nodemailer.SendMailOptions = {
      from: this.config.email,
      to: item.to,
      subject,
      text: body,
      attachments: item.attachments.map(filePath => ({
        filename: basename(filePath),
        path: filePath,
      })),
    }

    // Thread headers
    if (item.replyTo) {
      mailOptions.inReplyTo = item.replyTo
    }
    if (item.threadId) {
      mailOptions.references = item.threadId
    }

    await this.smtp.sendMail(mailOptions)
  }

  async downloadAttachment(ref: string, targetPath: string): Promise<void> {
    if (!this.imap) throw new Error('Gmail IMAP not connected')

    // ref format: gmail:<label>:<uid>:<attachmentIndex>
    const parts = ref.split(':')
    const label = parts[1]!
    const uid = parseInt(parts[2]!, 10)
    const attIndex = parseInt(parts[3]!, 10)

    const lock = await this.imap.getMailboxLock(label)
    try {
      const raw = await this.imap.fetchOne(uid, { source: true }, { uid: true }) as any
      if (!raw?.source) throw new Error(`Message ${uid} not found`)

      const parsed = await simpleParser(raw.source as Buffer)
      const att = parsed.attachments?.[attIndex]
      if (!att) throw new Error(`Attachment ${attIndex} not found in message ${uid}`)

      writeFileSync(targetPath, att.content)
    } finally {
      lock.release()
    }
  }
}

function derivePriority(headers: Map<string, any> | undefined): Priority {
  if (!headers) return 'normal'
  const xPriority = headers.get('x-priority')
  if (xPriority) {
    const val = String(xPriority).trim()
    if (val === '1' || val === '2') return 'high'
    if (val === '4' || val === '5') return 'low'
  }
  return 'normal'
}
