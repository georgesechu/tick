import { randomUUID } from 'node:crypto'
import type {
  LLMProvider, TickOutputParser, MemoryStore, MemoryOperationExecutor,
  ContextAssembler, TickStore, Clock, Logger,
  ComputerManager, InboxStore, OutboxStore, ChannelAdapter, Browser,
} from '../core/interfaces.js'
import type { CallStore } from '../providers/call/types.js'
import type {
  AgentConfig, TickRecord, TickOutput, TickStatus,
  TimeContext, MemoryOpResult, MemoryEntry, ExecResult, DownloadResult, BrowseResult,
  GrepResult, GlobResult,
  TriggerReason,
} from '../core/types.js'

/** A summary of what the agent did in a single tick */
export interface ActionHistoryEntry {
  tickNumber: number
  status: string
  actions: Array<{
    type: string
    summary: string       // compact one-liner: "shell: git clone ... → exit:0" or "grep: pattern → 5 matches"
  }>
  memoryOps: Array<{
    op: string
    key: string
  }>
}

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
  media?: import('../providers/utilities/media.js').MediaService
  computers?: ComputerManager
  inbox?: InboxStore
  outbox?: OutboxStore
  channelAdapters?: ChannelAdapter[]
  callStore?: CallStore
}

export class Orchestrator {
  private lastScratchpad: string | null = null
  private lastMemoryResults: MemoryOpResult[] = []
  private lastShellResults: ExecResult[] = []
  private lastDownloadResults: DownloadResult[] = []
  private lastBrowseResults: BrowseResult[] = []
  private lastGrepResults: GrepResult[] = []
  private lastGlobResults: GlobResult[] = []
  private lastStatus: TickStatus = 'idle'
  private lastRequestedMemories: MemoryEntry[] = []
  private tickCount = 0
  private timers: Array<{ id: string; fireAt: number; reason: string }> = []
  private lastCallSegmentsSaved = 0   // tracks how many segments we've already persisted for the active call
  private lastCallId: string | null = null
  private consecutiveWorkingTicks = 0  // circuit breaker: detect infinite working loops
  private static readonly MAX_CONSECUTIVE_WORKING = 25  // force idle after this many consecutive "working" ticks (prevents infinite loops)

  // Rolling action history — last N ticks of tool usage, persists across ticks
  private static readonly ACTION_HISTORY_SIZE = 10
  private actionHistory: ActionHistoryEntry[] = []

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

