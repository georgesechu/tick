// ============================================================
// Domain types — pure data, zero dependencies
// ============================================================

// --- Tick Output (what the LLM produces each tick) ---

export type TickStatus = 'working' | 'done' | 'blocked' | 'idle'

export type MemoryType =
  | 'fact' | 'state' | 'plan' | 'preference'
  | 'rule' | 'log' | 'relationship'

export interface ShellAction {
  type: 'shell'
  command: string
  computer?: string          // which computer (defaults to first configured)
  session?: string           // terminal session name (defaults to "default")
  mode: 'sync' | 'background'
  timeout?: string
  onTimeout?: 'kill' | 'background'
  stdin?: string
  env?: Record<string, string>
  label?: string
}

export interface SendAction {
  type: 'send'
  channel: string
  to: string
  content: string
  attachments?: string[]     // local file paths to upload with the message
  replyTo?: string
  threadId?: string
}

export interface DownloadAction {
  type: 'download'
  ref: string                // attachment ref from an inbox item
  path: string               // local path to save to
  computer?: string          // which computer (defaults to first)
}

export interface BrowseAction {
  type: 'browse'
  url: string
  mode?: 'readable' | 'screenshot' | 'raw'  // default: readable
  saveTo?: string            // for screenshot mode: local file path
}

export interface WaitAction {
  type: 'wait'
  until: 'immediate' | 'on_event' | { after: string } | { at: string }
  onEvent?: string
}

export type Action = ShellAction | SendAction | DownloadAction | BrowseAction | WaitAction

// --- Browse Results ---

export interface BrowseResult {
  url: string
  title: string
  content: string            // markdown (readable mode) or file path (screenshot)
  mode: string
  success: boolean
  error: string | null
}

export type MemoryOp =
  | { op: 'set'; key: string; value: string; summary: string; type: MemoryType; pinned?: boolean; related?: string[]; ttl?: string }
  | { op: 'get'; key: string }
  | { op: 'delete'; key: string }
  | { op: 'append'; key: string; value: string }
  | { op: 'list'; prefix: string }
  | { op: 'search'; query: string; limit: number }
  | { op: 'pin'; key: string }
  | { op: 'unpin'; key: string }
  | { op: 'set_ttl'; key: string; ttl: string }
  | { op: 'summarize_and_archive'; key: string }
  | { op: 'rollback'; key: string; toVersion: number }
  | { op: 'history'; key: string }

export interface TickOutput {
  status: TickStatus
  thinking: string
  actions: Action[]
  memoryOps: MemoryOp[]
  scratchpad: string
}

// --- Memory ---

export interface MemoryEntry {
  key: string
  value: string
  summary: string
  type: MemoryType
  pinned: boolean
  related: string[]          // keys of related memories
  ttl: string | null
  createdAt: string
  updatedAt: string
  version: number
  accessCount: number
  lastAccessed: string
}

export interface MemoryIndexEntry {
  key: string
  summary: string
  type: MemoryType
  pinned: boolean
  related: string[]
  updatedAt: string
}

export interface MemoryOpResult {
  op: string
  key?: string
  success: boolean
  data?: MemoryEntry | MemoryEntry[]
  error?: string
}

// --- Inbox ---

export type Priority = 'low' | 'normal' | 'high' | 'urgent'

export type InboxItemType =
  | 'message' | 'notification' | 'reaction' | 'mention'
  | 'scheduled' | 'internal' | 'command'

export interface Attachment {
  name: string
  mimeType: string
  size: number
  ref: string
}

export interface InboxItem {
  id: string
  sourceId: string
  channel: string
  threadId: string | null
  from: { id: string; name: string; channelHandle: string }
  subject: string | null
  body: string
  bodyTruncated: boolean
  attachments: Attachment[]
  timestamp: string
  priority: Priority
  type: InboxItemType
  replyTo: string | null
  threadSummary: string | null
  rawRef: string
}

// --- Outbox ---

export type OutboxStatus = 'pending' | 'approved' | 'sent' | 'failed'

