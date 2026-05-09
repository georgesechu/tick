import type { ContextAssembler, AssemblyInput } from '../core/interfaces.js'
import type { LLMMessage, MemoryIndexEntry, MemoryEntry, MemoryOpResult, ShellResult, DownloadResult, BrowseResult, GrepResult, GlobResult, TerminalInfo, BackgroundProcess, OutboxItem } from '../core/types.js'
import type { ActiveCallContext } from '../providers/call/types.js'
import type { ActionHistoryEntry } from './orchestrator.js'

export class DefaultContextAssembler implements ContextAssembler {
  async assemble(input: AssemblyInput): Promise<LLMMessage[]> {
    const system = [input.systemPrompt, OUTPUT_FORMAT].join('\n\n')

    const sections: string[] = []

    // Time
    sections.push(renderTime(input))

    // Memory index
    sections.push(renderMemoryIndex(input.memoryIndex))

    // Hot memory (pinned + requested)
    const hot = [...input.pinnedMemories, ...input.requestedMemories]
    if (hot.length > 0) {
      sections.push(renderHotMemory(hot))
    }

    // Action history (what you did in recent ticks — prevents repeating yourself)
    if (input.actionHistory.length > 0) {
      sections.push(renderActionHistory(input.actionHistory))
    }

    // Last tick results
    const hasResults = input.lastActionResults.length > 0 || input.lastShellResults.length > 0 ||
      input.lastDownloadResults.length > 0 || input.lastBrowseResults.length > 0 ||
      input.lastGrepResults.length > 0 || input.lastGlobResults.length > 0
    if (hasResults) {
      sections.push(renderLastResults(input.lastActionResults, input.lastShellResults, input.lastDownloadResults, input.lastBrowseResults, input.lastGrepResults, input.lastGlobResults))
    }

    // Terminals
    if (input.terminals.length > 0 || input.backgroundProcesses.length > 0) {
      sections.push(renderTerminals(input.terminals, input.backgroundProcesses))
    }

    // Active call
    if (input.activeCall) {
      sections.push(renderActiveCall(input.activeCall))
    }

    // Inbox
    if (input.inbox.length > 0) {
      sections.push(renderInbox(input))
    }

    // Recently sent (prevents duplicate messages)
    if (input.recentlySent.length > 0) {
      sections.push(renderRecentlySent(input.recentlySent))
    }

    // Scratchpad
    if (input.lastScratchpad) {
      sections.push(`═══ SCRATCHPAD (your notes from last cycle) ═══\n${input.lastScratchpad}\n═══════════════════════════════════════`)
    }

    sections.push('Go.')

    return [
      { role: 'system', content: system },
      { role: 'user', content: sections.join('\n\n') },
    ]
  }
}

