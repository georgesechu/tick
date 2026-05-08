import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase, migrate } from '../src/providers/database.js'
import { SQLiteMemoryStore } from '../src/providers/memory/sqlite.js'
import { DefaultMemoryOperationExecutor } from '../src/providers/memory/executor.js'
import { SQLiteTickStore } from '../src/providers/tick-store/sqlite.js'
import { DefaultContextAssembler } from '../src/orchestrator/context-assembler.js'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import type { LLMProvider, TickOutputParser, Clock, Logger } from '../src/core/interfaces.js'
import type { LLMRequest, LLMResponse, TickOutput, AgentConfig, TickPolicy } from '../src/core/types.js'

// --- Test doubles ---

class MockLLMProvider implements LLMProvider {
  responses: LLMResponse[] = []
  calls: LLMRequest[] = []

  queueResponse(content: string, inputTokens = 100, outputTokens = 50) {
    this.responses.push({ content, usage: { inputTokens, outputTokens } })
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request)
    const response = this.responses.shift()
    if (!response) throw new Error('No mock response queued')
    return response
  }
}

class MockParser implements TickOutputParser {
  outputs: TickOutput[] = []

  queueOutput(output: Partial<TickOutput>) {
    this.outputs.push({
      status: 'idle',
      thinking: '',
      actions: [],
      memoryOps: [],
      scratchpad: '',
      ...output,
    })
  }

  parse(_raw: string): TickOutput {
    const output = this.outputs.shift()
    if (!output) throw new Error('No mock output queued')
    return output
  }
}

class FakeClock implements Clock {
  current = new Date('2026-05-08T12:00:00Z')
  now() { return this.current }
  advance(ms: number) { this.current = new Date(this.current.getTime() + ms) }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const DEFAULT_POLICY: TickPolicy = {
  maxTicksPerMinute: 10,
  debounceMs: 2000,
  urgentBypassesDebounce: true,
  idleCooldownMs: 60_000,
  maxTicksPerHour: 120,
  heartbeatInterval: '15m',
}

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'mock-model',
    systemPromptFile: 'system-prompt.md',
    pc: { preset: 'base', cpu: 2, memory: '4GB', disk: '20GB', network: { outbound: 'unrestricted' } },
    tickPolicy: DEFAULT_POLICY,
    channels: {},
    triage: [],
    outboxPolicies: [],
    seedMemory: { 'self:identity': 'I am a test agent' },
    ...overrides,
  }
}

// --- Tests ---

describe('Orchestrator', () => {
  let db: Database.Database
  let memory: SQLiteMemoryStore
  let memoryExecutor: DefaultMemoryOperationExecutor
  let tickStore: SQLiteTickStore
  let llm: MockLLMProvider
  let parser: MockParser
  let clock: FakeClock

  function createOrchestrator(configOverrides?: Partial<AgentConfig>) {
    return new Orchestrator({
      config: makeConfig(configOverrides),
      systemPrompt: 'You are a test agent.',
      llm,
      parser,
      memory,
      memoryExecutor,
      contextAssembler: new DefaultContextAssembler(),
      tickStore,
      clock,
      logger: silentLogger,
    })
  }

  beforeEach(() => {
    db = openDatabase(':memory:')
    migrate(db)
    memory = new SQLiteMemoryStore(db)
    memoryExecutor = new DefaultMemoryOperationExecutor(memory)
    tickStore = new SQLiteTickStore(db)
    llm = new MockLLMProvider()
    parser = new MockParser()
    clock = new FakeClock()
  })

  it('runs a tick end-to-end with memory ops', async () => {
    const orch = createOrchestrator()
    await orch.seedMemory()

    llm.queueResponse('mock-response')
    parser.queueOutput({
      status: 'idle',
      thinking: 'Initializing counter',
      memoryOps: [
        { op: 'set', key: 'state:counter', value: '1', summary: 'Counter: 1', type: 'state' },
      ],
      scratchpad: 'Counter initialized to 1',
    })

    const record = await orch.runOnce()

    expect(record.status).toBe('idle')
    expect(record.tickNumber).toBe(1)
    expect(record.actionsExecuted).toBe(0)
    expect(record.memoryOpsExecuted).toBe(1)

    // Verify memory was written
    const counter = await memory.get('state:counter')
    expect(counter).not.toBeNull()
    expect(counter!.value).toBe('1')
  })

  it('seeds memory only once', async () => {
    const orch = createOrchestrator()
    await orch.seedMemory()
    await orch.seedMemory() // should not overwrite

    const entry = await memory.get('self:identity')
    expect(entry!.version).toBe(1) // still v1, not re-seeded
  })

  it('passes context to LLM including memory index', async () => {
    const orch = createOrchestrator()
    await orch.seedMemory()

    llm.queueResponse('mock')
    parser.queueOutput({ status: 'idle', thinking: 'ok' })

    await orch.runOnce()

    // Verify the LLM received messages with memory index
    expect(llm.calls).toHaveLength(1)
    const userMsg = llm.calls[0]!.messages.find(m => m.role === 'user')
    expect(userMsg!.content).toContain('MEMORY INDEX')
    expect(userMsg!.content).toContain('self:identity')
  })

  it('includes time context in prompt', async () => {
    const orch = createOrchestrator()

    llm.queueResponse('mock')
    parser.queueOutput({ status: 'idle', thinking: 'ok' })

    await orch.runOnce()

    const userMsg = llm.calls[0]!.messages.find(m => m.role === 'user')
    expect(userMsg!.content).toContain('TIME')
    expect(userMsg!.content).toContain('2026-05-08')
  })

  it('records tick in tick store', async () => {
    const orch = createOrchestrator()

    llm.queueResponse('mock', 500, 200)
    parser.queueOutput({ status: 'done', thinking: 'finished' })

    await orch.runOnce()

    const lastTick = await tickStore.getLast('test-agent')
    expect(lastTick).not.toBeNull()
    expect(lastTick!.status).toBe('done')
    expect(lastTick!.inputTokens).toBe(500)
    expect(lastTick!.outputTokens).toBe(200)
  })

  it('carries scratchpad between ticks', async () => {
    const orch = createOrchestrator()

    // Tick 1: write scratchpad
    llm.queueResponse('mock')
    parser.queueOutput({ status: 'idle', thinking: 'first', scratchpad: 'Remember this!' })
    await orch.runOnce()

    // Tick 2: scratchpad should appear in context
    llm.queueResponse('mock')
    parser.queueOutput({ status: 'idle', thinking: 'second' })
    await orch.runOnce()

    const userMsg = llm.calls[1]!.messages.find(m => m.role === 'user')
    expect(userMsg!.content).toContain('Remember this!')
  })

  it('carries memory get results as hot memory in next tick', async () => {
    const orch = createOrchestrator()

    // Set up a memory entry
    await memory.set({ key: 'project:status', value: 'in progress', summary: 'Project status', type: 'state' })

    // Tick 1: get the memory entry
    llm.queueResponse('mock')
    parser.queueOutput({
      status: 'idle',
      thinking: 'loading',
      memoryOps: [{ op: 'get', key: 'project:status' }],
    })
    await orch.runOnce()

    // Tick 2: the loaded entry should appear as hot memory
    llm.queueResponse('mock')
    parser.queueOutput({ status: 'idle', thinking: 'ok' })
    await orch.runOnce()

    const userMsg = llm.calls[1]!.messages.find(m => m.role === 'user')
    expect(userMsg!.content).toContain('HOT MEMORY')
    expect(userMsg!.content).toContain('in progress')
  })
})
