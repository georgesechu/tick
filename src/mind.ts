import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

// --- ANSI ---
const ESC = '\x1b'
const CLEAR = `${ESC}[2J${ESC}[H`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const UNDERLINE = `${ESC}[4m`
const RESET = `${ESC}[0m`
const CYAN = `${ESC}[36m`
const GREEN = `${ESC}[32m`
const YELLOW = `${ESC}[33m`
const RED = `${ESC}[31m`
const MAGENTA = `${ESC}[35m`
const BLUE = `${ESC}[34m`
const GRAY = `${ESC}[90m`
const WHITE = `${ESC}[97m`

const STATUS_ICON: Record<string, string> = {
  idle: `${GREEN}● idle${RESET}`,
  working: `${YELLOW}◆ working${RESET}`,
  blocked: `${RED}■ blocked${RESET}`,
  done: `${CYAN}✓ done${RESET}`,
}

const TYPE_COLOR: Record<string, string> = {
  fact: GREEN, state: CYAN, plan: YELLOW,
  preference: MAGENTA, rule: RED, log: GRAY, relationship: BLUE,
}

const NS_ICON: Record<string, string> = {
  self: '🤖', user: '👤', project: '📁', task: '📋',
  state: '⚙️', thread: '💬', topic: '🏷️', channel: '📡',
  log: '📝', inbox: '📥',
}

type View = 'overview' | 'memory' | 'prompt' | 'activity'

function main() {
  const args = process.argv.slice(2)
  const agentDir = resolve(args.find((_, i, a) => a[i - 1] === '--agent') ?? 'agents/slack-agent')
  const dbPath = resolve(args.find((_, i, a) => a[i - 1] === '--db') ?? `${agentDir}/tick.db`)

  let agentName = 'unknown', agentModel = ''
  try {
    const yaml = readFileSync(resolve(agentDir, 'agent.yaml'), 'utf-8')
    agentName = yaml.match(/name:\s*(.+)/)?.[1]?.trim() ?? 'unknown'
    agentModel = yaml.match(/model:\s*(.+)/)?.[1]?.trim() ?? ''
  } catch { /* */ }

  let systemPrompt = ''
  try {
    const yaml = readFileSync(resolve(agentDir, 'agent.yaml'), 'utf-8')
    const promptFile = yaml.match(/systemPromptFile:\s*(.+)/)?.[1]?.trim() ?? 'system-prompt.md'
    systemPrompt = readFileSync(resolve(agentDir, promptFile), 'utf-8')
  } catch { /* */ }

  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    console.error(`Cannot open ${dbPath}`)
    process.exit(1)
  }

  let currentView: View = 'overview'

  process.stdout.write(HIDE_CURSOR)
  const quit = () => { process.stdout.write(SHOW_CURSOR + '\n'); db.close(); process.exit(0) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)

  const render = () => {
    try {
      let output: string
      switch (currentView) {
        case 'overview': output = viewOverview(db, agentName, agentModel); break
        case 'memory': output = viewMemory(db); break
        case 'prompt': output = viewPrompt(db, systemPrompt, agentName); break
        case 'activity': output = viewActivity(db); break
      }
      process.stdout.write(CLEAR + output)
    } catch { /* DB locked */ }
  }

  render()
  const interval = setInterval(render, 2000)

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (key) => {
      const k = key.toString()
      if (k === 'q' || k === '\x03') { clearInterval(interval); quit() }
      if (k === 'r') render()
      if (k === '1') { currentView = 'overview'; render() }
      if (k === '2') { currentView = 'memory'; render() }
      if (k === '3') { currentView = 'activity'; render() }
      if (k === '4') { currentView = 'prompt'; render() }
    })
  }
}

// ── OVERVIEW VIEW ──

