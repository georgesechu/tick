/**
 * RealtimeVoiceChannel — OpenAI Realtime API voice channel adapter.
 *
 * Connects to OpenAI's Realtime API via WebSocket, streams audio from
 * PulseAudio (either a local mic or a container's audio output), and
 * receives real-time transcription + function calls.
 *
 * Works for both:
 *   - Rudy (local headset on nuc): bidirectional voice conversation
 *   - Johan (container Meet audio): listen-only meeting transcription
 *
 * Audio format: 24kHz 16-bit mono PCM (what OpenAI Realtime expects)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ChannelAdapter, RealtimeHandler } from '../../core/interfaces.js'
import type { InboxItem, OutboxItem } from '../../core/types.js'
import type { Logger } from '../../core/interfaces.js'

export interface VoiceChannelConfig {
  /** PulseAudio source name for audio input (mic or monitor) */
  source?: string
  /** PulseAudio sink name for audio output (speakers). null = listen-only */
  sink?: string | null
  /** OpenAI API key */
  apiKey: string
  /** OpenAI model for Realtime API */
  model?: string
  /** Voice for responses */
  voice?: 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse'
  /** System instructions for the Realtime session */
  instructions?: string
  /** Whether to use server VAD (voice activity detection) */
  vad?: boolean
  /** Functions the Realtime API can call */
  functions?: VoiceFunction[]
  /** Agent name (for inbox items) */
  agentName?: string
}

export interface VoiceFunction {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface RealtimeEvent {
  type: string
  [key: string]: unknown
}

export class RealtimeVoiceChannel implements ChannelAdapter {
  readonly name = 'voice'
  private ws: WebSocket | null = null
  private captureProc: ChildProcess | null = null
  private playbackProc: ChildProcess | null = null
  private realtimeHandler: RealtimeHandler | null = null
  private connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private currentTranscript = ''
  private sessionTranscript: string[] = []
  private functionHandlers: Map<string, (args: Record<string, unknown>) => Promise<string>> = new Map()

  constructor(
    private config: VoiceChannelConfig,
    private logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.connect()
  }

  async stop(): Promise<void> {
    this.disconnect()
  }

  async listen(handler: RealtimeHandler): Promise<void> {
    this.realtimeHandler = handler
  }

  async poll(): Promise<InboxItem[]> {
    return [] // voice uses realtime handler, not polling
  }

