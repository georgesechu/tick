import { randomUUID } from 'node:crypto'
import type {
  LLMProvider, TickOutputParser, MemoryStore, MemoryOperationExecutor,
  ContextAssembler, TickStore, Clock, Logger,
  ComputerManager, InboxStore, OutboxStore, ChannelAdapter, Browser,
} from '../core/interfaces.js'
import type {
  AgentConfig, TickRecord, TickOutput, TickStatus,
  TimeContext, MemoryOpResult, MemoryEntry, ExecResult, DownloadResult, BrowseResult,
  TriggerReason,
} from '../core/types.js'

/** Simple persistent key-value state that survives restarts */
export interface AgentStateStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface OrchestratorDeps {
  config: AgentConfig
  systemPrompt: string
  llm: LLMProvider
  parser: TickOutputParser
  memory: MemoryStore
  memoryExecutor: MemoryOperationExecutor
  contextAssembler: ContextAssembler
  tickStore: TickStore
  clock: Clock
  logger: Logger
  stateStore?: AgentStateStore
  browser?: Browser
  computers?: ComputerManager
  inbox?: InboxStore
  outbox?: OutboxStore
  channelAdapters?: ChannelAdapter[]
}

export class Orchestrator {
  private lastScratchpad: string | null = null
  private lastMemoryResults: MemoryOpResult[] = []
  private lastShellResults: ExecResult[] = []
  private lastDownloadResults: DownloadResult[] = []
  private lastBrowseResults: BrowseResult[] = []
  private lastStatus: TickStatus = 'idle'
  private lastRequestedMemories: MemoryEntry[] = []
  private tickCount = 0
  private timers: Array<{ id: string; fireAt: number; reason: string }> = []

  constructor(private deps: OrchestratorDeps) {
    // Restore persisted state from previous session
    this.lastScratchpad = deps.stateStore?.get('scratchpad') ?? null
    this.lastStatus = (deps.stateStore?.get('lastStatus') as TickStatus) ?? 'idle'
    this.tickCount = parseInt(deps.stateStore?.get('tickCount') ?? '0', 10)

    // Restore persisted timers
    try {
      const saved = deps.stateStore?.get('timers')
      if (saved) this.timers = JSON.parse(saved)
    } catch { /* */ }
  }

  /** Check if there's any reason to tick — returns false if nothing has changed */
  async shouldTick(): Promise<boolean> {
    // Always tick if last tick was "working" (continuation)
    if (this.lastStatus === 'working') return true

    // Check if any timers have fired
    if (this.hasFiredTimers()) return true

    // Always tick if there are pending results from last tick
    if (this.lastShellResults.length > 0) return true
    if (this.lastDownloadResults.length > 0) return true
    if (this.lastBrowseResults.length > 0) return true
    if (this.lastMemoryResults.some(r => r.op === 'get')) return true

    // Tick if there are unread inbox items
    const unread = await this.deps.inbox?.getUnreadCount() ?? 0
    if (unread > 0) return true

    // Tick if there are completed background processes
    const completed = this.deps.computers?.allBackground().filter(p => p.status !== 'running') ?? []
    if (completed.length > 0) return true

    return false
  }

