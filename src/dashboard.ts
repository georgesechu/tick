/**
 * Dashboard server — serves the web UI + JSON API for inspecting agent state.
 *
 * Reads the SQLite database (read-only) and serves:
 *   GET /api/status    — agent status, last tick, scratchpad, stats
 *   GET /api/memory    — all memory entries (latest version per key)
 *   GET /api/memory/:key — single memory entry with full history
 *   GET /api/ticks     — recent ticks (default 50)
 *   GET /api/inbox     — recent inbox items
 *   GET /api/outbox    — recent outbox items
 *   GET /api/calls     — call sessions
 *   GET /api/prompt    — reconstructed prompt context
 *   GET /api/logs      — live journal logs via SSE
 *   GET /*             — static files from web/
 *
 * Usage: npx tsx src/dashboard.ts --agent agents/johan [--port 8080]
 */

import { readFileSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function main() {
  const args = process.argv.slice(2)
  const agentDir = resolve(getArg(args, '--agent') ?? 'agents/johan')
  const port = parseInt(getArg(args, '--port') ?? '8080', 10)
  const dbPath = resolve(getArg(args, '--db') ?? `${agentDir}/tick.db`)
  const webDir = resolve(import.meta.dirname ?? '.', '..', 'web')

  // Load agent config
  let agentName = 'unknown', agentModel = '', systemPrompt = ''
  try {
    const yaml = readFileSync(resolve(agentDir, 'agent.yaml'), 'utf-8')
    agentName = yaml.match(/name:\s*(.+)/)?.[1]?.trim() ?? 'unknown'
    agentModel = yaml.match(/model:\s*(.+)/)?.[1]?.trim() ?? ''
    const promptFile = yaml.match(/systemPromptFile:\s*(.+)/)?.[1]?.trim() ?? 'system-prompt.md'
    systemPrompt = readFileSync(resolve(agentDir, promptFile), 'utf-8')
  } catch { /* */ }

  // Open DB read-only
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true })
    db.pragma('journal_mode = WAL')
  } catch (err) {
    console.error(`Cannot open ${dbPath}:`, (err as Error).message)
    process.exit(1)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    const path = url.pathname

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')

    try {
      if (path.startsWith('/api/')) {
        return handleAPI(path, url, db, agentName, agentModel, systemPrompt, res)
      }

      // SSE endpoint for live logs
      if (path === '/logs') {
        return handleLogStream(agentName, res)
      }

      // Static files
      const filePath = path === '/' ? '/index.html' : path
      try {
        const content = readFileSync(resolve(webDir, filePath.slice(1)))
        const mime = MIME[extname(filePath)] ?? 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' })
        res.end(content)
      } catch {
        // SPA fallback
        try {
          const content = readFileSync(resolve(webDir, 'index.html'))
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
          res.end(content)
        } catch {
          res.writeHead(404)
          res.end('Not found')
        }
      }
    } catch (err) {
      console.error('Request error:', (err as Error).message)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal error' }))
      }
    }
  })

  server.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`)
    console.log(`Agent: ${agentName} (${agentModel})`)
    console.log(`DB: ${dbPath}`)
  })
}

function json(res: any, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function handleAPI(
  path: string, url: URL, db: Database.Database,
  agentName: string, agentModel: string, systemPrompt: string,
  res: any,
) {
  // GET /api/status
  if (path === '/api/status') {
    const lastTick = db.prepare('SELECT * FROM ticks ORDER BY tick_number DESC LIMIT 1').get() as any
    const totalTicks = (db.prepare('SELECT COUNT(*) as c FROM ticks').get() as any).c
    const scratchpad = safeGet(db, 'scratchpad')
    const lastStatus = safeGet(db, 'lastStatus')
    const timers = safeGet(db, 'timers')
    const tokenStats = db.prepare('SELECT SUM(input_tokens) as i, SUM(output_tokens) as o FROM ticks').get() as any
    const unread = (db.prepare('SELECT COUNT(*) as c FROM inbox WHERE read = 0').get() as any).c
    const totalInbox = (db.prepare('SELECT COUNT(*) as c FROM inbox').get() as any).c
    const pendingOut = (db.prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'pending'").get() as any).c
    const sentOut = (db.prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'sent'").get() as any).c
    const memoryCount = (db.prepare('SELECT COUNT(DISTINCT key) as c FROM memory WHERE deleted = 0').get() as any).c

    // Active call
    let activeCall = null
    try {
      activeCall = db.prepare("SELECT * FROM calls WHERE status = 'active' ORDER BY started_at DESC LIMIT 1").get() as any
    } catch { /* calls table might not exist */ }

    return json(res, {
      agent: { name: agentName, model: agentModel },
      status: lastStatus ?? 'unknown',
      scratchpad,
      timers: timers ? JSON.parse(timers) : [],
      lastTick: lastTick ? {
        tickNumber: lastTick.tick_number,
        status: lastTick.status,
        startedAt: lastTick.started_at,
        durationMs: lastTick.duration_ms,
        inputTokens: lastTick.input_tokens,
        outputTokens: lastTick.output_tokens,
        actions: lastTick.actions_executed,
        memoryOps: lastTick.memory_ops_executed,
        error: lastTick.error,
      } : null,
      stats: {
        totalTicks,
        tokensIn: tokenStats?.i ?? 0,
        tokensOut: tokenStats?.o ?? 0,
        unreadInbox: unread,
        totalInbox,
        pendingOutbox: pendingOut,
        sentOutbox: sentOut,
        memoryKeys: memoryCount,
      },
      activeCall: activeCall ? {
        callId: activeCall.call_id,
        tabTitle: activeCall.tab_title,
        tabUrl: activeCall.tab_url,
        startedAt: activeCall.started_at,
        totalSegments: activeCall.total_segments,
      } : null,
    })
  }

  // GET /api/memory
  if (path === '/api/memory') {
    const memories = getMemories(db)
    return json(res, memories.map((m: any) => ({
      key: m.key,
      value: m.value,
      summary: m.summary,
      type: m.type,
      pinned: !!m.pinned,
      related: JSON.parse(m.related || '[]'),
      version: m.version,
      accessCount: m.access_count,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    })))
  }

  // GET /api/memory/:key
  const memMatch = path.match(/^\/api\/memory\/(.+)$/)
  if (memMatch) {
    const key = decodeURIComponent(memMatch[1]!)
    const versions = db.prepare('SELECT * FROM memory WHERE key = ? ORDER BY version DESC').all(key) as any[]
    return json(res, versions.map((m: any) => ({
      key: m.key,
      value: m.value,
      summary: m.summary,
      type: m.type,
      pinned: !!m.pinned,
      related: JSON.parse(m.related || '[]'),
      version: m.version,
      deleted: !!m.deleted,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    })))
  }

  // GET /api/ticks
  if (path === '/api/ticks') {
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10)
    const ticks = db.prepare('SELECT * FROM ticks ORDER BY tick_number DESC LIMIT ?').all(limit) as any[]
    return json(res, ticks.map((t: any) => ({
      id: t.id,
      tickNumber: t.tick_number,
      triggeredBy: JSON.parse(t.triggered_by),
      startedAt: t.started_at,
      durationMs: t.duration_ms,
      status: t.status,
      inputTokens: t.input_tokens,
      outputTokens: t.output_tokens,
      actions: t.actions_executed,
      memoryOps: t.memory_ops_executed,
      error: t.error,
    })))
  }

  // GET /api/inbox
  if (path === '/api/inbox') {
    const limit = parseInt(url.searchParams.get('limit') ?? '30', 10)
    const items = db.prepare('SELECT * FROM inbox ORDER BY timestamp DESC LIMIT ?').all(limit) as any[]
    return json(res, items.map((i: any) => ({
      id: i.id,
      sourceId: i.source_id,
      channel: i.channel,
      from: { name: i.from_name, handle: i.from_handle },
      subject: i.subject,
      body: i.body,
      attachments: JSON.parse(i.attachments || '[]'),
      timestamp: i.timestamp,
      priority: i.priority,
      type: i.type,
      read: !!i.read,
    })))
  }

  // GET /api/outbox
  if (path === '/api/outbox') {
    const limit = parseInt(url.searchParams.get('limit') ?? '30', 10)
    const items = db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?').all(limit) as any[]
    return json(res, items.map((o: any) => ({
      id: o.id,
      channel: o.channel,
      to: o.to,
      content: o.content,
      attachments: JSON.parse(o.attachments || '[]'),
      status: o.status,
      createdAt: o.created_at,
      sentAt: o.sent_at,
      error: o.error,
    })))
  }

  // GET /api/calls
  if (path === '/api/calls') {
    try {
      const calls = db.prepare('SELECT * FROM calls ORDER BY started_at DESC LIMIT 20').all() as any[]
      const result = calls.map((c: any) => {
        const segments = db.prepare('SELECT * FROM call_segments WHERE call_id = ? ORDER BY segment_index ASC').all(c.call_id) as any[]
        return {
          callId: c.call_id,
          startedAt: c.started_at,
          endedAt: c.ended_at,
          tabTitle: c.tab_title,
          tabUrl: c.tab_url,
          status: c.status,
          totalSegments: c.total_segments,
          durationSec: c.total_duration_sec,
          segments: segments.map((s: any) => ({
            index: s.segment_index,
            transcript: s.transcript,
            createdAt: s.created_at,
          })),
        }
      })
      return json(res, result)
    } catch {
      return json(res, [])
    }
  }

  // GET /api/prompt
  if (path === '/api/prompt') {
    const memories = getMemories(db)
    const pinned = memories.filter((m: any) => m.pinned)
    const scratchpad = safeGet(db, 'scratchpad')
    const unread = db.prepare('SELECT * FROM inbox WHERE read = 0 ORDER BY timestamp DESC LIMIT 10').all() as any[]

    return json(res, {
      systemPrompt,
      memoryIndex: memories.map((m: any) => ({ key: m.key, summary: m.summary, pinned: !!m.pinned, type: m.type })),
      hotMemory: pinned.map((m: any) => ({ key: m.key, value: m.value, type: m.type, version: m.version })),
      inbox: unread.map((i: any) => ({ channel: i.channel, from: i.from_name, body: i.body?.slice(0, 500) })),
      scratchpad,
    })
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unknown API endpoint' }))
}

/**
 * SSE endpoint that streams journalctl output for the agent service.
 * Clients connect to /logs and receive live log lines as server-sent events.
 */
function handleLogStream(agentName: string, res: any) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const serviceName = agentName.toLowerCase()
  const proc = spawn('journalctl', ['-u', serviceName, '-f', '-n', '100', '--output=cat', '--no-pager'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  proc.stdout.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      // Strip ANSI codes for the web
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '')
      res.write(`data: ${JSON.stringify(clean)}\n\n`)
    }
  })

  res.on('close', () => {
    proc.kill()
  })
}

function getMemories(db: Database.Database): any[] {
  return db.prepare(`
    SELECT m.* FROM memory m
    INNER JOIN (SELECT key, MAX(version) as mv FROM memory GROUP BY key) latest
    ON m.key = latest.key AND m.version = latest.mv
    WHERE m.deleted = 0 ORDER BY m.key
  `).all()
}

function safeGet(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM agent_state WHERE key = ?').get(key) as any
    return row?.value ?? null
  } catch { return null }
}

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

main()
