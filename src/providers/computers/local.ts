import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Computer, Terminal, ExecOptions } from '../../core/interfaces.js'
import type { ComputerStatus, TerminalInfo, ExecResult, BackgroundProcess } from '../../core/types.js'

/**
 * A Terminal that persists cwd and env across commands.
 * Each exec spawns a new shell process, but cwd/env carry forward.
 */
class LocalTerminal implements Terminal {
  readonly name: string
  private _cwd: string
  private _env: Record<string, string>
  private _commandCount = 0
  private _startedAt: string
  private _lastUsedAt: string
  private _computerName: string
  private _background: Map<string, BackgroundProcess> = new Map()

  constructor(name: string, computerName: string, cwd?: string) {
    this.name = name
    this._computerName = computerName
    this._cwd = cwd ?? process.cwd()
    this._env = {}
    this._startedAt = new Date().toISOString()
    this._lastUsedAt = this._startedAt
  }

  get cwd(): string { return this._cwd }

  get info(): TerminalInfo {
    return {
      name: this.name,
      computer: this._computerName,
      cwd: this._cwd,
      startedAt: this._startedAt,
      lastUsedAt: this._lastUsedAt,
      commandCount: this._commandCount,
    }
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const id = `exec-${randomUUID().slice(0, 8)}`
    const mode = options?.mode ?? 'sync'
    const timeout = options?.timeout ?? 60_000
    const env = { ...process.env, ...this._env, ...options?.env } as Record<string, string>

    this._commandCount++
    this._lastUsedAt = new Date().toISOString()

    if (mode === 'background') {
      return this.execBackground(id, command, env, options)
    }

    return this.execSync(id, command, env, timeout, options?.stdin)
  }

  private execSync(
    id: string, command: string,
    env: Record<string, string>,
    timeout: number, stdin?: string,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const start = Date.now()
      const child = spawn('bash', ['-c', command], {
        cwd: this._cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
      })

      let stdout = ''
      let stderr = ''
      const MAX_OUTPUT = 50_000 // chars
      let truncated = false

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString()
        if (stdout.length + chunk.length > MAX_OUTPUT) {
          truncated = true
          stdout += chunk.slice(0, MAX_OUTPUT - stdout.length)
        } else {
          stdout += chunk
        }
      })

      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString()
        if (stderr.length + chunk.length > MAX_OUTPUT) {
          truncated = true
          stderr += chunk.slice(0, MAX_OUTPUT - stderr.length)
        } else {
          stderr += chunk
        }
      })

      if (stdin) {
        child.stdin.write(stdin)
        child.stdin.end()
      }

      child.on('close', (code) => {
        const durationMs = Date.now() - start

        // Track cwd changes: extract from command if it's a cd
        this.trackCwdChange(command)

        resolve({
          id,
          exitCode: code ?? 1,
          stdout: compressOutput(stdout),
          stderr: compressOutput(stderr),
          durationMs,
          truncated,
          fullOutputRef: null,
        })
      })

      child.on('error', (err) => {
        resolve({
          id,
          exitCode: 127,
          stdout: '',
          stderr: err.message,
          durationMs: Date.now() - start,
          truncated: false,
          fullOutputRef: null,
        })
      })
    })
  }

  private execBackground(
    id: string, command: string,
    env: Record<string, string>,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const start = Date.now()
    const child = spawn('bash', ['-c', command], {
      cwd: this._cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    const bgProcess: BackgroundProcess = {
      id,
      computer: this._computerName,
      terminal: this.name,
      command,
      label: options?.label ?? null,
      startedAt: new Date().toISOString(),
      status: 'running',
      result: null,
    }
    this._background.set(id, bgProcess)

    child.on('close', (code) => {
      bgProcess.status = (code === 0) ? 'completed' : 'failed'
      bgProcess.result = {
        id,
        exitCode: code ?? 1,
        stdout: compressOutput(stdout),
        stderr: compressOutput(stderr),
        durationMs: Date.now() - start,
        truncated: false,
        fullOutputRef: null,
      }
    })

    child.on('error', (err) => {
      bgProcess.status = 'failed'
      bgProcess.result = {
        id,
        exitCode: 127,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - start,
        truncated: false,
        fullOutputRef: null,
      }
    })

    // Return immediately with a handle
    return Promise.resolve({
      id,
      exitCode: 0,
      stdout: `Background process started: ${id}`,
      stderr: '',
      durationMs: 0,
      truncated: false,
      fullOutputRef: null,
    })
  }

  async kill(processId: string): Promise<void> {
    const bg = this._background.get(processId)
    if (bg && bg.status === 'running') {
      bg.status = 'killed'
    }
  }

  getBackground(id: string): BackgroundProcess | null {
    return this._background.get(id) ?? null
  }

  listBackground(): BackgroundProcess[] {
    return [...this._background.values()]
  }

  /** Best-effort cwd tracking — parses cd commands */
  private trackCwdChange(command: string): void {
    const match = command.match(/^\s*cd\s+(.+?)(?:\s*&&|\s*;|\s*$)/)
    if (!match) return

    const target = match[1]!.replace(/^["']|["']$/g, '').trim()
    if (target.startsWith('/')) {
      this._cwd = target
    } else if (target === '~') {
      this._cwd = process.env.HOME ?? '/home'
    } else if (target === '..') {
      this._cwd = this._cwd.replace(/\/[^/]+$/, '') || '/'
    } else if (target === '-') {
      // ignore
    } else {
      this._cwd = `${this._cwd}/${target}`.replace(/\/+/g, '/')
    }
  }
}

export class LocalComputer implements Computer {
  readonly name: string
  readonly type = 'local'
  private terminals: Map<string, LocalTerminal> = new Map()
  private defaultCwd: string

  constructor(name: string, cwd?: string) {
    this.name = name
    this.defaultCwd = cwd ?? process.cwd()
  }

  async start(): Promise<void> { /* nothing to start */ }
  async stop(): Promise<void> {
    this.terminals.clear()
  }
  async status(): Promise<ComputerStatus> { return 'running' }

  async openTerminal(name: string): Promise<Terminal> {
    let terminal = this.terminals.get(name)
    if (!terminal) {
      terminal = new LocalTerminal(name, this.name, this.defaultCwd)
      this.terminals.set(name, terminal)
    }
    return terminal
  }

  getTerminal(name: string): Terminal | null {
    return this.terminals.get(name) ?? null
  }

  listTerminals(): TerminalInfo[] {
    return [...this.terminals.values()].map(t => t.info)
  }

  async closeTerminal(name: string): Promise<void> {
    this.terminals.delete(name)
  }
}

/** Compress output: keep head + tail if too long */
function compressOutput(output: string, maxChars = 4000): string {
  if (output.length <= maxChars) return output.trimEnd()
  const headSize = Math.floor(maxChars * 0.3)
  const tailSize = maxChars - headSize - 50
  return [
    output.slice(0, headSize),
    `\n... [${output.length - headSize - tailSize} chars truncated] ...\n`,
    output.slice(-tailSize),
  ].join('').trimEnd()
}
