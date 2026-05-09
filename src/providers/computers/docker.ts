import { randomUUID } from 'node:crypto'
import { execSync, spawn } from 'node:child_process'
import type { Computer, Terminal, ExecOptions } from '../../core/interfaces.js'
import type { ComputerStatus, TerminalInfo, ExecResult, BackgroundProcess } from '../../core/types.js'

export interface DockerComputerConfig {
  name: string
  image?: string               // default: ubuntu:24.04
  volumes?: string[]           // e.g. ["/host/path:/container/path"]
  ports?: string[]             // e.g. ["8080:80"]
  env?: Record<string, string>
  memory?: string              // e.g. "4g"
  cpus?: string                // e.g. "2"
  network?: string             // e.g. "host" or "bridge"
  display?: boolean | {        // enable virtual display + noVNC (default: false)
    port?: number              // noVNC port (default: 6080)
    resolution?: string        // e.g. "1280x720" (default: "1280x800")
  }
}

class DockerTerminal implements Terminal {
  readonly name: string
  private _cwd: string
  private _env: Record<string, string>
  private _commandCount = 0
  private _startedAt: string
  private _lastUsedAt: string
  private _computerName: string
  private _containerId: string
  private _background: Map<string, BackgroundProcess> = new Map()

  constructor(name: string, computerName: string, containerId: string, cwd: string) {
    this.name = name
    this._computerName = computerName
    this._containerId = containerId
    this._cwd = cwd
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

    this._commandCount++
    this._lastUsedAt = new Date().toISOString()

    // Build docker exec command
    const envFlags = Object.entries({ ...this._env, ...options?.env })
      .map(([k, v]) => ['-e', `${k}=${v}`]).flat()

    // Source ssh-agent + display env if available (set up during container boot)
    const wrappedCommand = `[ -f /etc/ssh-agent.env ] && . /etc/ssh-agent.env 2>/dev/null; [ -f /etc/display.env ] && . /etc/display.env 2>/dev/null; ${command}`

    const dockerArgs = [
      'exec', '-i',
      '-w', this._cwd,
      ...envFlags,
      this._containerId,
      'bash', '-c', wrappedCommand,
    ]

    if (mode === 'background') {
      return this.execBackground(id, dockerArgs, command, options)
    }

    return this.execSync(id, dockerArgs, timeout, options?.stdin)
  }

