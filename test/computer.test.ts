import { describe, it, expect, beforeEach } from 'vitest'
import { LocalComputer } from '../src/providers/computers/local.js'
import { DefaultComputerManager } from '../src/providers/computers/manager.js'

describe('LocalComputer', () => {
  let computer: LocalComputer

  beforeEach(() => {
    computer = new LocalComputer('test', '/tmp')
  })

  it('has correct name and type', () => {
    expect(computer.name).toBe('test')
    expect(computer.type).toBe('local')
  })

  it('status is running', async () => {
    expect(await computer.status()).toBe('running')
  })

  it('opens a terminal', async () => {
    const terminal = await computer.openTerminal('default')
    expect(terminal.name).toBe('default')
    expect(terminal.cwd).toBe('/tmp')
  })

  it('reuses existing terminal by name', async () => {
    const t1 = await computer.openTerminal('work')
    const t2 = await computer.openTerminal('work')
    expect(t1).toBe(t2)
  })

  it('lists terminals', async () => {
    await computer.openTerminal('a')
    await computer.openTerminal('b')
    const list = computer.listTerminals()
    expect(list).toHaveLength(2)
    expect(list.map(t => t.name).sort()).toEqual(['a', 'b'])
  })

  it('closes a terminal', async () => {
    await computer.openTerminal('temp')
    await computer.closeTerminal('temp')
    expect(computer.getTerminal('temp')).toBeNull()
  })
})

describe('LocalTerminal', () => {
  let computer: LocalComputer

  beforeEach(() => {
    computer = new LocalComputer('test', '/tmp')
  })

  it('executes a sync command', async () => {
    const terminal = await computer.openTerminal('default')
    const result = await terminal.exec('echo hello')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('captures stderr', async () => {
    const terminal = await computer.openTerminal('default')
    const result = await terminal.exec('echo error >&2')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('error')
  })

  it('returns exit codes', async () => {
    const terminal = await computer.openTerminal('default')
    const result = await terminal.exec('exit 42')
    expect(result.exitCode).toBe(42)
  })

  it('handles stdin', async () => {
    const terminal = await computer.openTerminal('default')
    const result = await terminal.exec('cat', { stdin: 'piped input' })
    expect(result.stdout).toBe('piped input')
  })

  it('passes env vars', async () => {
    const terminal = await computer.openTerminal('default')
    const result = await terminal.exec('echo $MY_VAR', { env: { MY_VAR: 'hello' } })
    expect(result.stdout).toBe('hello')
  })

  it('tracks command count', async () => {
    const terminal = await computer.openTerminal('work')
    await terminal.exec('echo 1')
    await terminal.exec('echo 2')
    await terminal.exec('echo 3')

    const info = computer.listTerminals().find(t => t.name === 'work')!
    expect(info.commandCount).toBe(3)
  })

  it('runs background commands', async () => {
    const terminal = await computer.openTerminal('default')
    const result = await terminal.exec('sleep 0.1 && echo done', { mode: 'background', label: 'sleeper' })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Background process started')

    // Background process should be listed
    const bg = terminal.listBackground()
    expect(bg).toHaveLength(1)
    expect(bg[0]!.label).toBe('sleeper')
    expect(bg[0]!.status).toBe('running')

    // Wait for completion
    await new Promise(r => setTimeout(r, 300))

    const completed = terminal.getBackground(bg[0]!.id)!
    expect(completed.status).toBe('completed')
    expect(completed.result!.stdout).toBe('done')
  })

  it('handles command not found', async () => {
    const terminal = await computer.openTerminal('default')
    const result = await terminal.exec('nonexistent_command_xyz')
    expect(result.exitCode).not.toBe(0)
  })
})

describe('DefaultComputerManager', () => {
  it('routes shell actions to the correct computer', async () => {
    const local = new LocalComputer('local', '/tmp')
    const manager = new DefaultComputerManager([local])

    const result = await manager.exec({
      type: 'shell',
      command: 'echo works',
      mode: 'sync',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('works')
  })

  it('creates terminals on demand', async () => {
    const local = new LocalComputer('local', '/tmp')
    const manager = new DefaultComputerManager([local])

    await manager.exec({
      type: 'shell',
      command: 'echo 1',
      session: 'deploy',
      mode: 'sync',
    })

    const terminals = manager.allTerminals()
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.name).toBe('deploy')
  })

  it('returns error for unknown computer', async () => {
    const local = new LocalComputer('local', '/tmp')
    const manager = new DefaultComputerManager([local])

    const result = await manager.exec({
      type: 'shell',
      command: 'echo hi',
      computer: 'nonexistent',
      mode: 'sync',
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Computer not found')
  })

  it('defaults to first computer', async () => {
    const a = new LocalComputer('primary', '/tmp')
    const b = new LocalComputer('secondary', '/tmp')
    const manager = new DefaultComputerManager([a, b])

    expect(manager.default().name).toBe('primary')
  })

  it('aggregates terminals across computers', async () => {
    const a = new LocalComputer('a', '/tmp')
    const b = new LocalComputer('b', '/tmp')
    const manager = new DefaultComputerManager([a, b])

    await manager.exec({ type: 'shell', command: 'echo 1', computer: 'a', session: 'x', mode: 'sync' })
    await manager.exec({ type: 'shell', command: 'echo 2', computer: 'b', session: 'y', mode: 'sync' })

    const terminals = manager.allTerminals()
    expect(terminals).toHaveLength(2)
    expect(terminals.map(t => `${t.computer}/${t.name}`).sort()).toEqual(['a/x', 'b/y'])
  })
})