export interface OutboxItem {
  id: string
  channel: string
  to: string
  content: string
  attachments: string[]      // local file paths to upload
  replyTo: string | null
  threadId: string | null
  status: OutboxStatus
  createdAt: string
  sentAt: string | null
  error: string | null
}

// --- Downloads ---

export interface DownloadResult {
  ref: string
  path: string
  success: boolean
  size: number | null
  error: string | null
}

// --- Computer / Terminal ---

export type ComputerStatus = 'running' | 'stopped' | 'unreachable'

export type ComputerType = 'local' | 'docker' | 'ssh'

export interface TerminalInfo {
  name: string
  computer: string
  cwd: string
  startedAt: string
  lastUsedAt: string
  commandCount: number
}

export interface ExecResult {
  id: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
  fullOutputRef: string | null
}

export type BackgroundStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface BackgroundProcess {
  id: string
  computer: string
  terminal: string
  command: string
  label: string | null
  startedAt: string
  status: BackgroundStatus
  result: ExecResult | null
}

// Legacy alias — used by context assembler and orchestrator
export type ShellResult = ExecResult

// --- Time ---

export interface Commitment {
  description: string
  dueBy: string
  sourceThread: string | null
  status: 'pending' | 'done' | 'overdue' | 'cancelled'
}

export interface TimeContext {
  now: string
  userTimezone: string
  lastTickAt: string | null
  timeSinceLastTick: string | null
  taskElapsed: string | null
  tickBudget: { used: number; limit: number; period: string }
  upcoming: Commitment[]
  overdue: Commitment[]
}

// --- Scheduling ---

export type TriggerReason =
  | { type: 'event'; eventId: string }
  | { type: 'timer'; scheduledAt: string }
  | { type: 'continuation' }
  | { type: 'heartbeat' }
  | { type: 'background_complete'; processId: string }

// --- Tick Record (logging) ---

export interface TickRecord {
  id: string
  agentId: string
  tickNumber: number
  triggeredBy: TriggerReason
  startedAt: string
  durationMs: number
  status: TickStatus
  inputTokens: number
  outputTokens: number
  actionsExecuted: number
  memoryOpsExecuted: number
  error: string | null
}

// --- LLM (provider-agnostic) ---

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LLMRequest {
  messages: LLMMessage[]
  model: string
  maxTokens?: number
  temperature?: number
}

export interface LLMResponse {
  content: string
  usage: { inputTokens: number; outputTokens: number }
}

// --- Agent Config ---

export interface AgentConfig {
  id: string
  name: string
  model: string
  systemPromptFile: string
  pc: PCConfig
  tickPolicy: TickPolicy
  channels: Record<string, ChannelConfig>
  triage: TriageRule[]
  outboxPolicies: OutboxPolicy[]
  seedMemory: Record<string, string>
}

export interface PCConfig {
  preset: string
  cpu: number
  memory: string
  disk: string
  network: { outbound: string }
  additionalPackages?: {
    apt?: string[]
    pip?: string[]
    npm?: string[]
  }
}

export interface TickPolicy {
  maxTicksPerMinute: number
  debounceMs: number
  urgentBypassesDebounce: boolean
  idleCooldownMs: number
  maxTicksPerHour: number
  heartbeatInterval: string | null
}

export interface ChannelConfig {
  [key: string]: unknown
}

export interface TriageRule {
  name: string
  match: {
    channel?: string
    from?: string
    type?: string
    subject?: string
    body?: string
    priority?: string
  }
  action:
    | { type: 'deliver'; priorityOverride?: string }
    | { type: 'hold' }
    | { type: 'batch'; window: string }
    | { type: 'drop' }
    | { type: 'auto_respond'; template: string }
    | { type: 'redirect'; to: string }
}

export interface OutboxPolicy {
  match: { channel?: string; to?: string }
  policy: {
    requireApproval?: string
    maxPerHour?: number
    quietHours?: { start: string; end: string; timezone: string }
  }
}
