import type { ContextAssembler, AssemblyInput } from '../core/interfaces.js'
import type { LLMMessage, MemoryIndexEntry, MemoryEntry, MemoryOpResult, ShellResult, DownloadResult, BrowseResult, TerminalInfo, BackgroundProcess } from '../core/types.js'

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

    // Last tick results
    if (input.lastActionResults.length > 0 || input.lastShellResults.length > 0 || input.lastDownloadResults.length > 0 || input.lastBrowseResults.length > 0) {
      sections.push(renderLastResults(input.lastActionResults, input.lastShellResults, input.lastDownloadResults, input.lastBrowseResults))
    }

    // Terminals
    if (input.terminals.length > 0 || input.backgroundProcesses.length > 0) {
      sections.push(renderTerminals(input.terminals, input.backgroundProcesses))
    }

    // Inbox
    if (input.inbox.length > 0) {
      sections.push(renderInbox(input))
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

function renderLastResults(memResults: MemoryOpResult[], shellResults: ShellResult[], downloadResults: DownloadResult[] = [], browseResults: BrowseResult[] = []): string {
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

function renderInbox(input: AssemblyInput): string {
  const lines = ['═══ INBOX ═══']
  for (const item of input.inbox) {
    const from = item.from.name || item.from.channelHandle
    lines.push(`  📩 ${item.channel} from ${from}: ${item.body.slice(0, 200)}`)
    if (item.attachments.length > 0) {
      for (const att of item.attachments) {
        lines.push(`    📎 ${att.name} (${att.mimeType}, ${att.size} bytes) ref: ${att.ref}`)
      }
    }
  }
  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

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