  async send(item: OutboxItem): Promise<void> {
    // Send text as speech via the Realtime API
    if (this.ws && this.connected && this.config.sink) {
      this.sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: item.content,
          }],
        },
      })
      // Trigger a response so it speaks
      this.sendEvent({ type: 'response.create' })
    }
  }

  /** Register a function handler that the Realtime API can call */
  registerFunction(name: string, handler: (args: Record<string, unknown>) => Promise<string>): void {
    this.functionHandlers.set(name, handler)
  }

  // ── Connection ──

  private connect(): void {
    const model = this.config.model ?? 'gpt-4o-realtime-preview'
    const url = `wss://api.openai.com/v1/realtime?model=${model}`

    this.logger.info('voice: connecting to OpenAI Realtime API')

    this.ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    } as any)

    this.ws.onopen = () => {
      this.connected = true
      this.logger.info('voice: connected')
      this.configureSession()
      this.startAudioCapture()
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as RealtimeEvent
        this.handleEvent(data)
      } catch (err) {
        this.logger.error('voice: failed to parse event', { error: (err as Error).message })
      }
    }

    this.ws.onerror = (event) => {
      this.logger.error('voice: WebSocket error')
    }

    this.ws.onclose = (event) => {
      this.connected = false
      this.stopAudioCapture()
      this.logger.warn('voice: disconnected', { code: event.code, reason: event.reason })
      // Reconnect after delay
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          this.connect()
        }, 5000)
      }
    }
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopAudioCapture()
    this.stopPlayback()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
  }

  private configureSession(): void {
    const tools = (this.config.functions ?? []).map(f => ({
      type: 'function',
      name: f.name,
      description: f.description,
      parameters: f.parameters,
    }))

    this.sendEvent({
      type: 'session.update',
      session: {
        modalities: this.config.sink ? ['text', 'audio'] : ['text'],
        instructions: this.config.instructions ?? 'You are a helpful assistant. Transcribe and respond to what you hear.',
        voice: this.config.voice ?? 'sage',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: this.config.vad !== false ? {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 1000,
        } : null,
        tools,
      },
    })
  }

  // ── Audio Capture (PulseAudio → WebSocket) ──

  private startAudioCapture(): void {
    const source = this.config.source ?? 'default'

    // parec captures audio from PulseAudio
    // OpenAI Realtime expects: 24kHz, 16-bit signed LE, mono
    this.captureProc = spawn('parec', [
      '--format=s16le',
      '--rate=24000',
      '--channels=1',
      `--device=${source}`,
      '--raw',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.captureProc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim()
      if (msg) this.logger.debug('voice capture stderr', { msg })
    })

    this.captureProc.stdout?.on('data', (chunk: Buffer) => {
      if (!this.connected || !this.ws) return

      // Convert raw PCM to base64 and send as audio append
      const b64 = chunk.toString('base64')
      this.sendEvent({
        type: 'input_audio_buffer.append',
        audio: b64,
      })
    })

    this.captureProc.on('error', (err) => {
      this.logger.error('voice: capture process error', { error: err.message })
    })

    this.captureProc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.logger.warn('voice: capture process exited', { code })
      }
    })

    this.logger.info('voice: audio capture started', { source })
  }

  private stopAudioCapture(): void {
    if (this.captureProc) {
      this.captureProc.kill()
      this.captureProc = null
    }
  }

  // ── Audio Playback (WebSocket → PulseAudio) ──

  private ensurePlayback(): void {
    if (this.playbackProc || !this.config.sink) return

    this.playbackProc = spawn('paplay', [
      '--format=s16le',
      '--rate=24000',
      '--channels=1',
      `--device=${this.config.sink}`,
      '--raw',
    ], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    this.playbackProc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim()
      if (msg) this.logger.debug('voice playback stderr', { msg })
    })

    this.playbackProc.on('close', () => {
      this.playbackProc = null
    })

    this.logger.info('voice: playback started', { sink: this.config.sink })
  }

  private stopPlayback(): void {
    if (this.playbackProc) {
      this.playbackProc.stdin?.end()
      this.playbackProc.kill()
      this.playbackProc = null
    }
  }

  // ── Event Handling ──

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'session.created':
        this.logger.info('voice: session created')
        break

      case 'session.updated':
        this.logger.info('voice: session configured')
        break

      case 'error':
        this.logger.error('voice: API error', {
          error: (event.error as any)?.message ?? JSON.stringify(event.error),
        })
        break

      // ── Input transcription (what was said TO the agent) ──
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = (event.transcript as string ?? '').trim()
        if (transcript) {
          this.logger.info('voice: heard', { transcript: transcript.slice(0, 100) })
          this.sessionTranscript.push(`[user] ${transcript}`)
          this.pushToInbox(transcript)
        }
        break
      }

      // ── Output transcription (what the agent said back) ──
      case 'response.audio_transcript.done': {
        const transcript = (event.transcript as string ?? '').trim()
        if (transcript) {
          this.logger.info('voice: spoke', { transcript: transcript.slice(0, 100) })
          this.sessionTranscript.push(`[assistant] ${transcript}`)
        }
        break
      }

      // ── Audio output (play through speakers) ──
      case 'response.audio.delta': {
        if (this.config.sink && event.delta) {
          this.ensurePlayback()
          const pcm = Buffer.from(event.delta as string, 'base64')
          this.playbackProc?.stdin?.write(pcm)
        }
        break
      }

      // ── Function calls ──
      case 'response.function_call_arguments.done': {
        const callId = event.call_id as string
        const name = event.name as string
        const argsStr = event.arguments as string
        this.handleFunctionCall(callId, name, argsStr)
        break
      }

      // ── Speech detection ──
      case 'input_audio_buffer.speech_started':
        this.logger.debug('voice: speech detected')
        break

      case 'input_audio_buffer.speech_stopped':
        this.logger.debug('voice: speech ended')
        break

      default:
        // Ignore other events (there are many — audio deltas, etc.)
        break
    }
  }

  // ── Function Call Handling ──

  private async handleFunctionCall(callId: string, name: string, argsStr: string): Promise<void> {
    this.logger.info('voice: function call', { name, args: argsStr.slice(0, 100) })

    let args: Record<string, unknown>
    try {
      args = JSON.parse(argsStr)
    } catch {
      args = {}
    }

    const handler = this.functionHandlers.get(name)
    let result: string

    if (handler) {
      try {
        result = await handler(args)
      } catch (err) {
        result = `Error: ${(err as Error).message}`
      }
    } else {
      result = `Unknown function: ${name}`
      this.logger.warn('voice: unknown function called', { name })
    }

    // Send function result back to the Realtime API
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: result,
      },
    })

    // Trigger a response after function result
    this.sendEvent({ type: 'response.create' })
  }

  // ── Inbox Integration ──

  private pushToInbox(transcript: string): void {
    const item: InboxItem = {
      id: randomUUID(),
      sourceId: `voice:${Date.now()}`,
      channel: 'voice',
      threadId: null,
      from: {
        id: 'user:voice',
        name: 'Voice',
        channelHandle: 'voice',
      },
      subject: null,
      body: transcript,
      bodyTruncated: false,
      attachments: [],
      timestamp: new Date().toISOString(),
      priority: 'normal',
      type: 'message',
      replyTo: null,
      threadSummary: null,
      rawRef: '',
    }

    if (this.realtimeHandler) {
      this.realtimeHandler.onMessage([item])
    }
  }

  // ── Helpers ──

  private sendEvent(event: Record<string, unknown>): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(event))
    }
  }

  /** Get the full session transcript so far */
  getTranscript(): string[] {
    return [...this.sessionTranscript]
  }

  /** Clear the session transcript */
  clearTranscript(): void {
    this.sessionTranscript = []
  }
}
