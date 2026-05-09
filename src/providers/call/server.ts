import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { CallStore } from './types.js'
import { transcribeChunk, type WhisperConfig } from './transcribe.js'
import type { Logger, EventSignal } from '../../core/interfaces.js'

export interface CallServerConfig {
  port: number
  token: string              // shared auth token
  whisper: WhisperConfig
}

/**
 * HTTP server for TickCaller extension.
 *
 * Endpoints:
 *   POST /call/start   → creates a call session
 *   POST /call/chunk   → receives audio chunk, transcribes, stores segment
 *   POST /call/stop    → ends call session
 *   GET  /call/status  → returns active call info (for debugging)
 *
 * All endpoints require ?token=<secret> for auth.
 * CORS headers set for extension access.
 */
export class CallServer {
  private server: http.Server
  private chunksDir: string

  constructor(
    private config: CallServerConfig,
    private store: CallStore,
    private logger: Logger,
    private eventSignal?: EventSignal,
  ) {
    this.chunksDir = path.join(os.tmpdir(), 'tickcaller-chunks')
    fs.mkdirSync(this.chunksDir, { recursive: true })

    this.server = http.createServer((req, res) => {
      // CORS for extension
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      this.handleRequest(req, res).catch(err => {
        this.logger.error('call server error', { error: (err as Error).message })
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      })
    })
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, () => {
        this.logger.info(`call server listening on :${this.config.port}`)
        resolve()
      })
      this.server.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.config.port}`)
    const pathname = url.pathname
    const token = url.searchParams.get('token')

    // Auth check
    if (token !== this.config.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    if (req.method === 'POST' && pathname === '/call/start') {
      await this.handleStart(url, res)
    } else if (req.method === 'POST' && pathname === '/call/chunk') {
      await this.handleChunk(req, url, res)
    } else if (req.method === 'POST' && pathname === '/call/stop') {
      await this.handleStop(url, res)
    } else if (req.method === 'GET' && pathname === '/call/status') {
      this.handleStatus(res)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  }

  private async handleStart(url: URL, res: http.ServerResponse): Promise<void> {
    const tabTitle = url.searchParams.get('tabTitle') ?? ''
    const tabUrl = url.searchParams.get('tabUrl') ?? ''

    // Check for existing active call
    const existing = this.store.getActiveCall()
    if (existing) {
      // End the previous call first
      this.store.endCall(existing.callId)
      this.logger.info('ended previous call', { callId: existing.callId })
    }

    const callId = this.store.createCall(tabTitle, tabUrl)
    this.logger.info('call started', { callId, tabTitle })

    // Signal the tick loop — new call is an event
    this.eventSignal?.signal()

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ callId, startedAt: new Date().toISOString() }))
  }

  private async handleChunk(req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<void> {
    const callId = url.searchParams.get('callId')
    if (!callId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing callId' }))
      return
    }

    const call = this.store.getCall(callId)
    if (!call || call.status !== 'active') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Call not found or not active' }))
      return
    }

    // Parse multipart form data — extract the "chunk" file
    const chunkPath = await this.parseMultipartChunk(req)
    if (!chunkPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No chunk file in request' }))
      return
    }

    this.logger.info('chunk received', { callId, size: fs.statSync(chunkPath).size })

    // Transcribe
    const transcript = await transcribeChunk(chunkPath, this.config.whisper)

    // Clean up temp file
    try { fs.unlinkSync(chunkPath) } catch {}

    if (transcript) {
      // Estimate duration from chunk cycle (60s)
      this.store.addSegment(callId, transcript, 60)
      this.logger.info('segment transcribed', { callId, chars: transcript.length })
      // Don't signal eventSignal here — chunks arrive every 60s and would
      // cause a tick each time, burning tokens on "nothing to do." The agent
      // sees the call context on its next natural tick (heartbeat or event).
    } else {
      this.logger.warn('transcription returned empty', { callId })
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, transcript: transcript ?? '' }))
  }

  private async handleStop(url: URL, res: http.ServerResponse): Promise<void> {
    const callId = url.searchParams.get('callId')
    if (!callId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing callId' }))
      return
    }

    this.store.endCall(callId)
    this.logger.info('call ended', { callId })

    // Signal — call state changed
    this.eventSignal?.signal()

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, callId }))
  }

  private handleStatus(res: http.ServerResponse): void {
    const active = this.store.getActiveCall()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ active }))
  }

  /**
   * Minimal multipart/form-data parser — extracts the first file field
   * and writes it to a temp file. Returns the path, or null if no file found.
   *
   * We do this without a dependency (no multer/busboy) because the payload
   * is simple: one file field named "chunk".
   */
  private parseMultipartChunk(req: http.IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const contentType = req.headers['content-type'] ?? ''
      const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/)
      if (!boundaryMatch) {
        resolve(null)
        return
      }

      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('error', reject)
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks)
          const boundary = boundaryMatch[1]!
          const boundaryBuf = Buffer.from(`--${boundary}`)

          // Find the file content between boundaries
          // Simple approach: find Content-Type in the part, then the \r\n\r\n separator
          const bodyStr = body.toString('latin1')
          const parts = bodyStr.split(`--${boundary}`)

          for (const part of parts) {
            if (!part.includes('filename=')) continue
            const headerEnd = part.indexOf('\r\n\r\n')
            if (headerEnd === -1) continue

            const fileData = part.slice(headerEnd + 4)
            // Remove trailing \r\n-- boundary marker
            const cleanData = fileData.replace(/\r\n--$/, '').replace(/\r\n$/, '')

            const filePath = path.join(this.chunksDir, `chunk-${Date.now()}.webm`)
            // Write as binary (we used latin1 to preserve bytes)
            fs.writeFileSync(filePath, cleanData, 'latin1')
            resolve(filePath)
            return
          }
          resolve(null)
        } catch (err) {
          reject(err)
        }
      })
    })
  }
}