  private execSync(id: string, dockerArgs: string[], timeout: number, stdin?: string): Promise<ExecResult> {
    return new Promise((resolve) => {
      const start = Date.now()
      const child = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
      })

      let stdout = ''
      let stderr = ''
      const MAX = 50_000

      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < MAX) stdout += d.toString()
      })
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < MAX) stderr += d.toString()
      })

      if (stdin) { child.stdin.write(stdin); child.stdin.end() }

      child.on('close', (code) => {
        this.trackCwd(command(dockerArgs))
        resolve({
          id,
          exitCode: code ?? 1,
          stdout: compress(stdout),
          stderr: compress(stderr),
          durationMs: Date.now() - start,
          truncated: stdout.length >= MAX || stderr.length >= MAX,
          fullOutputRef: null,
        })
      })

      child.on('error', (err) => {
        resolve({
          id, exitCode: 127, stdout: '', stderr: err.message,
          durationMs: Date.now() - start, truncated: false, fullOutputRef: null,
        })
      })
    })
  }

  private execBackground(id: string, dockerArgs: string[], cmd: string, options?: ExecOptions): Promise<ExecResult> {
    const start = Date.now()
    const child = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = '', stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const bg: BackgroundProcess = {
      id, computer: this._computerName, terminal: this.name,
      command: cmd, label: options?.label ?? null,
      startedAt: new Date().toISOString(), status: 'running', result: null,
    }
    this._background.set(id, bg)

    child.on('close', (code) => {
      bg.status = code === 0 ? 'completed' : 'failed'
      bg.result = {
        id, exitCode: code ?? 1, stdout: compress(stdout), stderr: compress(stderr),
        durationMs: Date.now() - start, truncated: false, fullOutputRef: null,
      }
    })

    return Promise.resolve({
      id, exitCode: 0, stdout: `Background process started: ${id}`,
      stderr: '', durationMs: 0, truncated: false, fullOutputRef: null,
    })
  }

  async kill(processId: string): Promise<void> {
    const bg = this._background.get(processId)
    if (bg && bg.status === 'running') bg.status = 'killed'
  }

  getBackground(id: string): BackgroundProcess | null {
    return this._background.get(id) ?? null
  }

  listBackground(): BackgroundProcess[] {
    return [...this._background.values()]
  }

  private trackCwd(cmd: string): void {
    const match = cmd.match(/^\s*cd\s+(.+?)(?:\s*&&|\s*;|\s*$)/)
    if (!match) return
    const target = match[1]!.replace(/^["']|["']$/g, '').trim()
    if (target.startsWith('/')) this._cwd = target
    else if (target === '..') this._cwd = this._cwd.replace(/\/[^/]+$/, '') || '/'
    else if (!target.startsWith('-')) this._cwd = `${this._cwd}/${target}`.replace(/\/+/g, '/')
  }
}

function command(dockerArgs: string[]): string {
  // Extract the actual command from docker exec args (last arg after bash -c)
  return dockerArgs[dockerArgs.length - 1] ?? ''
}

export class DockerComputer implements Computer {
  readonly name: string
  readonly type = 'docker'
  private config: DockerComputerConfig
  private containerId: string | null = null
  private containerName: string
  private terminals: Map<string, DockerTerminal> = new Map()

  constructor(config: DockerComputerConfig) {
    this.name = config.name
    this.config = config
    this.containerName = `tick-${config.name}`
  }

  async start(): Promise<void> {
    // Check if container already exists
    let isNew = false
    try {
      const existing = execSync(`docker ps -aq -f name=^${this.containerName}$`, { encoding: 'utf-8' }).trim()
      if (existing) {
        // Start if stopped
        const running = execSync(`docker ps -q -f name=^${this.containerName}$`, { encoding: 'utf-8' }).trim()
        if (!running) {
          execSync(`docker start ${this.containerName}`)
        }
        // Clear stale terminals if container ID changed (container was recreated)
        if (this.containerId && this.containerId !== existing) {
          this.terminals.clear()
        }
        this.containerId = existing
      }
    } catch { /* */ }

    // Always clear terminals on fresh start — ensures no stale container refs
    this.terminals.clear()

    if (!this.containerId) {
      isNew = true

    // Create new container
    const image = this.config.image ?? 'ubuntu:24.04'
    const args = ['docker', 'run', '-d', '--name', this.containerName]

    // Volumes
    for (const v of this.config.volumes ?? []) {
      args.push('-v', v)
    }

    // Ports
    for (const p of this.config.ports ?? []) {
      args.push('-p', p)
    }

    // Display port (noVNC)
    if (this.config.display) {
      const displayCfg = typeof this.config.display === 'object' ? this.config.display : {}
      const noVncPort = displayCfg.port ?? 6080
      // Only add if not already in ports list
      const portStr = `${noVncPort}:${noVncPort}`
      if (!(this.config.ports ?? []).includes(portStr)) {
        args.push('-p', portStr)
      }
    }

    // Env
    for (const [k, v] of Object.entries(this.config.env ?? {})) {
      args.push('-e', `${k}=${v}`)
    }

    // Resources
    if (this.config.memory) args.push('--memory', this.config.memory)
    if (this.config.cpus) args.push('--cpus', this.config.cpus)
    if (this.config.network) args.push('--network', this.config.network)

    // Chrome needs shared memory
    if (this.config.display) {
      args.push('--shm-size', '2g')
    }

    // Keep alive
    args.push(image, 'sleep', 'infinity')

    this.containerId = execSync(args.join(' '), { encoding: 'utf-8' }).trim()

      // Install basics (only on new container)
      try {
        execSync(`docker exec ${this.containerId} bash -c "apt-get update -qq && apt-get install -y -qq curl git python3 jq ripgrep fd-find openssh-client > /dev/null 2>&1 && (command -v fd || ln -sf \$(which fdfind) /usr/local/bin/fd) 2>/dev/null"`, { timeout: 120000 })
      } catch { /* best effort */ }
    }

    // --- Below runs on EVERY start (new or existing container) ---

    // Start ssh-agent and load any keys — write env to /etc/ssh-agent.env
    // Must run every start because ssh-agent dies when container stops
    try {
      execSync([
        `docker exec ${this.containerId} bash -c "`,
        `eval \\$(ssh-agent -s) > /dev/null 2>&1;`,
        `for key in /root/.ssh/id_*; do [ -f \\$key ] && [[ \\$key != *.pub ]] && ssh-add \\$key 2>/dev/null; done;`,
        `echo export SSH_AUTH_SOCK=\\$SSH_AUTH_SOCK > /etc/ssh-agent.env;`,
        `echo export SSH_AGENT_PID=\\$SSH_AGENT_PID >> /etc/ssh-agent.env`,
        `"`,
      ].join(' '), { timeout: 10000 })
    } catch { /* best effort */ }

    // Display stack: Xvfb + fluxbox + x11vnc + noVNC + Chrome
    if (this.config.display) {
      await this.setupDisplay()
    }
  }

  /**
   * Set up a virtual display with noVNC for browser-based access.
   * Installs Xvfb, fluxbox, x11vnc, noVNC, and Chrome.
   * George can connect via http://localhost:<port> to see/control the desktop.
   */
  private async setupDisplay(): Promise<void> {
    const displayCfg = typeof this.config.display === 'object' ? this.config.display : {}
    const resolution = displayCfg.resolution ?? '1280x800'
    const vncPort = 5900
    const noVncPort = displayCfg.port ?? 6080
    const id = this.containerId!

    // Check if display is already running
    try {
      const check = execSync(`docker exec ${id} bash -c "pgrep -x Xvfb > /dev/null 2>&1 && echo running || echo stopped"`, { encoding: 'utf-8' }).trim()
      if (check === 'running') return
    } catch { /* continue with setup */ }

    // Install display packages (this takes a while the first time, cached after)
    try {
      execSync(`docker exec ${id} bash -c "export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq xvfb fluxbox x11vnc novnc websockify chromium-browser fonts-liberation fonts-noto-color-emoji dbus-x11 pulseaudio > /dev/null 2>&1"`, { timeout: 300000 })
    } catch {
      // Try chromium instead of chromium-browser (package name varies)
      try {
        execSync(`docker exec ${id} bash -c "export DEBIAN_FRONTEND=noninteractive && apt-get install -y -qq chromium > /dev/null 2>&1"`, { timeout: 120000 })
      } catch { /* chromium might already be installed */ }
    }

    // Start display services — write a script file to avoid shell escaping nightmares
    const script = `#!/bin/bash
export DISPLAY=:99
Xvfb :99 -screen 0 ${resolution}x24 -ac &
sleep 1
fluxbox -display :99 &
sleep 0.5
x11vnc -display :99 -forever -shared -nopw -rfbport ${vncPort} -bg -o /tmp/x11vnc.log 2>/dev/null
websockify --web /usr/share/novnc ${noVncPort} localhost:${vncPort} > /tmp/novnc.log 2>&1 &
sleep 0.5
pulseaudio --start --exit-idle-time=-1 2>/dev/null || true
echo 'export DISPLAY=:99' > /etc/display.env
echo 'export PULSE_SERVER=unix:/tmp/pulseaudio.sock' >> /etc/display.env
echo 'display ready'
`

    try {
      // Write the script, then execute it
      execSync(`docker exec ${id} bash -c 'cat > /tmp/start-display.sh << "XEOF"\n${script}\nXEOF\nchmod +x /tmp/start-display.sh && bash /tmp/start-display.sh'`, { timeout: 30000 })
    } catch (err) {
      console.error('[docker] display setup failed:', (err as Error).message?.slice(0, 200))
    }
  }

  async stop(): Promise<void> {
    if (this.containerId) {
      try { execSync(`docker stop ${this.containerName}`, { timeout: 10000 }) } catch { /* */ }
    }
    this.terminals.clear()
  }

  async status(): Promise<ComputerStatus> {
    if (!this.containerId) return 'stopped'
    try {
      const running = execSync(`docker ps -q -f name=^${this.containerName}$`, { encoding: 'utf-8' }).trim()
      return running ? 'running' : 'stopped'
    } catch {
      return 'unreachable'
    }
  }

  async openTerminal(name: string): Promise<Terminal> {
    let terminal = this.terminals.get(name)
    if (!terminal) {
      terminal = new DockerTerminal(name, this.name, this.containerId!, '/root')
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

function compress(output: string, max = 4000): string {
  if (output.length <= max) return output.trimEnd()
  const head = Math.floor(max * 0.3)
  const tail = max - head - 50
  return [
    output.slice(0, head),
    `\n... [${output.length - head - tail} chars truncated] ...\n`,
    output.slice(-tail),
  ].join('').trimEnd()
}
