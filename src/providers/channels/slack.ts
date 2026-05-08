import { randomUUID } from 'node:crypto'
import { createReadStream, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { WebClient } from '@slack/web-api'
import type { ChannelAdapter } from '../../core/interfaces.js'
import type { InboxItem, OutboxItem, Priority, InboxItemType, Attachment } from '../../core/types.js'
import type { Logger } from '../../core/interfaces.js'

export interface SlackConfig {
  botToken: string
  channels: string[]
  botUserId?: string
}

export class SlackChannelAdapter implements ChannelAdapter {
  readonly name = 'slack'
  private client: WebClient
  private botUserId: string | null = null
  private lastTimestamps: Map<string, string> = new Map()
  private userCache: Map<string, string> = new Map()

  constructor(
    private config: SlackConfig,
    private logger: Logger,
  ) {
    this.client = new WebClient(config.botToken)
  }

  async start(): Promise<void> {
    try {
      const auth = await this.client.auth.test()
      this.botUserId = auth.user_id as string
      this.config.botUserId = this.botUserId
      this.logger.info('slack connected', { botUserId: this.botUserId, channels: this.config.channels })
    } catch (err) {
      throw new Error(`Slack auth failed: ${(err as Error).message}`)
    }

    // Look back 5 minutes on first poll to catch recent messages
    const fiveMinAgo = String((Date.now() / 1000) - 300)
    for (const ch of this.config.channels) {
      this.lastTimestamps.set(ch, fiveMinAgo)
    }
  }

  async stop(): Promise<void> {}

  async poll(): Promise<InboxItem[]> {
    const items: InboxItem[] = []

    for (const channelId of this.config.channels) {
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

          // Extract file attachments
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

    // Send text message
    if (item.content) {
      await this.client.chat.postMessage({
        channel,
        text: item.content,
        ...(item.threadId ? { thread_ts: item.threadId } : {}),
      })
    }

    // Upload file attachments
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
    // ref format: slack:<channel>:<file_id>:<url_private>
    const parts = ref.split(':')
    const urlPrivate = parts.slice(3).join(':') // rejoin in case URL has colons

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