  async runOnce(trigger: TriggerReason = { type: 'heartbeat' }): Promise<TickRecord> {
    const { config, llm, parser, memory, memoryExecutor, contextAssembler, tickStore, clock, logger } = this.deps
    const startedAt = clock.now()

    logger.info(`tick #${this.tickCount + 1} starting`, { trigger: trigger.type, agent: config.id })

    // 1. Gather state
    const [index, pinned, inbox, lastTick] = await Promise.all([
      memory.getIndex(),
      memory.getPinned(),
      this.deps.inbox?.fetch() ?? Promise.resolve([]),
      tickStore.getLast(config.id),
    ])

    const time = this.buildTimeContext(clock, lastTick)

    // 2. Assemble context
    const messages = await contextAssembler.assemble({
      systemPrompt: this.deps.systemPrompt,
      memoryIndex: index,
      pinnedMemories: pinned,
      requestedMemories: this.lastRequestedMemories,
      inbox,
      lastScratchpad: this.lastScratchpad,
      lastActionResults: this.lastMemoryResults,
      lastShellResults: this.lastShellResults,
      lastDownloadResults: this.lastDownloadResults,
      lastBrowseResults: this.lastBrowseResults,
      terminals: this.deps.computers?.allTerminals() ?? [],
      backgroundProcesses: this.deps.computers?.allBackground() ?? [],
      time,
    })

    // 3. Call LLM
    let output: TickOutput
    let inputTokens = 0
    let outputTokens = 0

    const spinLogger = logger as any
    spinLogger.startSpinner?.('thinking...')

    try {
      const response = await llm.complete({
        messages,
        model: config.model,
      })
      spinLogger.stopSpinner?.()
      inputTokens = response.usage.inputTokens
      outputTokens = response.usage.outputTokens
      output = parser.parse(response.content)
    } catch (err) {
      spinLogger.stopSpinner?.()
      const record = this.buildRecord(trigger, startedAt, clock.now(), 'blocked', 0, 0, 0, 0, err)
      await tickStore.save(record)
      logger.error('tick failed', { error: (err as Error).message })
      throw err
    }

    logger.info(`llm responded`, {
      status: output.status,
      actions: output.actions.length,
      memoryOps: output.memoryOps.length,
      tokens: { in: inputTokens, out: outputTokens },
    })

    if (output.thinking) {
      logger.debug('thinking', { thinking: output.thinking })
    }

    // 4. Execute memory ops
    const memoryResults = await memoryExecutor.execute(output.memoryOps)
    this.lastMemoryResults = memoryResults

    // Collect any entries returned by "get" ops for next tick's hot memory
    this.lastRequestedMemories = memoryResults
      .filter(r => r.op === 'get' && r.success && r.data && !Array.isArray(r.data))
      .map(r => r.data as MemoryEntry)

    // 5. Execute shell actions
    const shellResults: ExecResult[] = []
    if (this.deps.computers) {
      for (const action of output.actions) {
        if (action.type === 'shell') {
          if (action.mode !== 'background') {
            spinLogger.startSpinner?.(`running: ${action.label ?? action.command.slice(0, 40)}`)
          }
          const result = await this.deps.computers.exec(action)
          spinLogger.stopSpinner?.()
          shellResults.push(result)
          const target = action.computer ?? 'default'
          logger.info(`shell [${result.id}] exit:${result.exitCode}`, { computer: target, command: action.command })
        }
      }
    }
    this.lastShellResults = shellResults

    // 6. Execute download actions
    const downloadResults: DownloadResult[] = []
    if (this.deps.channelAdapters) {
      for (const action of output.actions) {
        if (action.type === 'download') {
          const result = await this.executeDownload(action.ref, action.path)
          downloadResults.push(result)
        }
      }
    }
    this.lastDownloadResults = downloadResults

    // 6b. Execute browse actions
    const browseResults: BrowseResult[] = []
    if (this.deps.browser) {
      for (const action of output.actions) {
        if (action.type === 'browse') {
          spinLogger.startSpinner?.(`browsing: ${action.url.slice(0, 50)}`)
          const result = await this.deps.browser.browse(action)
          spinLogger.stopSpinner?.()
          browseResults.push(result)
          if (result.success) {
            logger.info(`browse OK: ${result.title}`, { url: action.url, chars: result.content.length })
          } else {
            logger.error(`browse failed: ${action.url}`, { error: result.error })
          }
        }
      }
    }
    this.lastBrowseResults = browseResults

    // 7. Enqueue send actions
    if (this.deps.outbox) {
      for (const action of output.actions) {
        if (action.type === 'send') {
          await this.deps.outbox.enqueue({
            channel: action.channel,
            to: action.to,
            content: action.content,
            attachments: action.attachments ?? [],
            replyTo: action.replyTo ?? null,
            threadId: action.threadId ?? null,
          })
          logger.info(`send enqueued`, { channel: action.channel, to: action.to, files: action.attachments?.length ?? 0 })
        }
      }
    }

    // 7b. Process wait/timer actions
    for (const action of output.actions) {
      if (action.type === 'wait') {
        this.processWait(action, logger)
      }
    }

    // 8. Mark inbox items as read — only when the agent actually responded
    const hasSendActions = output.actions.some(a => a.type === 'send')
    if (this.deps.inbox && inbox.length > 0 && hasSendActions) {
      await this.deps.inbox.markRead(inbox.map(i => i.id))
    }

    // 8. Auto-maintain rolling conversation context
    //    This gives the agent free "short-term memory" without explicit memoryOps
    if (inbox.length > 0 || output.actions.some(a => a.type === 'send')) {
      await this.updateConversationMemory(inbox, output)
    }

    // 9. Store scratchpad and status (persisted to survive restarts)
    this.lastScratchpad = output.scratchpad
    this.lastStatus = output.status
    if (this.deps.stateStore) {
      this.deps.stateStore.set('scratchpad', output.scratchpad)
      this.deps.stateStore.set('lastStatus', output.status)
      this.deps.stateStore.set('tickCount', String(this.tickCount + 1))
      this.deps.stateStore.set('timers', JSON.stringify(this.timers))
    }

    // 9. Log tick
    const record = this.buildRecord(
      trigger, startedAt, clock.now(), output.status,
      inputTokens, outputTokens,
      output.actions.length, output.memoryOps.length, null,
    )
    await tickStore.save(record)

    logger.info(`tick #${record.tickNumber} complete`, {
      status: output.status,
      durationMs: record.durationMs,
    })

    return record
  }

