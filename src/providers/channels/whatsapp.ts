import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys'
import type { ChannelAdapter } from '../../core/interfaces.js'
import type { InboxItem, OutboxItem, Priority, InboxItemType, Attachment } from '../../core/types.js'
import type { Logger } from '../../core/interfaces.js'

export interface WhatsAppConfig {
  authDir: string              // where to store auth state (scan QR once)
  chats: string[]              // JIDs to monitor: number@s.whatsapp.net or groupid@g.us
  myJid?: string               // resolved on connect
}

export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly name = 'whatsapp'
  private sock: WASocket | null = null
  private config: WhatsAppConfig
  private logger: Logger
  private messageQueue: InboxItem[] = []
  private contactCache: Map<string, string> = new Map()
  private monitorAll: boolean  // if no chats specified, monitor everything

  constructor(config: WhatsAppConfig, logger: Logger) {
    this.config = config
    this.logger = logger
    this.monitorAll = config.chats.length === 0

    // Ensure auth directory exists
    mkdirSync(config.authDir, { recursive: true })
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir)

    // Suppress Baileys' noisy internal logging
    const pino = (await import('pino')).default
    const silentLogger = pino({ level: 'silent' })

    this.sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('Tick'),
      printQRInTerminal: true,
      logger: silentLogger as any,
    })

    this.sock.ev.on('creds.update', saveCreds)

    this.sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.logger.info('whatsapp: scan QR code in terminal to connect')
      }
      if (connection === 'open') {
        this.config.myJid = this.sock?.user?.id
        this.logger.info('whatsapp connected', { jid: this.config.myJid })
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          this.logger.error('whatsapp logged out — delete auth dir and re-scan QR')
        } else {
          this.logger.warn('whatsapp disconnected, reconnecting...', { code })
          // Reconnect
          setTimeout(() => this.start(), 5000)
        }
      }
    })

    // Capture incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        if (!msg.message) continue
        if (msg.key.fromMe) continue

        const jid = msg.key.remoteJid
        if (!jid) continue

        // Check if we should monitor this chat
        if (!this.monitorAll && !this.config.chats.includes(jid)) continue

        const item = await this.messageToInboxItem(msg, jid)
        if (item) {
          this.messageQueue.push(item)
        }
      }
    })
  }

  async stop(): Promise<void> {
    this.sock?.end(undefined)
    this.sock = null
  }

  async poll(): Promise<InboxItem[]> {
    // Drain the queue — messages arrive via WebSocket events
    const items = [...this.messageQueue]
    this.messageQueue = []
    return items
  }

  async send(item: OutboxItem): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected')

    const jid = item.to

    // Show typing indicator briefly
    try {
      await this.sock.sendPresenceUpdate('composing', jid)
      await sleep(500 + Math.random() * 1000) // feel more natural
      await this.sock.sendPresenceUpdate('paused', jid)
    } catch { /* typing indicator is best-effort */ }

    // Send text
    if (item.content) {
      const opts: any = {}

      // If replying to a specific message
      if (item.replyTo) {
        opts.quoted = { key: { remoteJid: jid, id: item.replyTo } }
      }

      await this.sock.sendMessage(jid, { text: item.content }, opts)
    }

    // Send file attachments
    for (const filePath of item.attachments) {
      try {
        const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
        const filename = basename(filePath)

        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
          await this.sock.sendMessage(jid, {
            image: { url: filePath },
            caption: filename,
          })
        } else if (['mp4', 'mov', 'avi'].includes(ext)) {
          await this.sock.sendMessage(jid, {
            video: { url: filePath },
            caption: filename,
          })
        } else if (['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) {
          await this.sock.sendMessage(jid, {
            audio: { url: filePath },
            mimetype: 'audio/mp4',
          })
        } else {
          await this.sock.sendMessage(jid, {
            document: { url: filePath },
            mimetype: guessMime(ext),
            fileName: filename,
          })
        }
      } catch (err) {
        this.logger.error(`whatsapp file send failed: ${filePath}`, { error: (err as Error).message })
      }
    }
  }

  async downloadAttachment(ref: string, targetPath: string): Promise<void> {
    // ref format: whatsapp:<jid>:<msgId>:<mediaType>
    // We store the original message in the queue for download
    // For now, use the raw message data stored in rawRef
    throw new Error('WhatsApp attachment download: use the rawRef JSON to reconstruct the message for downloadMediaMessage()')
  }

  // --- Private ---

  private async messageToInboxItem(msg: proto.IWebMessageInfo, jid: string): Promise<InboxItem | null> {
    const text = this.extractText(msg)
    if (!text && !msg.message?.imageMessage && !msg.message?.documentMessage && !msg.message?.videoMessage && !msg.message?.audioMessage) {
      return null
    }

    const isGroup = jid.endsWith('@g.us')
    const senderJid = isGroup ? (msg.key?.participant ?? jid) : jid
    const senderName = await this.resolveContact(senderJid)

    // Extract attachments
    const attachments: Attachment[] = []
    const mediaTypes = ['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'] as const
    for (const mtype of mediaTypes) {
      const media = msg.message?.[mtype] as any
      if (media) {
        attachments.push({
          name: media.fileName ?? media.caption ?? `${mtype}.bin`,
          mimeType: media.mimetype ?? 'application/octet-stream',
          size: media.fileLength ? Number(media.fileLength) : 0,
          ref: `whatsapp:${jid}:${msg.key?.id}:${mtype}`,
        })
      }
    }

    // Determine priority — DMs are higher priority than group chatter
    const myJid = this.config.myJid?.split(':')[0] ?? ''
    const isMentioned = text?.includes(`@${myJid}`) ?? false
    let priority: Priority = 'normal'
    if (!isGroup) priority = 'high'       // DMs are always high
    else if (isMentioned) priority = 'high' // @mentions in groups

    const type: InboxItemType = isMentioned ? 'mention' : 'message'

    return {
      id: randomUUID(),
      sourceId: `whatsapp:${jid}:${msg.key?.id}`,
      channel: 'whatsapp',
      threadId: isGroup ? jid : null,   // group JID acts as thread
      from: {
        id: `wa:${senderJid}`,
        name: senderName,
        channelHandle: senderJid.split('@')[0] ?? senderJid,
      },
      subject: isGroup ? (await this.resolveGroupName(jid)) : null,
      body: text ?? (attachments.length > 0 ? `[${attachments[0]!.name}]` : ''),
      bodyTruncated: false,
      attachments,
      timestamp: new Date((msg.messageTimestamp as number) * 1000).toISOString(),
      priority,
      type,
      replyTo: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null,
      threadSummary: null,
      rawRef: JSON.stringify(msg),
    }
  }

  private extractText(msg: proto.IWebMessageInfo): string | null {
    const m = msg.message
    if (!m) return null
    return m.conversation
      ?? m.extendedTextMessage?.text
      ?? m.imageMessage?.caption
      ?? m.videoMessage?.caption
      ?? m.documentMessage?.caption
      ?? null
  }

  private async resolveContact(jid: string): Promise<string> {
    if (this.contactCache.has(jid)) return this.contactCache.get(jid)!

    const number = jid.split('@')[0] ?? jid
    // Try to get contact name from WhatsApp
    try {
      const results = await this.sock!.onWhatsApp(number) ?? []
      const result = results[0]
      if (result?.exists) {
        // Store number as name — real name requires contacts sync which is heavier
        this.contactCache.set(jid, number)
      }
    } catch { /* */ }

    this.contactCache.set(jid, number)
    return number
  }

  private async resolveGroupName(jid: string): Promise<string | null> {
    const cached = this.contactCache.get(`group:${jid}`)
    if (cached) return cached

    try {
      const metadata = await this.sock!.groupMetadata(jid)
      this.contactCache.set(`group:${jid}`, metadata.subject)
      return metadata.subject
    } catch {
      return null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function guessMime(ext: string): string {
  const mimes: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
  }
  return mimes[ext] ?? 'application/octet-stream'
}
