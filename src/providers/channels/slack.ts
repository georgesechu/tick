import { randomUUID } from 'node:crypto'
import { createReadStream, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import type { ChannelAdapter, RealtimeHandler } from '../../core/interfaces.js'
import type { InboxItem, OutboxItem, Priority, InboxItemType, Attachment } from '../../core/types.js'
import type { Logger } from '../../core/interfaces.js'

export interface SlackConfig {
  botToken: string
  appToken?: string          // xapp-... for Socket Mode
  channels?: string[]        // channel IDs to poll (fallback if no appToken)
  botUserId?: string
}

export class SlackChannelAdapter implements ChannelAdapter {
  readonly name = 'slack'
  private client: WebClient
  private socket: SocketModeClient | null = null
  private botUserId: string | null = null
  private userCache: Map<string, string> = new Map()
  private realtimeHandler: RealtimeHandler | null = null

  // Socket Mode: messages buffer between polls (used when no listen handler)
  private messageBuffer: InboxItem[] = []

  // Poll Mode fallback: cursor tracking
  private lastTimestamps: Map<string, string> = new Map()
  private useSocketMode: boolean

  constructor(
    private config: SlackConfig,
    private logger: Logger,
  ) {
    this.client = new WebClient(config.botToken)
    this.useSocketMode = !!config.appToken
  }

  async start(): Promise<void> {
    // Resolve bot user ID
    try {
      const auth = await this.client.auth.test()
      this.botUserId = auth.user_id as string
      this.config.botUserId = this.botUserId
    } catch (err) {
      throw new Error(`Slack auth failed: ${(err as Error).message}`)
    }

    if (this.useSocketMode) {
      await this.startSocketMode()
    } else {
      // Poll mode fallback — set cursor to 5 min ago
      const fiveMinAgo = String((Date.now() / 1000) - 300)
      for (const ch of this.config.channels ?? []) {
        this.lastTimestamps.set(ch, fiveMinAgo)
      }
      this.logger.info('slack connected (poll mode)', {
        botUserId: this.botUserId,
        channels: this.config.channels,
      })
    }
  }

  private async startSocketMode(): Promise<void> {
    this.socket = new SocketModeClient({ appToken: this.config.appToken! })

    // Log all events for debugging
    this.socket.on('slack_event', ({ body }) => {
      const type = body?.event?.type ?? body?.type ?? 'unknown'
      const subtype = body?.event?.subtype ?? ''
      const user = body?.event?.user ?? ''
      const channel = body?.event?.channel ?? ''
      this.logger.debug('slack raw event', { type, subtype, user, channel })
    })

    // Listen for all message events
    this.socket.on('message', async ({ event, ack }) => {
      await ack()
      if (!event) return
      await this.handleMessageEvent(event)
    })

    // Listen for app_mention events (@ mentions in channels)
    this.socket.on('app_mention', async ({ event, ack }) => {
      await ack()
      if (!event) return
      await this.handleMessageEvent(event, true)
    })

    await this.socket.start()
    this.logger.info('slack connected (socket mode)', { botUserId: this.botUserId })
  }

  private async handleMessageEvent(event: any, isMention = false): Promise<void> {
    // Skip bot's own messages
    if (event.user === this.botUserId) return
    // Skip message subtypes (edits, deletes, joins, etc.)
    if (event.subtype) return
    if (!event.user || !event.text) return

    const hasMention = isMention || (event.text?.includes(`<@${this.botUserId}>`) ?? false)
    const userName = await this.resolveUser(event.user)
    const channelId = event.channel

    // Extract file attachments
    const attachments: Attachment[] = []
    if (event.files && Array.isArray(event.files)) {
      for (const file of event.files) {
        attachments.push({
          name: file.name ?? 'unnamed',
          mimeType: file.mimetype ?? 'application/octet-stream',
          size: file.size ?? 0,
          ref: `slack:${channelId}:${file.id}:${file.url_private ?? ''}`,
        })
      }
    }

    const item: InboxItem = {
      id: randomUUID(),
      sourceId: `slack:${channelId}:${event.ts}`,
      channel: 'slack',
      threadId: event.thread_ts ?? null,
      from: {
        id: `user:${event.user}`,
        name: userName,
        channelHandle: `<@${event.user}>`,
      },
      subject: null,
      body: event.text,
      bodyTruncated: false,
      attachments,
      timestamp: new Date(parseFloat(event.ts) * 1000).toISOString(),
      priority: (hasMention ? 'high' : 'normal') as Priority,
      type: (hasMention ? 'mention' : 'message') as InboxItemType,
      replyTo: null,
      threadSummary: null,
      rawRef: JSON.stringify(event),
    }

    if (this.realtimeHandler) {
      // Push directly — wakes the tick loop
      this.realtimeHandler.onMessage([item])
    } else {
      // Buffer for next poll()
      this.messageBuffer.push(item)
    }
    this.logger.debug('slack event', { from: userName, channel: channelId, realtime: !!this.realtimeHandler })
  }

  async listen(handler: RealtimeHandler): Promise<void> {
    this.realtimeHandler = handler
    this.logger.info('slack: realtime listener attached')
  }

  async stop(): Promise<void> {
    if (this.socket) {
      await this.socket.disconnect()
      this.socket = null
    }
  }

  async poll(): Promise<InboxItem[]> {
    if (this.useSocketMode) {
      // Drain the buffer — socket events accumulate between ticks
      const items = [...this.messageBuffer]
      this.messageBuffer = []
      return items
    }

    // Poll mode fallback for channels without app token
    return this.pollChannels()
  }

  private async pollChannels(): Promise<InboxItem[]> {
    const items: InboxItem[] = []

    for (const channelId of this.config.channels ?? []) {
      try {
        const oldest = this.lastTimestamps.get(channelId) ?? '0'
        const result = await this.client.conversations.history({
          channel: channelId,
          oldest,
          limit: 50,
          inclusive: false,
        })

        if (!result.messages || result.messages.length === 0) continue
        const messages = result.messages.reverse()

        for (const msg of messages) {
          if (msg.user === this.botUserId) continue
          if (!msg.user || !msg.text) continue

          const isMention = msg.text.includes(`<@${this.botUserId}>`)
          const userName = await this.resolveUser(msg.user)

          const attachments: Attachment[] = []
          if (msg.files && Array.isArray(msg.files)) {
            for (const file of msg.files) {
              attachments.push({
                name: file.name ?? 'unnamed',
                mimeType: file.mimetype ?? 'application/octet-stream',
                size: file.size ?? 0,
                ref: `slack:${channelId}:${file.id}:${file.url_private ?? ''}`,
              })
            }
          }

          items.push({
            id: randomUUID(),
            sourceId: `slack:${channelId}:${msg.ts}`,
            channel: 'slack',
            threadId: msg.thread_ts ?? null,
            from: {
              id: `user:${msg.user}`,
              name: userName,
              channelHandle: `<@${msg.user}>`,
            },
            subject: null,
            body: msg.text,
            bodyTruncated: false,
            attachments,
            timestamp: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
            priority: (isMention ? 'high' : 'normal') as Priority,
            type: (isMention ? 'mention' : 'message') as InboxItemType,
            replyTo: null,
            threadSummary: null,
            rawRef: JSON.stringify(msg),
          })
        }

        const latest = messages[messages.length - 1]
        if (latest?.ts) {
          this.lastTimestamps.set(channelId, latest.ts)
        }
      } catch (err) {
        this.logger.error(`slack poll failed for ${channelId}`, { error: (err as Error).message })
      }
    }

    return items
  }

  async send(item: OutboxItem): Promise<void> {
    let channel = item.to
    if (channel.startsWith('#')) channel = channel.slice(1)

    if (item.content) {
      await this.client.chat.postMessage({
        channel,
        text: item.content,
        ...(item.threadId ? { thread_ts: item.threadId } : {}),
      })
    }

    if (item.attachments && item.attachments.length > 0) {
      for (const filePath of item.attachments) {
        try {
          const uploadArgs: Record<string, unknown> = {
            channel_id: channel,
            file: createReadStream(filePath),
            filename: basename(filePath),
          }
          if (item.threadId) uploadArgs.thread_ts = item.threadId
          await this.client.filesUploadV2(uploadArgs as any)
        } catch (err) {
          this.logger.error(`slack file upload failed: ${filePath}`, { error: (err as Error).message })
        }
      }
    }
  }

  async downloadAttachment(ref: string, targetPath: string): Promise<void> {
    const parts = ref.split(':')
    const urlPrivate = parts.slice(3).join(':')

    if (!urlPrivate) {
      throw new Error(`No download URL in attachment ref: ${ref}`)
    }

    const response = await fetch(urlPrivate, {
      headers: { 'Authorization': `Bearer ${this.config.botToken}` },
    })

    if (!response.ok) {
      throw new Error(`Slack file download failed: ${response.status} ${response.statusText}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    writeFileSync(targetPath, buffer)
  }

  private async resolveUser(userId: string): Promise<string> {
    if (this.userCache.has(userId)) return this.userCache.get(userId)!
    try {
      const result = await this.client.users.info({ user: userId })
      const name = result.user?.profile?.display_name
        || result.user?.real_name
        || result.user?.name
        || userId
      this.userCache.set(userId, name)
      return name
    } catch {
      return userId
    }
  }
}
