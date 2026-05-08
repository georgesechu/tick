import type { Logger } from '../core/index.js'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const MAGENTA = '\x1b[35m'
const GRAY = '\x1b[90m'

const LEVEL_STYLE: Record<string, { icon: string; color: string }> = {
  DEBUG: { icon: '🔍', color: GRAY },
  INFO:  { icon: '  ', color: '' },
  WARN:  { icon: '⚠️ ', color: YELLOW },
  ERROR: { icon: '❌', color: RED },
}

const MSG_ICONS: Record<string, string> = {
  'loading agent':     '📦',
  'llm provider':      '🤖',
  'computer':          '🖥️ ',
  'seeded memory':     '🌱',
  'tick #':            '⚡',
  'llm responded':     '🧠',
  'thinking':          '💭',
  'shell':             '💻',
  'send enqueued':     '📤',
  'slack connected':   '🔗',
  'slack:':            '💬',
  'tick complete':     '✅',
  'tick error':        '💥',
  'tick failed':       '💥',
  'starting':          '🚀',
  'shutting down':     '🛑',
  'stopped':           '🏁',
}

export class ConsoleLogger implements Logger {
  private daemon: boolean
  private spinnerInterval: ReturnType<typeof setInterval> | null = null
  private spinnerStart = 0

  constructor(private prefix: string = 'tick', daemon = false) {
    this.daemon = daemon
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
      this.logPlain(level, msg, data)
    } else {
      this.logPretty(level, msg, data)
    }
  }

  private logPlain(level: string, msg: string, data?: Record<string, unknown>): void {
    const ts = new Date().toISOString()
    const line = `${ts} [${this.prefix}] ${level} ${msg}`
    console.log(data ? `${line} ${JSON.stringify(data)}` : line)
  }

  private logPretty(level: string, msg: string, data?: Record<string, unknown>): void {
    const style = LEVEL_STYLE[level] ?? LEVEL_STYLE.INFO!
    const time = formatTime(new Date())
    const icon = this.getIcon(msg, style.icon)
    const color = style.color

    let line = `${DIM}${time}${RESET} ${icon} ${color}${msg}${RESET}`

    if (data) {
      line += ' ' + formatData(data)
    }

    console.log(line)
  }

  private getIcon(msg: string, fallback: string): string {
    const lower = msg.toLowerCase()
    for (const [pattern, icon] of Object.entries(MSG_ICONS)) {
      if (lower.startsWith(pattern.toLowerCase())) return icon
    }
    return fallback
  }
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
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
