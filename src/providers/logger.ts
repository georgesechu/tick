import type { Logger } from '../core/index.js'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const MAGENTA = '\x1b[35m'
const BLUE = '\x1b[34m'
const GRAY = '\x1b[90m'
const WHITE = '\x1b[97m'

// Compact icon mapping — covers all log messages from the system
const ICONS: Record<string, string> = {
  // Startup
  'loading agent':      '📦',
  'llm provider':       '🤖',
  'computer':           '🖥️ ',
  'seeded memory':      '🌱',
  'starting continuous': '🚀',

  // Channels
  'slack connected':    '💬',
  'slack:':             '💬',
  'slack event':        '💬',
  'slack raw event':    '💬',
  'whatsapp connected': '💬',
  'whatsapp:':          '💬',
  'gmail imap':         '📧',
  'gmail smtp':         '📧',
  'gmail:':             '📧',

  // Tick lifecycle
  'tick #':             '⚡',
  'tick complete':      '✅',
  'tick error':         '💥',
  'tick failed':        '💥',

  // LLM
  'llm responded':      '🧠',
  'thinking':           '💭',

  // Actions
  'shell':              '💻',
  'send enqueued':      '📤',
  'browse ok':          '🌐',
  'browse failed':      '🌐',
  'downloaded':         '📥',
  'download failed':    '📥',
  'timer set':          '⏰',
  'copied from':        '📋',
  'memory set':         '💾',
  'memory get':         '💾',
  'memory delete':      '💾',
  'memory search':      '💾',
  'memory pin':         '💾',
  'memory unpin':       '💾',
  'shell output':       '   ',
  'shell stderr':       '   ',
  'grep':               '🔍',
  'glob':               '📂',
  'display':            '🖥️ ',

  // Status
  'sleeping':           '😴',
  'shutting down':      '🛑',
  'stopped':            '🏁',
  'call server':        '📞',
  'call started':       '📞',
  'call ended':         '📞',
  'chunk received':     '📞',
  'segment transcribed':'📞',
  'call transcript':    '📞',
}

// Messages to suppress entirely in daemon mode (noise)
const DAEMON_SUPPRESS = new Set([
  'sleeping',
])

// Messages to collapse into the startup banner
const STARTUP_KEYS = new Set([
  'loading agent', 'llm provider', 'computer', 'seeded memory',
  'slack connected', 'whatsapp connected', 'gmail imap', 'gmail smtp',
  'starting continuous',
])

export class ConsoleLogger implements Logger {
  private daemon: boolean
  private spinnerInterval: ReturnType<typeof setInterval> | null = null
  private spinnerStart = 0
  private startupBuffer: string[] = []
  private startupFlushed = false
  private agentName: string

  constructor(private prefix: string = 'tick', daemon = false) {
    this.daemon = daemon
    this.agentName = prefix
  }

  startSpinner(msg: string): void {
    if (this.daemon) return
    this.spinnerStart = Date.now()
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let i = 0
    const render = () => {
      const elapsed = ((Date.now() - this.spinnerStart) / 1000).toFixed(0)
      process.stdout.write(`\r  ${MAGENTA}${frames[i % frames.length]}${RESET} ${msg} ${DIM}${elapsed}s${RESET}  `)
      i++
    }
    render()
    this.spinnerInterval = setInterval(render, 100)
  }

  stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval)
      this.spinnerInterval = null
      process.stdout.write('\r' + ' '.repeat(60) + '\r')
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', msg, data)
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('INFO', msg, data)
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('WARN', msg, data)
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('ERROR', msg, data)
  }

  private log(level: string, msg: string, data?: Record<string, unknown>): void {
    if (this.daemon) {
      this.logDaemon(level, msg, data)
    } else {
      this.logPretty(level, msg, data)
    }
  }

  // ── Daemon mode: compact, emoji-rich, journalctl-friendly ──

  private logDaemon(level: string, msg: string, data?: Record<string, unknown>): void {
    const lower = msg.toLowerCase()

    // Suppress noise
    if (DAEMON_SUPPRESS.has(lower)) return

    // Collect startup messages into a banner
    if (!this.startupFlushed) {
      for (const key of STARTUP_KEYS) {
        if (lower.startsWith(key)) {
          this.startupBuffer.push(this.formatDaemonLine(level, msg, data))
          return
        }
      }
      // First non-startup message — flush banner
      this.flushStartupBanner()
    }

    this.writeln(stripAnsi(this.formatDaemonLine(level, msg, data)))
  }

  private flushStartupBanner(): void {
    if (this.startupFlushed) return
    this.startupFlushed = true

    const channels: string[] = []
    const computers: string[] = []
    let model = ''
    let seedCount = 0

    for (const raw of this.startupBuffer) {
      const line = stripAnsi(raw)
      if (line.includes('slack')) channels.push('slack')
      if (line.includes('whatsapp')) channels.push('whatsapp')
      if (line.includes('gmail') && line.includes('IMAP')) channels.push('gmail')
      if (line.includes('computer')) computers.push('docker')
      if (line.includes('llm provider')) {
        const m = line.match(/baseUrl=(\S+)/)
        model = m ? m[1]! : ''
      }
      if (line.includes('🌱')) seedCount++
    }

    const bar = '═'.repeat(50)
    this.writeln(bar)
    this.writeln(`  🤖 ${this.agentName} is online`)
    if (model) this.writeln(`  🧠 ${model}`)
    if (channels.length) this.writeln(`  💬 ${channels.join(' · ')}`)
    if (computers.length) this.writeln(`  🖥️  ${computers.join(' · ')}`)
    if (seedCount) this.writeln(`  🌱 ${seedCount} memories seeded`)
    this.writeln(bar)
  }

  private formatDaemonLine(level: string, msg: string, data?: Record<string, unknown>): string {
    const icon = this.getIcon(msg)
    const time = formatTime(new Date())

    // Level prefix for warnings/errors
    const lvl = level === 'WARN' ? `${YELLOW}⚠${RESET} ` : level === 'ERROR' ? `${RED}✗${RESET} ` : ''

    // Format the message compactly
    let line = `${DIM}${time}${RESET} ${icon} ${lvl}${this.formatMessage(msg, data)}`

    return line
  }

  private formatMessage(msg: string, data?: Record<string, unknown>): string {
    const lower = msg.toLowerCase()

    // Special compact formats for common messages
    if (lower.startsWith('tick #') && lower.includes('starting')) {
      const n = data?.agent ? '' : ''
      return `${DIM}tick ${msg.match(/#\d+/)?.[0] ?? ''}${RESET}`
    }

    if (lower === 'tick complete' || lower.startsWith('tick #') && lower.includes('complete')) {
      const status = data?.status ?? ''
      const ms = data?.durationMs ?? ''
      const statusStr = status === 'idle' ? `${GREEN}idle${RESET}` :
                        status === 'working' ? `${YELLOW}working${RESET}` :
                        status === 'done' ? `${CYAN}done${RESET}` :
                        status === 'blocked' ? `${RED}blocked${RESET}` : String(status)
      return `${statusStr} ${DIM}${ms}ms${RESET}`
    }

    if (lower === 'llm responded') {
      const s = data?.status ?? ''
      const a = data?.actions ?? 0
      const m = data?.memoryOps ?? 0
      const tok = data?.tokens as any
      const statusStr = s === 'idle' ? `${GREEN}idle${RESET}` :
                        s === 'working' ? `${YELLOW}working${RESET}` :
                        s === 'done' ? `${CYAN}done${RESET}` : String(s)
      const parts = [statusStr]
      if (a) parts.push(`${a} actions`)
      if (m) parts.push(`${m} mem`)
      if (tok) parts.push(`${DIM}${tok.in}→${tok.out} tok${RESET}`)
      return parts.join('  ')
    }

    if (lower.startsWith('thinking')) {
      const thought = data?.thinking as string ?? ''
      return `${DIM}${thought.slice(0, 80)}${thought.length > 80 ? '…' : ''}${RESET}`
    }

    if (lower.includes('shell [')) {
      const cmd = (data?.command as string ?? '').slice(0, 50)
      const exit = msg.match(/exit:(\d+)/)?.[1] ?? '?'
      const ok = exit === '0' ? `${GREEN}✓${RESET}` : `${RED}✗${exit}${RESET}`
      return `${ok} ${DIM}${cmd}${cmd.length > 50 ? '…' : ''}${RESET}`
    }

    if (lower === 'shell output') {
      const out = data?.stdout as string ?? ''
      return out
    }

    if (lower === 'shell stderr') {
      return `${RED}${data?.stderr ?? ''}${RESET}`
    }

    if (lower === 'send enqueued') {
      const ch = data?.channel ?? ''
      const to = data?.to ?? ''
      const files = data?.files as number ?? 0
      return `→ ${ch}${files ? ` 📎${files}` : ''} ${DIM}${to}${RESET}`
    }

    if (lower.includes('sent to')) {
      return `${GREEN}✓${RESET} ${DIM}delivered${RESET}`
    }

    if (lower.includes('new messages')) {
      return `${WHITE}${msg}${RESET}`
    }

    if (lower.includes('browse ok')) {
      return `${GREEN}✓${RESET} ${data?.url ?? ''} ${DIM}(${data?.chars} chars)${RESET}`
    }

    if (lower.includes('timer set')) {
      return `${CYAN}${msg}${RESET} ${DIM}${data?.fireAt ?? ''}${RESET}`
    }

    if (lower.includes('tick failed') || lower.includes('tick error')) {
      const err = (data?.error as string ?? '').slice(0, 60)
      return `${RED}${err}${err.length > 60 ? '…' : ''}${RESET}`
    }

    // Default: show message + compact data
    if (data && Object.keys(data).length > 0) {
      const parts = Object.entries(data)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ')
      return `${msg} ${DIM}${parts.slice(0, 60)}${RESET}`
    }

    return msg
  }

  // ── Interactive mode: full detail with spinners ──

  private logPretty(level: string, msg: string, data?: Record<string, unknown>): void {
    const icon = this.getIcon(msg)
    const time = formatTime(new Date())
    const color = level === 'WARN' ? YELLOW : level === 'ERROR' ? RED : ''

    let line = `${DIM}${time}${RESET} ${icon} ${color}${msg}${RESET}`

    if (data) {
      line += ' ' + formatData(data)
    }

    this.writeln(line)
  }

  /** Write a line, flushing immediately (journalctl needs this) */
  private writeln(line: string): void {
    process.stdout.write(line + '\n')
  }

  // ── Shared ──

  private getIcon(msg: string): string {
    const lower = msg.toLowerCase()
    for (const [pattern, icon] of Object.entries(ICONS)) {
      if (lower.startsWith(pattern)) return icon
    }
    return '  '
  }
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Strip ANSI escape sequences for daemon/journald output */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'object') {
      parts.push(`${DIM}${k}=${RESET}${CYAN}${JSON.stringify(v)}${RESET}`)
    } else {
      parts.push(`${DIM}${k}=${RESET}${CYAN}${v}${RESET}`)
    }
  }
  return parts.join(' ')
}
