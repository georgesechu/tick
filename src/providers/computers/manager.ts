import { randomUUID } from 'node:crypto'
import type { ComputerManager, Computer, Terminal } from '../../core/interfaces.js'
import type { ShellAction, ExecResult, TerminalInfo, BackgroundProcess } from '../../core/types.js'

export class DefaultComputerManager implements ComputerManager {
  private computers: Map<string, Computer>
  private defaultName: string

  constructor(computers: Computer[]) {
    if (computers.length === 0) {
      throw new Error('At least one computer is required')
    }
    this.computers = new Map(computers.map(c => [c.name, c]))
    this.defaultName = computers[0]!.name
  }

  get(name: string): Computer | undefined {
    return this.computers.get(name)
  }

  default(): Computer {
    return this.computers.get(this.defaultName)!
  }

  list(): Computer[] {
    return [...this.computers.values()]
  }

  async exec(action: ShellAction): Promise<ExecResult> {
    const computerName = action.computer ?? this.defaultName
    const computer = this.computers.get(computerName)
    if (!computer) {
      return {
        id: `err-${randomUUID().slice(0, 8)}`,
        exitCode: 1,
        stdout: '',
        stderr: `Computer not found: "${computerName}". Available: ${[...this.computers.keys()].join(', ')}`,
        durationMs: 0,
        truncated: false,
        fullOutputRef: null,
      }
    }

    const sessionName = action.session ?? 'default'
    const terminal = await computer.openTerminal(sessionName)

    return terminal.exec(action.command, {
      mode: action.mode,
      timeout: action.timeout ? parseTimeout(action.timeout) : undefined,
      stdin: action.stdin,
      env: action.env,
      label: action.label,
    })
  }

  allTerminals(): TerminalInfo[] {
    const result: TerminalInfo[] = []
    for (const computer of this.computers.values()) {
      result.push(...computer.listTerminals())
    }
    return result
  }

  allBackground(): BackgroundProcess[] {
    const result: BackgroundProcess[] = []
    for (const computer of this.computers.values()) {
      for (const tInfo of computer.listTerminals()) {
        const terminal = computer.getTerminal(tInfo.name)
        if (terminal) {
          result.push(...terminal.listBackground())
        }
      }
    }
    return result
  }

  async startAll(): Promise<void> {
    for (const computer of this.computers.values()) {
      await computer.start()
    }
  }

  async stopAll(): Promise<void> {
    for (const computer of this.computers.values()) {
      await computer.stop()
    }
  }
}

function parseTimeout(s: string): number {
  const match = s.match(/^(\d+)(ms|s|m|h)?$/)
  if (!match) return 60_000
  const [, n, unit] = match
  const ms: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3600_000 }
  return parseInt(n!) * (ms[unit ?? 's'] ?? 1000)
}