    // Restore action history
    try {
      const saved = deps.stateStore?.get('actionHistory')
      if (saved) this.actionHistory = JSON.parse(saved)
    } catch { /* */ }
  }

  /** Check if there's any reason to tick — returns false if nothing has changed */
  async shouldTick(): Promise<boolean> {
    // Always tick if last tick was "working" (continuation)
    if (this.lastStatus === 'working') {
      this.deps.logger.debug('shouldTick: yes (working)')
      return true
    }

    // Check if any timers have fired
    if (this.hasFiredTimers()) {
      this.deps.logger.debug('shouldTick: yes (timer fired)')
      return true
    }

    // Always tick if there are pending results from last tick
    if (this.lastShellResults.length > 0) {
      this.deps.logger.debug('shouldTick: yes (shell results)')
      return true
    }
    if (this.lastDownloadResults.length > 0) return true
    if (this.lastBrowseResults.length > 0) return true
    if (this.lastGrepResults.length > 0) return true
    if (this.lastGlobResults.length > 0) return true
    if (this.lastMemoryResults.some(r => r.op === 'get')) {
      this.deps.logger.debug('shouldTick: yes (memory get results)')
      return true
    }

    // Tick if there are unread inbox items
    const unread = await this.deps.inbox?.getUnreadCount() ?? 0
    if (unread > 0) {
      this.deps.logger.debug('shouldTick: yes (unread inbox)', { unread })
      return true
    }

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
    const [index, pinned, rawInbox, lastTick] = await Promise.all([
      memory.getIndex(),
      memory.getPinned(),
      this.deps.inbox?.fetch() ?? Promise.resolve([]),
      tickStore.getLast(config.id),
    ])

    // Auto-process media attachments (transcribe audio, describe images)
    const inbox = await this.processMediaAttachments(rawInbox)

    const time = this.buildTimeContext(clock, lastTick)

    // 2. Fetch recently sent messages (prevents duplicate sends)
    const recentlySent = await this.deps.outbox?.fetchRecent(5) ?? []

    // 2b. Active call context
    const activeCall = this.deps.callStore?.getActiveCall() ?? null

    // Reset segment counter if call changed
    if (!activeCall || (this.lastCallId && this.lastCallId !== activeCall.callId)) {
      this.lastCallSegmentsSaved = 0
    }
    this.lastCallId = activeCall?.callId ?? null

    // 3. Assemble context
    const messages = await contextAssembler.assemble({
      systemPrompt: this.deps.systemPrompt,
      memoryIndex: index,
      pinnedMemories: pinned,
      requestedMemories: this.lastRequestedMemories,
      inbox,
      recentlySent,
      lastScratchpad: this.lastScratchpad,
      lastActionResults: this.lastMemoryResults,
      lastShellResults: this.lastShellResults,
      lastDownloadResults: this.lastDownloadResults,
      lastBrowseResults: this.lastBrowseResults,
      lastGrepResults: this.lastGrepResults,
      lastGlobResults: this.lastGlobResults,
      actionHistory: this.actionHistory,
      terminals: this.deps.computers?.allTerminals() ?? [],
      backgroundProcesses: this.deps.computers?.allBackground() ?? [],
      time,
      activeCall,
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

    // Log memory ops
    for (const r of memoryResults) {
      if (r.op === 'set') logger.info(`memory set "${r.key}"`, { success: r.success })
      else if (r.op === 'get') logger.info(`memory get "${r.key}"`, { success: r.success, found: !!r.data })
      else if (r.op === 'delete') logger.info(`memory delete "${r.key}"`, { success: r.success })
      else if (r.op === 'search') logger.info(`memory search`, { success: r.success, results: Array.isArray(r.data) ? r.data.length : 0 })
      else if (r.op === 'pin' || r.op === 'unpin') logger.info(`memory ${r.op} "${r.key}"`, { success: r.success })
      else if (!r.success) logger.warn(`memory ${r.op} "${r.key ?? ''}" failed`, { error: r.error })
    }

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
          // Log shell output (truncated for readability)
          if (result.stdout) {
            const lines = result.stdout.trimEnd().split('\n')
            const preview = lines.length <= 5 ? lines.join('\n') : [...lines.slice(0, 3), `  ... (${lines.length - 4} more lines)`, lines[lines.length - 1]!].join('\n')
            logger.info(`shell output`, { stdout: preview })
          }
          if (result.stderr) {
            logger.warn(`shell stderr`, { stderr: result.stderr.slice(0, 300) })
          }
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

    // 6c. Execute grep actions
    const grepResults: GrepResult[] = []
    if (this.deps.computers) {
      for (const action of output.actions) {
        if (action.type === 'grep') {
          const result = await this.executeGrep(action)
          grepResults.push(result)
          logger.info(`grep "${action.pattern}"`, {
            matches: result.matches.length,
            total: result.totalMatches,
            truncated: result.truncated,
          })
        }
      }
    }
    this.lastGrepResults = grepResults

    // 6d. Execute glob actions
    const globResults: GlobResult[] = []
    if (this.deps.computers) {
      for (const action of output.actions) {
        if (action.type === 'glob') {
          const result = await this.executeGlob(action)
          globResults.push(result)
          logger.info(`glob "${action.pattern}"`, {
            files: result.files.length,
            total: result.totalFiles,
            truncated: result.truncated,
          })
        }
      }
    }
    this.lastGlobResults = globResults

    // 6e. Tool memory policies — auto-store findings from tool results
    await this.applyToolMemoryPolicies(output.actions, shellResults, grepResults, globResults, browseResults)

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

    // 8. Mark inbox items as read — agent has seen them in its context
    //    Previously gated on hasSendActions, but that caused unread items to
    //    trigger every tick forever when the agent chose not to reply.
    if (this.deps.inbox && inbox.length > 0) {
      await this.deps.inbox.markRead(inbox.map(i => i.id))
    }

    // 8. Auto-maintain rolling conversation context
    //    This gives the agent free "short-term memory" without explicit memoryOps
    if (inbox.length > 0 || output.actions.some(a => a.type === 'send')) {
      await this.updateConversationMemory(inbox, output)
    }

    // 8b. Auto-save call transcripts to memory
    //     Like thread:recent, this gives the agent call content without explicit memoryOps.
    //     Each call gets a rolling transcript in memory; segments are appended as they arrive.
    if (activeCall && activeCall.totalSegments > 0) {
      await this.updateCallMemory(activeCall)
    }

    // 9. Store scratchpad and status (persisted to survive restarts)
    this.lastScratchpad = output.scratchpad

    // Track consecutive working ticks (for logging only — no circuit breaker)
    if (output.status === 'working') {
      this.consecutiveWorkingTicks++
      // Log milestones so we can see long runs in the logs
      if (this.consecutiveWorkingTicks % 10 === 0) {
        logger.info(`working streak: ${this.consecutiveWorkingTicks} consecutive ticks`)
      }
    } else {
      if (this.consecutiveWorkingTicks > 5) {
        logger.info(`working streak ended: ${this.consecutiveWorkingTicks} ticks`)
      }
      this.consecutiveWorkingTicks = 0
    }

    // Record action history for this tick
    const historyEntry: ActionHistoryEntry = {
      tickNumber: this.tickCount + 1,
      status: output.status,
      actions: [],
      memoryOps: output.memoryOps
        .filter(op => ['set', 'get', 'delete', 'pin', 'search'].includes(op.op))
        .map(op => ({ op: op.op, key: ('key' in op ? op.key : ('query' in op ? op.query : '')) as string })),
    }

    // Summarize shell actions
    for (let i = 0; i < output.actions.length; i++) {
      const action = output.actions[i]!
      if (action.type === 'shell') {
        const result = shellResults[historyEntry.actions.filter(a => a.type === 'shell').length]
        const cmd = action.command.slice(0, 80)
        const exit = result ? (result.exitCode === 0 ? 'OK' : `exit:${result.exitCode}`) : '?'
        const outPreview = result?.stdout ? ` → ${result.stdout.split('\n')[0]?.slice(0, 60) ?? ''}` : ''
        historyEntry.actions.push({ type: 'shell', summary: `${cmd} → ${exit}${outPreview}` })
      } else if (action.type === 'grep') {
        const result = grepResults[historyEntry.actions.filter(a => a.type === 'grep').length]
        historyEntry.actions.push({ type: 'grep', summary: `"${action.pattern}" path=${action.path ?? '.'} → ${result?.totalMatches ?? '?'} matches` })
      } else if (action.type === 'glob') {
        const result = globResults[historyEntry.actions.filter(a => a.type === 'glob').length]
        historyEntry.actions.push({ type: 'glob', summary: `"${action.pattern}" path=${action.path ?? '.'} → ${result?.totalFiles ?? '?'} files` })
      } else if (action.type === 'send') {
        historyEntry.actions.push({ type: 'send', summary: `→ ${action.to} (${action.channel}): ${action.content.slice(0, 60)}` })
      } else if (action.type === 'browse') {
        const result = browseResults[historyEntry.actions.filter(a => a.type === 'browse').length]
        historyEntry.actions.push({ type: 'browse', summary: `${action.url} → ${result?.success ? 'OK' : 'FAIL'}` })
      } else if (action.type === 'wait') {
        const until = typeof action.until === 'object' ? JSON.stringify(action.until) : action.until
        historyEntry.actions.push({ type: 'wait', summary: `until ${until}` })
      }
    }

    this.actionHistory.push(historyEntry)
    // Keep only last N entries
    while (this.actionHistory.length > Orchestrator.ACTION_HISTORY_SIZE) {
      this.actionHistory.shift()
    }

    this.lastStatus = output.status
    if (this.deps.stateStore) {
      this.deps.stateStore.set('scratchpad', output.scratchpad)
      this.deps.stateStore.set('lastStatus', output.status)
      this.deps.stateStore.set('tickCount', String(this.tickCount + 1))
      this.deps.stateStore.set('timers', JSON.stringify(this.timers))
      this.deps.stateStore.set('actionHistory', JSON.stringify(this.actionHistory))
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

  /**
   * Auto-save call transcripts to memory.
   * Stores a rolling transcript under call:{callId}:transcript (pinned while active).
   * Only appends new segments since last save to avoid rewriting the whole thing.
   */
  private async updateCallMemory(call: import('../providers/call/types.js').ActiveCallContext): Promise<void> {
    const { memory, logger, callStore } = this.deps
    if (!callStore) return

    const segments = callStore.getSegments(call.callId)
    if (segments.length <= this.lastCallSegmentsSaved) return

    // Get only the new segments
    const newSegments = segments.slice(this.lastCallSegmentsSaved)
    this.lastCallSegmentsSaved = segments.length

    const key = `call:${call.callId.slice(0, 8)}:transcript`

    if (this.lastCallSegmentsSaved === newSegments.length) {
      // First save — create the memory entry
      const value = newSegments.map((s, i) =>
        `[${s.createdAt}] ${s.transcript}`
      ).join('\n\n')

      await memory.set({
        key,
        value,
        summary: `Live call transcript — ${call.tabTitle} (${segments.length} segments)`,
        type: 'log',
        pinned: true,
      })
    } else {
      // Append new segments
      const appendValue = '\n\n' + newSegments.map(s =>
        `[${s.createdAt}] ${s.transcript}`
      ).join('\n\n')

      await memory.append(key, appendValue)
    }

    logger.info(`call transcript saved`, { callId: call.callId.slice(0, 8), segments: segments.length })
  }

  /** Process a wait action — schedule timers (deduplicates by fireAt) */
  private processWait(action: { type: 'wait'; until: any; onEvent?: string }, logger: any): void {
    const now = Date.now()

    if (typeof action.until === 'object' && 'after' in action.until) {
      const ms = parseDuration(action.until.after)
      const fireAt = now + ms
      // Deduplicate: skip if a timer within 60s of this one already exists
      const isDupe = this.timers.some(t => Math.abs(t.fireAt - fireAt) < 60_000)
      if (!isDupe) {
        this.timers.push({ id: `timer-${now}`, fireAt, reason: `after ${action.until.after}` })
        logger.info(`timer set: ${action.until.after}`, { fireAt: new Date(fireAt).toISOString() })
      }
    } else if (typeof action.until === 'object' && 'at' in action.until) {
      const fireAt = new Date(action.until.at).getTime()
      if (!isNaN(fireAt)) {
        // Deduplicate: skip if same time already scheduled
        const isDupe = this.timers.some(t => Math.abs(t.fireAt - fireAt) < 60_000)
        if (!isDupe) {
          this.timers.push({ id: `timer-${now}`, fireAt, reason: `at ${action.until.at}` })
          logger.info(`timer set: ${action.until.at}`, { fireAt: new Date(fireAt).toISOString() })
        }
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

  /**
   * Auto-process media attachments on inbox items:
   * - Audio files → transcribe with Whisper, append transcript to body
   * - Images → describe with GPT-4o vision, append description to body
   */
  private async processMediaAttachments(inbox: import('../core/types.js').InboxItem[]): Promise<import('../core/types.js').InboxItem[]> {
    const media = this.deps.media
    if (!media) return inbox
    if (!this.deps.channelAdapters) return inbox

    const { logger } = this.deps
    const tmpDir = '/tmp/tick-media'
    const { mkdirSync } = await import('node:fs')
    try { mkdirSync(tmpDir, { recursive: true }) } catch { /* */ }

    for (const item of inbox) {
      if (item.attachments.length === 0) continue

      for (const att of item.attachments) {
        const ext = att.name.split('.').pop()?.toLowerCase() ?? ''
        const isAudio = ['mp3', 'mp4', 'm4a', 'wav', 'webm', 'ogg', 'flac', 'aac'].includes(ext)
        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)

        if (!isAudio && !isImage) continue

        // Download the file
        const localPath = `${tmpDir}/${att.name}`
        const adapterName = att.ref.split(':')[0]
        const adapter = this.deps.channelAdapters?.find(a => a.name === adapterName)
        if (!adapter?.downloadAttachment) continue

        try {
          await adapter.downloadAttachment(att.ref, localPath)

          if (isAudio) {
            logger.info(`transcribing ${att.name}`)
            const transcript = await media.transcribe(localPath)
            item.body = item.body
              ? `${item.body}\n\n🎤 Voice note (${att.name}): "${transcript}"`
              : `🎤 Voice note (${att.name}): "${transcript}"`
          } else if (isImage) {
            logger.info(`describing ${att.name}`)
            const description = await media.describeImage(localPath)
            item.body = item.body
              ? `${item.body}\n\n🖼️ Image (${att.name}): ${description}`
              : `🖼️ Image (${att.name}): ${description}`
          }
        } catch (err) {
          logger.error(`media processing failed: ${att.name}`, { error: (err as Error).message })
        }
      }
    }

    return inbox
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

  /**
   * Execute a grep (text search) action via ripgrep on the agent's computer.
   * Falls back to `grep -rn` if `rg` isn't installed.
   */
  private async executeGrep(action: import('../core/types.js').GrepAction): Promise<GrepResult> {
    const maxResults = action.maxResults ?? 50
    const ctx = action.context ?? 0
    // Default to terminal's cwd (tracks agent's cd commands), not literally '.'
    const path = action.path ?? '.'

    // Build rg command with fallback
    const includeFlag = action.include ? `--glob '${action.include}'` : ''
    const contextFlag = ctx > 0 ? `-C ${ctx}` : ''
    // Use rg (ripgrep) with JSON output for structured parsing
    // Fallback to grep -rn if rg isn't available
    const cmd = `(command -v rg > /dev/null && rg --json -m ${maxResults} ${contextFlag} ${includeFlag} -- ${this.shellEscape(action.pattern)} ${this.shellEscape(path)} 2>/dev/null) || grep -rn ${contextFlag} ${includeFlag ? `--include=${this.shellEscape(action.include!)}` : ''} -m ${maxResults} -- ${this.shellEscape(action.pattern)} ${this.shellEscape(path)} 2>/dev/null`

    try {
      const result = await this.deps.computers!.exec({
        type: 'shell',
        command: cmd,
        mode: 'sync',
        computer: action.computer,
        timeout: '30s',
      })

      const matches: import('../core/types.js').GrepMatch[] = []
      const lines = result.stdout.trim().split('\n').filter(Boolean)

      // Try parsing as rg JSON first
      let isRgJson = false
      for (const line of lines) {
        if (matches.length >= maxResults) break
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'match') {
            isRgJson = true
            matches.push({
              file: obj.data?.path?.text ?? '',
              line: obj.data?.line_number ?? 0,
              text: (obj.data?.lines?.text ?? '').trimEnd(),
            })
          }
        } catch {
          // Not JSON — grep fallback format: file:line:text
          if (!isRgJson) {
            const m = line.match(/^(.+?):(\d+):(.*)$/)
            if (m) {
              matches.push({ file: m[1]!, line: parseInt(m[2]!), text: m[3]!.trimEnd() })
            }
          }
        }
      }

      return {
        pattern: action.pattern,
        matches,
        totalMatches: matches.length,
        truncated: matches.length >= maxResults,
        error: result.exitCode !== 0 && matches.length === 0 ? result.stderr.slice(0, 200) : null,
      }
    } catch (err) {
      return {
        pattern: action.pattern,
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: (err as Error).message,
      }
    }
  }

  /**
   * Execute a glob (file search) action via fd on the agent's computer.
   * Falls back to `find` if `fd` isn't installed.
   */
  private async executeGlob(action: import('../core/types.js').GlobAction): Promise<GlobResult> {
    const maxResults = action.maxResults ?? 100
    const path = action.path ?? '.'
    const ft = action.fileType ?? 'file'
    const typeFlag = ft === 'directory' ? '-t d' : ft === 'file' ? '-t f' : ''

    // Use fd (fast find) with fallback to find
    const cmd = `(command -v fd > /dev/null && fd ${typeFlag} --max-results ${maxResults} --glob ${this.shellEscape(action.pattern)} ${this.shellEscape(path)} 2>/dev/null) || find ${this.shellEscape(path)} ${ft === 'file' ? '-type f' : ft === 'directory' ? '-type d' : ''} -name ${this.shellEscape(action.pattern)} 2>/dev/null | head -n ${maxResults}`

    try {
      const result = await this.deps.computers!.exec({
        type: 'shell',
        command: cmd,
        mode: 'sync',
        computer: action.computer,
        timeout: '30s',
      })

      const files = result.stdout.trim().split('\n').filter(Boolean)
      const truncated = files.length >= maxResults

      return {
        pattern: action.pattern,
        files,
        totalFiles: files.length,
        truncated,
        error: result.exitCode !== 0 && files.length === 0 ? result.stderr.slice(0, 200) : null,
      }
    } catch (err) {
      return {
        pattern: action.pattern,
        files: [],
        totalFiles: 0,
        truncated: false,
        error: (err as Error).message,
      }
    }
  }

  /**
   * Tool memory policies — automatically store findings from tool results.
   *
   * Each tool type has a policy that decides what to store:
   * - grep: matches with file locations
   * - glob: file lists
   * - shell (read commands): file content summaries
   * - browse: page summaries
   *
   * Auto-stored entries use the `tool:` namespace, have type 'fact',
   * and a 2h TTL so they don't clutter memory permanently.
   */
  private async applyToolMemoryPolicies(
    actions: import('../core/types.js').Action[],
    shellResults: ExecResult[],
    grepResults: GrepResult[],
    globResults: GlobResult[],
    browseResults: BrowseResult[],
  ): Promise<void> {
    const { memory, logger } = this.deps

    let shellIdx = 0, grepIdx = 0, globIdx = 0, browseIdx = 0

    for (const action of actions) {
      try {
        if (action.type === 'grep') {
          const result = grepResults[grepIdx++]
          if (result && result.matches.length > 0) {
            const key = `tool:grep:${sanitizeKey(action.pattern)}`
            const matchSummary = result.matches.slice(0, 10).map(m => `${m.file}:${m.line}`).join(', ')
            const value = result.matches.slice(0, 20).map(m => `${m.file}:${m.line}: ${m.text}`).join('\n')
            await memory.set({
              key,
              value,
              summary: `grep "${action.pattern}" → ${result.totalMatches} matches in: ${matchSummary}`,
              type: 'fact',
              ttl: '2h',
            })
          }
        }

        else if (action.type === 'glob') {
          const result = globResults[globIdx++]
          if (result && result.files.length > 0) {
            const key = `tool:glob:${sanitizeKey(action.pattern)}`
            await memory.set({
              key,
              value: result.files.join('\n'),
              summary: `glob "${action.pattern}" → ${result.totalFiles} files`,
              type: 'fact',
              ttl: '2h',
            })
          }
        }

        else if (action.type === 'shell') {
          const result = shellResults[shellIdx++]
          if (result && result.exitCode === 0 && result.stdout) {
            // Only auto-store read-like commands
            const cmd = action.command.trim()
            const isRead = /^\s*(cat|head|tail|less|more|bat)\s/.test(cmd)
            const isList = /^\s*(ls|find|tree|du)\s/.test(cmd)
            const isInspect = /^\s*(file|wc|stat|md5sum|sha256sum)\s/.test(cmd)

            if (isRead) {
              // Extract the file path from the command
              const pathMatch = cmd.match(/(?:cat|head|tail|less|more|bat)\s+(.+?)(?:\s*[|;>&]|$)/)
              const filePath = pathMatch?.[1]?.trim().replace(/['"]/g, '') ?? 'unknown'
              const key = `tool:read:${sanitizeKey(filePath)}`
              const lines = result.stdout.split('\n')
              const preview = lines.length > 30
                ? [...lines.slice(0, 20), `... (${lines.length - 20} more lines)`].join('\n')
                : result.stdout
              await memory.set({
                key,
                value: preview,
                summary: `Read ${filePath} (${lines.length} lines)`,
                type: 'fact',
                ttl: '2h',
              })
            } else if (isList) {
              const pathMatch = cmd.match(/(?:ls|find|tree|du)\s+(.+?)(?:\s*[|;>&]|$)/)
              const dirPath = pathMatch?.[1]?.trim().replace(/['"]/g, '').replace(/-\w+\s*/g, '').trim() ?? '.'
              const key = `tool:ls:${sanitizeKey(dirPath)}`
              await memory.set({
                key,
                value: result.stdout.slice(0, 2000),
                summary: `Listed ${dirPath} → ${result.stdout.trim().split('\n').length} entries`,
                type: 'fact',
                ttl: '2h',
              })
            }
          }
        }

        else if (action.type === 'browse') {
          const result = browseResults[browseIdx++]
          if (result && result.success && result.content) {
            const url = new URL(action.url)
            const key = `tool:web:${sanitizeKey(url.hostname + url.pathname.slice(0, 40))}`
            await memory.set({
              key,
              value: result.content.slice(0, 3000),
              summary: `Browsed "${result.title}" (${url.hostname})`,
              type: 'fact',
              ttl: '2h',
            })
          }
        }
      } catch (err) {
        // Non-critical — don't break the tick if memory policy fails
        logger.debug('tool memory policy failed', { error: (err as Error).message })
      }
    }
  }

  private shellEscape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
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

/** Sanitize a string for use as a memory key segment — lowercase, no special chars */
function sanitizeKey(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9._\-\/]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
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