  private seenInboxIds = new Set<string>()

  /** Auto-maintain a rolling conversation log — last ~10 messages */
  private async updateConversationMemory(inbox: any[], output: TickOutput): Promise<void> {
    const { memory } = this.deps
    const MAX_TURNS = 10

    // Load existing conversation
    const existing = await memory.get('thread:recent')
    let turns: string[] = existing ? existing.value.split('\n---\n') : []

    // Add new inbox messages — deduplicate by source ID
    let added = false
    for (const item of inbox) {
      if (this.seenInboxIds.has(item.sourceId ?? item.id)) continue
      this.seenInboxIds.add(item.sourceId ?? item.id)
      const from = item.from?.name ?? item.from?.channelHandle ?? 'unknown'
      turns.push(`[${item.channel}] ${from}: ${item.body.slice(0, 300)}`)
      added = true
    }

    // Add agent's outgoing messages
    for (const action of output.actions) {
      if (action.type === 'send') {
        turns.push(`[${action.channel}] agent: ${action.content.slice(0, 300)}`)
        added = true
      }
    }

    // Only write if something new was added
    if (!added) return

    // Keep only the last N turns
    if (turns.length > MAX_TURNS) {
      turns = turns.slice(-MAX_TURNS)
    }

    const value = turns.join('\n---\n')
    const lastMsg = turns[turns.length - 1] ?? ''
    await memory.set({
      key: 'thread:recent',
      value,
      summary: `${turns.length} recent messages — ${lastMsg.slice(0, 60)}`,
      type: 'state',
      pinned: true,
    })
  }

  /** Process a wait action — schedule timers */
  private processWait(action: { type: 'wait'; until: any; onEvent?: string }, logger: any): void {
    const now = Date.now()
    const id = `timer-${now}`

    if (typeof action.until === 'object' && 'after' in action.until) {
      const ms = parseDuration(action.until.after)
      const fireAt = now + ms
      this.timers.push({ id, fireAt, reason: `after ${action.until.after}` })
      logger.info(`timer set: ${action.until.after}`, { fireAt: new Date(fireAt).toISOString() })
    } else if (typeof action.until === 'object' && 'at' in action.until) {
      const fireAt = new Date(action.until.at).getTime()
      if (!isNaN(fireAt)) {
        this.timers.push({ id, fireAt, reason: `at ${action.until.at}` })
        logger.info(`timer set: ${action.until.at}`, { fireAt: new Date(fireAt).toISOString() })
      }
    } else if (action.until === 'immediate') {
      this.lastStatus = 'working' // force immediate re-tick
    }
    // 'on_event' is handled by shouldTick checking inbox
  }