function viewOverview(db: Database.Database, agentName: string, model: string): string {
  const w = process.stdout.columns || 80
  const lines: string[] = []

  const lastTick = db.prepare('SELECT * FROM ticks ORDER BY tick_number DESC LIMIT 1').get() as any
  const totalTicks = (db.prepare('SELECT COUNT(*) as c FROM ticks').get() as any).c
  const status = lastTick ? (STATUS_ICON[lastTick.status] ?? lastTick.status) : `${DIM}no ticks${RESET}`
  const tickInfo = lastTick ? `tick #${lastTick.tick_number} · ${timeSince(lastTick.started_at)} ago` : ''

  // Agent state
  const scratchpad = safeGet(db, 'scratchpad')
  const lastStatus = safeGet(db, 'lastStatus')

  lines.push(header(w, agentName, model, status, tickInfo, totalTicks, lastTick))
  lines.push('')

  // Scratchpad
  if (scratchpad) {
    lines.push(`  ${BOLD}📝 Scratchpad${RESET}`)
    for (const line of scratchpad.split('\n').slice(0, 6)) {
      lines.push(`    ${CYAN}${truncate(line, w - 6)}${RESET}`)
    }
    lines.push('')
  }

  // Memory summary by namespace
  const memories = getMemories(db)
  const groups = groupByNs(memories)

  lines.push(`  ${BOLD}📋 Memory${RESET} ${DIM}(${memories.length} keys · ${memories.filter(m => m.pinned).length} pinned)${RESET}`)
  lines.push('')
  for (const [ns, entries] of groups) {
    const icon = NS_ICON[ns] ?? '📦'
    lines.push(`  ${icon} ${BOLD}${ns}${RESET} ${DIM}(${entries.length})${RESET}`)
    for (const m of entries) {
      const pin = m.pinned ? ' 📌' : ''
      const color = TYPE_COLOR[m.type] ?? GRAY
      const shortKey = m.key.slice(ns.length + 1) || m.key
      lines.push(`    ${color}${shortKey.padEnd(28)}${RESET} ${DIM}v${m.version} · ${m.type} · ${timeSince(m.updated_at)}${RESET}${pin}`)
      lines.push(`    ${DIM}${truncate(m.summary, w - 8)}${RESET}`)
    }
    lines.push('')
  }

  // Stats
  const unread = (db.prepare('SELECT COUNT(*) as c FROM inbox WHERE read = 0').get() as any).c
  const totalInbox = (db.prepare('SELECT COUNT(*) as c FROM inbox').get() as any).c
  const pendingOut = (db.prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'pending'").get() as any).c
  const sentOut = (db.prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'sent'").get() as any).c
  const tokenStats = db.prepare('SELECT SUM(input_tokens) as i, SUM(output_tokens) as o FROM ticks').get() as any

  lines.push(`  ${BOLD}📊 Stats${RESET}`)
  lines.push(`    📥 ${unread > 0 ? YELLOW : GREEN}${unread} unread${RESET} ${DIM}/ ${totalInbox} total${RESET}    📤 ${pendingOut > 0 ? YELLOW : GREEN}${pendingOut} pending${RESET} ${DIM}/ ${sentOut} sent${RESET}`)
  if (tokenStats.i) {
    lines.push(`    🔤 ${DIM}${(tokenStats.i / 1000).toFixed(1)}K in · ${(tokenStats.o / 1000).toFixed(1)}K out · ${((tokenStats.i + tokenStats.o) / 1000).toFixed(1)}K total${RESET}`)
  }
  lines.push('')

  lines.push(footer(w, currentView()))
  return lines.join('\n') + '\n'

  function currentView() { return 'overview' as View }
}

// ── MEMORY VIEW ──

function viewMemory(db: Database.Database): string {
  const w = process.stdout.columns || 80
  const lines: string[] = []

  lines.push(`${DIM}${'─'.repeat(w)}${RESET}`)
  lines.push(`  ${BOLD}🧠 Memory — Full Detail${RESET}`)
  lines.push(`${DIM}${'─'.repeat(w)}${RESET}`)
  lines.push('')

  const memories = getMemories(db)
  const groups = groupByNs(memories)

  for (const [ns, entries] of groups) {
    const icon = NS_ICON[ns] ?? '📦'
    lines.push(`  ${icon} ${BOLD}${UNDERLINE}${ns}${RESET}`)
    lines.push('')

    for (const m of entries) {
      const pin = m.pinned ? '📌 ' : ''
      const color = TYPE_COLOR[m.type] ?? GRAY
      lines.push(`  ${pin}${WHITE}${m.key}${RESET}  ${color}${m.type}${RESET}  ${DIM}v${m.version} · ${timeSince(m.updated_at)} · ${m.access_count} reads${RESET}`)
      lines.push(`  ${DIM}summary: ${m.summary}${RESET}`)

      // Show full value with wrapping
      const valLines = m.value.split('\n')
      const maxLines = 8
      for (const vl of valLines.slice(0, maxLines)) {
        lines.push(`  ${CYAN}${truncate(vl, w - 4)}${RESET}`)
      }
      if (valLines.length > maxLines) {
        lines.push(`  ${DIM}... (${valLines.length - maxLines} more lines)${RESET}`)
      }
      lines.push('')
    }
  }

  if (memories.length === 0) {
    lines.push(`  ${DIM}(no memories stored yet)${RESET}`)
    lines.push('')
  }

  lines.push(footer(w, 'memory'))
  return lines.join('\n') + '\n'
}

// ── ACTIVITY VIEW ──

function viewActivity(db: Database.Database): string {
  const w = process.stdout.columns || 80
  const lines: string[] = []

  lines.push(`${DIM}${'─'.repeat(w)}${RESET}`)
  lines.push(`  ${BOLD}⚡ Activity — Unified Timeline${RESET}`)
  lines.push(`${DIM}${'─'.repeat(w)}${RESET}`)
  lines.push('')

  const activity: { time: string; lines: string[] }[] = []

  // Ticks
  const ticks = db.prepare('SELECT * FROM ticks ORDER BY tick_number DESC LIMIT 20').all() as any[]
  for (const t of ticks) {
    const s = STATUS_ICON[t.status] ?? t.status
    const err = t.error ? `\n    ${RED}${truncate(t.error, w - 8)}${RESET}` : ''
    activity.push({
      time: t.started_at,
      lines: [`  ⚡ ${s} ${DIM}#${t.tick_number} · ${t.duration_ms}ms · ${t.input_tokens}→${t.output_tokens} tok · ${t.actions_executed} actions · ${t.memory_ops_executed} mem${RESET}${err}`],
    })
  }

  // Inbox
  const recentInbox = db.prepare('SELECT * FROM inbox ORDER BY timestamp DESC LIMIT 15').all() as any[]
  for (const item of recentInbox) {
    const read = item.read ? `${GREEN}✓${RESET}` : `${YELLOW}●${RESET}`
    const attachments = JSON.parse(item.attachments || '[]')
    const attLine = attachments.length > 0 ? `\n    ${DIM}📎 ${attachments.length} attachment(s)${RESET}` : ''
    activity.push({
      time: item.timestamp,
      lines: [`  📩 ${read} ${WHITE}${item.from_name}${RESET} ${DIM}(${item.channel})${RESET}\n    ${truncate(item.body, w - 6)}${attLine}`],
    })
  }

  // Outbox
  const recentOutbox = db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 15').all() as any[]
  for (const item of recentOutbox) {
    const icon = item.status === 'sent' ? `${GREEN}✓ sent${RESET}` : item.status === 'failed' ? `${RED}✗ failed${RESET}` : `${YELLOW}● pending${RESET}`
    const attachments = JSON.parse(item.attachments || '[]')
    const attLine = attachments.length > 0 ? `\n    ${DIM}📎 ${attachments.map((a: string) => a.split('/').pop()).join(', ')}${RESET}` : ''
    const errLine = item.error ? `\n    ${RED}${truncate(item.error, w - 8)}${RESET}` : ''
    activity.push({
      time: item.created_at,
      lines: [`  📤 ${icon} → ${item.to} ${DIM}(${item.channel})${RESET}\n    ${truncate(item.content, w - 6)}${attLine}${errLine}`],
    })
  }

  activity.sort((a, b) => b.time.localeCompare(a.time))

  for (const a of activity.slice(0, 25)) {
    const age = timeSince(a.time).padStart(5)
    lines.push(`${DIM}${age}${RESET}${a.lines.join('\n')}`)
    lines.push('')
  }

  lines.push(footer(w, 'activity'))
  return lines.join('\n') + '\n'
}

// ── PROMPT VIEW ──

function viewPrompt(db: Database.Database, systemPrompt: string, agentName: string): string {
  const w = process.stdout.columns || 80
  const lines: string[] = []

  lines.push(`${DIM}${'─'.repeat(w)}${RESET}`)
  lines.push(`  ${BOLD}📜 Last Prompt — What the LLM Sees${RESET}`)
  lines.push(`${DIM}${'─'.repeat(w)}${RESET}`)
  lines.push('')

  // Reconstruct what the context assembler would produce
  const scratchpad = safeGet(db, 'scratchpad')

  // System prompt
  lines.push(`  ${BOLD}${YELLOW}── SYSTEM ──${RESET}`)
  for (const line of systemPrompt.split('\n').slice(0, 15)) {
    lines.push(`  ${DIM}${truncate(line, w - 4)}${RESET}`)
  }
  if (systemPrompt.split('\n').length > 15) {
    lines.push(`  ${DIM}... (${systemPrompt.split('\n').length - 15} more lines)${RESET}`)
  }
  lines.push('')

  // Memory index
  const memories = getMemories(db)
  lines.push(`  ${BOLD}${CYAN}── MEMORY INDEX (${memories.length} keys) ──${RESET}`)
  for (const m of memories) {
    const pin = m.pinned ? ' 📌' : ''
    lines.push(`  ${DIM}${m.key.padEnd(30)} ${m.summary.slice(0, w - 36)}${pin}${RESET}`)
  }
  lines.push('')

  // Hot memory (pinned)
  const pinned = memories.filter(m => m.pinned)
  if (pinned.length > 0) {
    lines.push(`  ${BOLD}${MAGENTA}── HOT MEMORY (${pinned.length} pinned) ──${RESET}`)
    for (const m of pinned) {
      lines.push(`  ${DIM}[${m.key}] (v${m.version}, ${m.type})${RESET}`)
      for (const vl of m.value.split('\n').slice(0, 3)) {
        lines.push(`  ${DIM}${truncate(vl, w - 4)}${RESET}`)
      }
    }
    lines.push('')
  }

  // Inbox unread
  const unread = db.prepare('SELECT * FROM inbox WHERE read = 0 ORDER BY timestamp DESC LIMIT 5').all() as any[]
  if (unread.length > 0) {
    lines.push(`  ${BOLD}${GREEN}── INBOX (${unread.length} unread) ──${RESET}`)
    for (const item of unread) {
      lines.push(`  ${DIM}📩 ${item.channel} from ${item.from_name}: ${truncate(item.body, w - 30)}${RESET}`)
    }
    lines.push('')
  }

  // Scratchpad
  if (scratchpad) {
    lines.push(`  ${BOLD}${BLUE}── SCRATCHPAD ──${RESET}`)
    for (const line of scratchpad.split('\n')) {
      lines.push(`  ${DIM}${truncate(line, w - 4)}${RESET}`)
    }
    lines.push('')
  }

  // Last tick stats
  const lastTick = db.prepare('SELECT * FROM ticks ORDER BY tick_number DESC LIMIT 1').get() as any
  if (lastTick) {
    lines.push(`  ${BOLD}${GRAY}── LAST TICK ──${RESET}`)
    lines.push(`  ${DIM}#${lastTick.tick_number} · ${lastTick.status} · ${lastTick.input_tokens} input tokens · ${lastTick.output_tokens} output tokens · ${lastTick.duration_ms}ms${RESET}`)
  }
  lines.push('')

  lines.push(footer(w, 'prompt'))
  return lines.join('\n') + '\n'
}

// ── HELPERS ──

function header(w: number, name: string, model: string, status: string, tickInfo: string, total: number, lastTick: any): string {
  const lines = [
    `${DIM}${'─'.repeat(w)}${RESET}`,
    `  🧠 ${BOLD}${WHITE}${name}${RESET}  ${status}  ${DIM}${tickInfo}${RESET}`,
    `  ${DIM}${model} · ${total} ticks${lastTick ? ` · last: ${lastTick.duration_ms}ms · ${lastTick.input_tokens}→${lastTick.output_tokens} tok` : ''}${RESET}`,
    `${DIM}${'─'.repeat(w)}${RESET}`,
  ]
  return lines.join('\n')
}

function footer(w: number, view: View): string {
  const views = [
    { key: '1', name: 'overview', v: 'overview' as View },
    { key: '2', name: 'memory', v: 'memory' as View },
    { key: '3', name: 'activity', v: 'activity' as View },
    { key: '4', name: 'prompt', v: 'prompt' as View },
  ]
  const tabs = views.map(v =>
    v.v === view
      ? `${BOLD}${CYAN}[${v.key}] ${v.name}${RESET}`
      : `${DIM}[${v.key}] ${v.name}${RESET}`
  ).join('  ')

  return `${DIM}${'─'.repeat(w)}${RESET}\n  ${tabs}  ${DIM}q=quit  r=refresh${RESET}`
}

function getMemories(db: Database.Database): any[] {
  return db.prepare(`
    SELECT m.* FROM memory m
    INNER JOIN (SELECT key, MAX(version) as mv FROM memory GROUP BY key) latest
    ON m.key = latest.key AND m.version = latest.mv
    WHERE m.deleted = 0 ORDER BY m.key
  `).all() as any[]
}

function groupByNs(memories: any[]): Map<string, any[]> {
  const groups = new Map<string, any[]>()
  for (const m of memories) {
    const ns = m.key.split(':')[0] ?? 'other'
    const list = groups.get(ns) ?? []
    list.push(m)
    groups.set(ns, list)
  }
  return groups
}

function safeGet(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM agent_state WHERE key = ?').get(key) as any
    return row?.value ?? null
  } catch { return null }
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\n/g, ' ').trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max - 1) + '…'
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0 || ms < 1000) return 'now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h`
  return `${Math.floor(ms / 86400_000)}d`
}

main()