function renderTime(input: AssemblyInput): string {
  const t = input.time
  const lines = [
    `═══ TIME ═══`,
    `now:              ${t.now}`,
    `user_tz:          ${t.userTimezone}`,
  ]
  if (t.lastTickAt) lines.push(`last_active:      ${t.lastTickAt} (${t.timeSinceLastTick} ago)`)
  if (t.taskElapsed) lines.push(`task_elapsed:     ${t.taskElapsed}`)
  lines.push(`cycles_used:      ${t.tickBudget.used}/${t.tickBudget.limit} (${t.tickBudget.period})`)

  if (t.upcoming.length > 0) {
    lines.push('', 'UPCOMING:')
    for (const c of t.upcoming) {
      lines.push(`  ⏰ ${c.dueBy} — ${c.description}`)
    }
  }
  if (t.overdue.length > 0) {
    lines.push('', 'OVERDUE:')
    for (const c of t.overdue) {
      lines.push(`  ⚠️ "${c.description}" — due ${c.dueBy}`)
    }
  }
  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function renderMemoryIndex(index: MemoryIndexEntry[]): string {
  if (index.length === 0) {
    return '═══ MEMORY INDEX ═══\n(empty — no memories stored yet)\n═══════════════════════════════════════'
  }

  const lines = ['═══ MEMORY INDEX ═══']
  const keyWidth = Math.max(20, ...index.map(e => e.key.length))

  for (const entry of index) {
    const pin = entry.pinned ? ' 📌' : ''
    const links = entry.related.length > 0 ? ` → ${entry.related.join(', ')}` : ''
    lines.push(`  ${entry.key.padEnd(keyWidth)}  ${entry.summary}${pin}${links}`)
  }

  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function renderHotMemory(entries: MemoryEntry[]): string {
  const seen = new Set<string>()
  const lines = ['═══ HOT MEMORY ═══']

  for (const entry of entries) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    lines.push(`[${entry.key}] (v${entry.version}, ${entry.type})`)
    lines.push(entry.value)
    lines.push('')
  }

  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function renderActionHistory(history: ActionHistoryEntry[]): string {
  const lines = ['═══ RECENT ACTIONS (your work in previous ticks) ═══']

  for (const entry of history) {
    const statusTag = entry.status === 'working' ? 'working' :
                      entry.status === 'idle' ? 'idle' : entry.status
    lines.push(`  tick #${entry.tickNumber} [${statusTag}]:`)

    for (const action of entry.actions) {
      lines.push(`    ${action.type}: ${action.summary}`)
    }

    if (entry.memoryOps.length > 0) {
      lines.push(`    memory: ${entry.memoryOps.map(m => `${m.op}("${m.key}")`).join(', ')}`)
    }

    if (entry.actions.length === 0 && entry.memoryOps.length === 0) {
      lines.push(`    (no actions)`)
    }
  }

  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function renderLastResults(memResults: MemoryOpResult[], shellResults: ShellResult[], downloadResults: DownloadResult[] = [], browseResults: BrowseResult[] = [], grepResults: GrepResult[] = [], globResults: GlobResult[] = []): string {
  const lines = ['═══ LAST TICK RESULTS ═══']

  for (const r of memResults) {
    if (r.op === 'get' && r.data && !Array.isArray(r.data)) {
      lines.push(`memory.get("${r.key}"): ${r.data.value}`)
    } else if (r.op === 'list' && Array.isArray(r.data)) {
      lines.push(`memory.list: ${r.data.map(e => e.key).join(', ')}`)
    } else if (r.op === 'search' && Array.isArray(r.data)) {
      lines.push(`memory.search: ${r.data.map(e => e.key).join(', ')}`)
    } else if (!r.success) {
      lines.push(`memory.${r.op}("${r.key ?? ''}"): ERROR — ${r.error}`)
    }
  }

  for (const r of shellResults) {
    const status = r.exitCode === 0 ? 'OK' : `exit:${r.exitCode}`
    lines.push(`shell [${r.id}] ${status} (${r.durationMs}ms)`)
    if (r.stdout) lines.push(r.stdout)
    if (r.stderr) lines.push(`STDERR: ${r.stderr}`)
  }

  for (const r of downloadResults) {
    if (r.success) {
      lines.push(`📥 download OK: ${r.path} (${r.size} bytes)`)
    } else {
      lines.push(`📥 download FAILED: ${r.ref} → ${r.error}`)
    }
  }

  for (const r of browseResults) {
    if (r.success) {
      lines.push(`🌐 browse "${r.title}" (${r.url})`)
      lines.push(r.content)
    } else {
      lines.push(`🌐 browse FAILED: ${r.url} → ${r.error}`)
    }
  }

  for (const r of grepResults) {
    if (r.error) {
      lines.push(`🔍 grep "${r.pattern}": ERROR — ${r.error}`)
    } else {
      lines.push(`🔍 grep "${r.pattern}": ${r.totalMatches} match${r.totalMatches !== 1 ? 'es' : ''}${r.truncated ? ' (truncated)' : ''}`)
      for (const m of r.matches) {
        lines.push(`  ${m.file}:${m.line}: ${m.text}`)
      }
    }
  }

  for (const r of globResults) {
    if (r.error) {
      lines.push(`📂 glob "${r.pattern}": ERROR — ${r.error}`)
    } else {
      lines.push(`📂 glob "${r.pattern}": ${r.totalFiles} file${r.totalFiles !== 1 ? 's' : ''}${r.truncated ? ' (truncated)' : ''}`)
      for (const f of r.files) {
        lines.push(`  ${f}`)
      }
    }
  }

  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function renderTerminals(terminals: TerminalInfo[], background: BackgroundProcess[]): string {
  const lines = ['═══ TERMINALS ═══']

  // Group terminals by computer
  const byComputer = new Map<string, TerminalInfo[]>()
  for (const t of terminals) {
    const list = byComputer.get(t.computer) ?? []
    list.push(t)
    byComputer.set(t.computer, list)
  }

  for (const [computer, terms] of byComputer) {
    lines.push(`  🖥 ${computer}`)
    for (const t of terms) {
      lines.push(`    └─ ${t.name.padEnd(16)} ${t.cwd.padEnd(30)} ${t.commandCount} cmds`)
    }
  }

  // Background processes
  const running = background.filter(p => p.status === 'running')
  const completed = background.filter(p => p.status !== 'running')

  if (running.length > 0) {
    lines.push('', '  ⚙️  RUNNING:')
    for (const p of running) {
      lines.push(`    [${p.id}] ${p.computer}/${p.terminal}: ${p.label ?? p.command}`)
    }
  }

  if (completed.length > 0) {
    lines.push('', '  ✅ COMPLETED:')
    for (const p of completed) {
      const status = p.result ? `exit:${p.result.exitCode}` : p.status
      lines.push(`    [${p.id}] ${p.computer}/${p.terminal}: ${p.label ?? p.command} → ${status}`)
    }
  }

  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function renderActiveCall(call: ActiveCallContext): string {
  const mins = Math.floor(call.elapsedSec / 60)
  const secs = call.elapsedSec % 60
  const elapsed = `${mins}m ${String(secs).padStart(2, '0')}s`

  const lines = [
    '═══ ACTIVE CALL ═══',
    `  George is on a live call — ${elapsed}`,
    `  Tab: "${call.tabTitle}"`,
  ]
  if (call.tabUrl) {
    lines.push(`  URL: ${call.tabUrl}`)
  }
  lines.push(`  Segments transcribed: ${call.totalSegments}`)

  if (call.latestTranscript) {
    lines.push('')
    lines.push('  LATEST TRANSCRIPT (last ~60s):')
    // Indent each line of transcript
    for (const line of call.latestTranscript.split('\n')) {
      lines.push(`    ${line}`)
    }
  }

  lines.push('')
  lines.push('  You can contribute to this call by sending messages via Slack.')
  lines.push('  Use memory search "call:" to query earlier segments.')
  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function renderInbox(input: AssemblyInput): string {
  const lines = ['═══ INBOX ═══']
  for (const item of input.inbox) {
    const from = item.from.name || item.from.channelHandle
    // Extract the channel/conversation ID for reply routing
    const replyTo = extractReplyChannel(item)
    const replyHint = replyTo ? ` [REPLY TO: ${replyTo}]` : ''
    const threadHint = item.threadId ? ` (thread: ${item.threadId})` : ''
    lines.push(`  📩 ${item.channel} from ${from}:${replyHint}${threadHint} ${item.body.slice(0, 200)}`)
    if (item.attachments.length > 0) {
      for (const att of item.attachments) {
        lines.push(`    📎 ${att.name} (${att.mimeType}, ${att.size} bytes) ref: ${att.ref}`)
      }
    }
  }
  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function renderRecentlySent(items: OutboxItem[]): string {
  const lines = ['═══ RECENTLY SENT (do not repeat these) ═══']
  for (const item of items) {
    const ago = timeSince(item.createdAt)
    const status = item.status === 'sent' ? '✓' : item.status === 'failed' ? '✗' : '●'
    lines.push(`  ${status} → ${item.to} (${item.channel}) ${ago} ago: ${item.content.slice(0, 150)}`)
    if (item.attachments.length > 0) {
      lines.push(`    📎 ${item.attachments.length} file(s): ${item.attachments.join(', ')}`)
    }
  }
  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3600_000)}h`
}

/** Extract the channel/conversation ID from an inbox item's sourceId for reply routing */
function extractReplyChannel(item: { sourceId: string; channel: string }): string | null {
  // sourceId format: "slack:<channel_id>:<ts>" or "telegram:<chat_id>:<msg_id>" etc.
  const parts = item.sourceId.split(':')
  if (parts.length >= 2 && parts[1]) return parts[1]
  return null
}

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const OUTPUT_FORMAT = `## Output Format

You MUST respond with a single JSON object (no markdown, no wrapping):

{
  "status": "working" | "done" | "blocked" | "idle",
  "thinking": "your internal reasoning about the current situation",
  "actions": [
    // Shell: run commands on a computer (defaults to first computer, "default" terminal)
    { "type": "shell", "command": "...", "mode": "sync" | "background", "computer": "...", "session": "...", "label": "..." },
    // Send: message someone via a channel (with optional file attachments)
    { "type": "send", "channel": "...", "to": "...", "content": "...", "attachments": ["/path/to/file"] },
    // Browse: fetch a webpage as clean readable markdown (way better than curl)
    { "type": "browse", "url": "https://example.com", "mode": "readable" },
    // Browse screenshot: save a webpage screenshot to a file
    { "type": "browse", "url": "https://example.com", "mode": "screenshot", "saveTo": "/tmp/page.png" },
    // Grep: search file contents by regex (faster + cleaner than shell grep)
    { "type": "grep", "pattern": "function\\s+handle", "path": "src/", "include": "*.ts", "context": 2, "maxResults": 30 },
    // Glob: find files by name pattern (faster + cleaner than shell find)
    { "type": "glob", "pattern": "*.test.ts", "path": "src/", "fileType": "file", "maxResults": 50 },
    // Download: save an inbox attachment to a local file
    { "type": "download", "ref": "attachment-ref-from-inbox", "path": "/path/to/save" },
    // Wait: control when you're next invoked
    { "type": "wait", "until": "on_event" | { "after": "5m" } | { "at": "2024-01-01T00:00:00Z" } }
  ],
  "memoryOps": [
    { "op": "set", "key": "entity:id:aspect", "value": "...", "summary": "one-line summary", "type": "fact|state|plan|preference|rule|log|relationship", "pinned": false, "related": ["other:key"] },
    { "op": "get", "key": "..." },
    { "op": "delete", "key": "..." },
    { "op": "append", "key": "...", "value": "..." },
    { "op": "list", "prefix": "..." },
    { "op": "search", "query": "...", "limit": 10 },
    { "op": "pin", "key": "..." },
    { "op": "unpin", "key": "..." },
    { "op": "history", "key": "..." },
    { "op": "rollback", "key": "...", "toVersion": 1 }
  ],
  "scratchpad": "Notes for your future self about what you're doing and what to do next"
}

### Memory is your brain
You have AMNESIA between invocations. Everything you don't store is GONE.
- Recent conversation is auto-saved in thread:recent (pinned, always visible)
- YOU must store facts, learnings, preferences, and task state explicitly
- When you learn something → store it. When a user tells you something → store it
- Values should be compressed facts, not verbose logs. Think: knowledge base, not diary
- Use "related" to link memories: e.g. a task can reference the user who requested it

### Memory Key Conventions
  entity:id:aspect — e.g. self:identity, user:george:prefs, project:atlas:status, task:current

### Memory Types
  fact = something true about the world | state = current status of something
  plan = steps to achieve a goal | preference = how someone likes things
  rule = behavioral constraint | log = chronological record | relationship = connection between entities

### Rules
- Always set a scratchpad — your future self has no prior memory
- Memory index shows all your stored keys — use "get" to load values you need
- Use "set" with a clear summary — the summary appears in your index every cycle
- Status "working" = you'll be immediately invoked again to continue. "idle" = wait for new messages
- If nothing to do, return status "idle" with an empty actions array
- NEVER mention your internal workings to the user — no "ticks", "cycles", "memory ops", "scratchpad". Just be helpful.`