  /** Check if any timers have fired, consume them */
  private hasFiredTimers(): boolean {
    const now = Date.now()
    const fired = this.timers.filter(t => t.fireAt <= now)
    if (fired.length === 0) return false

    // Remove fired timers
    this.timers = this.timers.filter(t => t.fireAt > now)

    // Persist updated timers
    this.deps.stateStore?.set('timers', JSON.stringify(this.timers))

    return true
  }

  /** Get pending timers for display/context */
  getPendingTimers(): Array<{ id: string; fireAt: number; reason: string }> {
    return this.timers.filter(t => t.fireAt > Date.now())
  }

  /** Seed initial memory entries from config */
  async seedMemory(): Promise<void> {
    const { config, memory, logger } = this.deps
    const index = await memory.getIndex()
    const existingKeys = new Set(index.map(e => e.key))

    for (const [key, value] of Object.entries(config.seedMemory ?? {})) {
      if (existingKeys.has(key)) continue
      await memory.set({
        key,
        value,
        summary: value.slice(0, 80),
        type: 'fact',
        pinned: key.startsWith('self:'),
      })
      logger.info(`seeded memory: ${key}`)
    }
  }

  private async executeDownload(ref: string, targetPath: string): Promise<DownloadResult> {
    const { logger } = this.deps
    // Find the adapter that owns this ref (ref starts with adapter name, e.g. "slack:...")
    const adapterName = ref.split(':')[0]
    const adapter = this.deps.channelAdapters?.find(a => a.name === adapterName)

    if (!adapter?.downloadAttachment) {
      const error = `No download handler for ref: ${ref}`
      logger.warn(error)
      return { ref, path: targetPath, success: false, size: null, error }
    }

    try {
      await adapter.downloadAttachment(ref, targetPath)
      const { statSync } = await import('node:fs')
      const size = statSync(targetPath).size
      logger.info(`downloaded ${ref} → ${targetPath}`, { size })
      return { ref, path: targetPath, success: true, size, error: null }
    } catch (err) {
      const error = (err as Error).message
      logger.error(`download failed: ${ref}`, { error })
      return { ref, path: targetPath, success: false, size: null, error }
    }
  }

  private buildTimeContext(clock: Clock, lastTick: TickRecord | null): TimeContext {
    const now = clock.now()
    let timeSinceLastTick: string | null = null

    if (lastTick) {
      const ms = now.getTime() - new Date(lastTick.startedAt).getTime()
      timeSinceLastTick = formatDuration(ms)
    }

    // Convert pending timers to upcoming commitments
    const upcoming = this.timers
      .filter(t => t.fireAt > now.getTime())
      .map(t => ({
        description: t.reason,
        dueBy: new Date(t.fireAt).toISOString(),
        sourceThread: null,
        status: 'pending' as const,
      }))

    return {
      now: now.toISOString(),
      userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lastTickAt: lastTick?.startedAt ?? null,
      timeSinceLastTick,
      taskElapsed: null,
      tickBudget: {
        used: this.tickCount,
        limit: this.deps.config.tickPolicy.maxTicksPerHour,
        period: 'hour',
      },
      upcoming,
      overdue: [],
    }
  }

  private buildRecord(
    trigger: TriggerReason, startedAt: Date, endedAt: Date,
    status: TickStatus, inputTokens: number, outputTokens: number,
    actionsExecuted: number, memoryOpsExecuted: number,
    error: unknown,
  ): TickRecord {
    this.tickCount++
    return {
      id: randomUUID(),
      agentId: this.deps.config.id,
      tickNumber: this.tickCount,
      triggeredBy: trigger,
      startedAt: startedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      status,
      inputTokens,
      outputTokens,
      actionsExecuted,
      memoryOpsExecuted,
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
    }
  }
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)\s*(ms|s|m|h|d)$/)
  if (!match) return 60_000 // default 1 minute
  const [, n, unit] = match
  const ms: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }
  return parseInt(n!) * (ms[unit!] ?? 60_000)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m`
}
