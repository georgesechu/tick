// ============================================================
// Provider interfaces — the contracts that implementations fulfill
//
// The orchestrator depends ONLY on these interfaces.
// Swap any implementation without touching core logic.
// ============================================================

import type {
  LLMRequest, LLMResponse, TickOutput,
  MemoryEntry, MemoryIndexEntry, MemoryType, MemoryOpResult, MemoryOp,
  InboxItem, OutboxItem,
  ShellAction, ExecResult, ShellResult, BackgroundProcess,
  BrowseAction, BrowseResult, DownloadResult,
  ComputerStatus, TerminalInfo,
  TickRecord,
  TimeContext, TriggerReason, WaitAction,
  LLMMessage,
} from './types.js'

// --- LLM ---

/** Raw LLM completion — model-agnostic, knows nothing about ticks */
export interface LLMProvider {
  complete(request: LLMRequest): Promise<LLMResponse>
}

/** Parses raw LLM text into a validated TickOutput */
export interface TickOutputParser {
  parse(raw: string): TickOutput
}

// --- Memory ---

export interface MemoryStore {
  // Core CRUD
  get(key: string): Promise<MemoryEntry | null>
  set(params: {
    key: string; value: string; summary: string;
    type: MemoryType; pinned?: boolean; related?: string[]; ttl?: string
  }): Promise<void>
  delete(key: string): Promise<void>
  append(key: string, value: string): Promise<void>

  // Query
  list(prefix: string): Promise<MemoryEntry[]>
  search(query: string, limit: number): Promise<MemoryEntry[]>

  // Metadata
  pin(key: string): Promise<void>
  unpin(key: string): Promise<void>
  setTTL(key: string, ttl: string): Promise<void>

  // Versioning
  history(key: string): Promise<MemoryEntry[]>
  rollback(key: string, toVersion: number): Promise<void>

  // Context assembly
  getIndex(): Promise<MemoryIndexEntry[]>
  getPinned(): Promise<MemoryEntry[]>

  // Maintenance
  gc(): Promise<void>
}

/** Executes a batch of memory ops from a tick, returns results */
export interface MemoryOperationExecutor {
  execute(ops: MemoryOp[]): Promise<MemoryOpResult[]>
}

// --- Inbox / Outbox ---

export interface InboxStore {
  push(item: InboxItem): Promise<void>
  pushMany(items: InboxItem[]): Promise<void>
  fetch(options?: { limit?: number; budgetTokens?: number }): Promise<InboxItem[]>
  markRead(ids: string[]): Promise<void>
  getUnreadCount(): Promise<number>
}

export interface OutboxStore {
  enqueue(item: Pick<OutboxItem, 'channel' | 'to' | 'content' | 'attachments' | 'replyTo' | 'threadId'>): Promise<string>
  fetchPending(): Promise<OutboxItem[]>
  markSent(id: string): Promise<void>
  markFailed(id: string, error: string): Promise<void>
}

// --- Browser ---

export interface Browser {
  browse(action: BrowseAction): Promise<BrowseResult>
}

// --- Computer / Terminal ---

/** A machine the agent can execute commands on */
export interface Computer {
  readonly name: string
  readonly type: string        // 'local' | 'docker' | 'ssh'

  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<ComputerStatus>

  // Terminal management
  openTerminal(name: string): Promise<Terminal>
  getTerminal(name: string): Terminal | null
  listTerminals(): TerminalInfo[]
  closeTerminal(name: string): Promise<void>
}

/** A persistent shell session on a Computer */
export interface Terminal {
  readonly name: string
  readonly cwd: string

  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  kill(processId: string): Promise<void>
  getBackground(id: string): BackgroundProcess | null
  listBackground(): BackgroundProcess[]
}

export interface ExecOptions {
  timeout?: number
  mode?: 'sync' | 'background'
  stdin?: string
  env?: Record<string, string>
  label?: string
}

/** Manages all computers for an agent, routes shell actions */
export interface ComputerManager {
  /** Get a computer by name */
  get(name: string): Computer | undefined
  /** Get the default computer */
  default(): Computer
  /** List all computers */
  list(): Computer[]
  /** Execute a shell action (routes to correct computer/terminal) */
  exec(action: ShellAction): Promise<ExecResult>
  /** Get all terminal info across all computers (for prompt context) */
  allTerminals(): TerminalInfo[]
  /** Get all background processes across all computers */
  allBackground(): BackgroundProcess[]
  /** Start all computers */
  startAll(): Promise<void>
  /** Stop all computers */
  stopAll(): Promise<void>
}

// --- Channels ---

export interface ChannelAdapter {
  readonly name: string
  send(item: OutboxItem): Promise<void>
  downloadAttachment?(ref: string, targetPath: string): Promise<void>
  poll?(): Promise<InboxItem[]>
  start?(): Promise<void>
  stop?(): Promise<void>
}

// --- Scheduling ---

export interface Scheduler {
  /** Returns the trigger reason if a tick should fire, null otherwise */
  shouldTick(): Promise<TriggerReason | null>
  /** Record a completed tick for rate limiting / budgeting */
  recordTick(record: TickRecord): void
  /** Register a wake-up from the agent's wait action */
  scheduleWakeup(wait: WaitAction): void
  /** Notify that an external event arrived */
  notifyEvent(eventId: string): void
  /** Notify that a background process completed */
  notifyBackgroundComplete(processId: string): void
}

// --- Context Assembly ---

export interface ContextAssembler {
  assemble(state: AssemblyInput): Promise<LLMMessage[]>
}

export interface AssemblyInput {
  systemPrompt: string
  memoryIndex: MemoryIndexEntry[]
  pinnedMemories: MemoryEntry[]
  requestedMemories: MemoryEntry[]
  inbox: InboxItem[]
  lastScratchpad: string | null
  lastActionResults: MemoryOpResult[]
  lastShellResults: ShellResult[]
  lastDownloadResults: DownloadResult[]
  lastBrowseResults: BrowseResult[]
  terminals: TerminalInfo[]
  backgroundProcesses: BackgroundProcess[]
  time: TimeContext
}

// --- Tick Logging ---

export interface TickStore {
  save(record: TickRecord): Promise<void>
  getLast(agentId: string): Promise<TickRecord | null>
  list(agentId: string, limit: number): Promise<TickRecord[]>
}

// --- Clock (injectable for testing) ---

export interface Clock {
  now(): Date
}

// --- Logger ---

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}
