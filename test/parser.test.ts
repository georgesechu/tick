import { describe, it, expect } from 'vitest'
import { ZodTickOutputParser } from '../src/providers/llm/parser.js'

const parser = new ZodTickOutputParser()

describe('TickOutputParser', () => {
  it('parses valid JSON', () => {
    const output = parser.parse(JSON.stringify({
      status: 'idle',
      thinking: 'Nothing to do',
      actions: [],
      memoryOps: [],
      scratchpad: 'All quiet',
    }))
    expect(output.status).toBe('idle')
    expect(output.thinking).toBe('Nothing to do')
    expect(output.scratchpad).toBe('All quiet')
  })

  it('extracts JSON from markdown code blocks', () => {
    const raw = '```json\n{"status":"done","thinking":"ok","actions":[],"memoryOps":[],"scratchpad":"x"}\n```'
    const output = parser.parse(raw)
    expect(output.status).toBe('done')
  })

  it('extracts JSON when model prefixes with reasoning text', () => {
    const raw = 'Let me think about this...\n\n{"status":"idle","thinking":"hmm","actions":[],"memoryOps":[],"scratchpad":"ok"}'
    const output = parser.parse(raw)
    expect(output.status).toBe('idle')
  })

  it('coerces number values to strings in memory ops', () => {
    const output = parser.parse(JSON.stringify({
      status: 'idle',
      thinking: 'incrementing',
      actions: [],
      memoryOps: [
        { op: 'set', key: 'counter', value: 42, summary: 'count', type: 'state' },
      ],
      scratchpad: 'done',
    }))
    expect(output.memoryOps[0]).toEqual(expect.objectContaining({ value: '42' }))
  })

  it('coerces boolean values to strings', () => {
    const output = parser.parse(JSON.stringify({
      status: 'idle',
      thinking: 'test',
      actions: [],
      memoryOps: [
        { op: 'set', key: 'flag', value: true, summary: 'a flag', type: 'state' },
      ],
      scratchpad: '',
    }))
    expect(output.memoryOps[0]).toEqual(expect.objectContaining({ value: 'true' }))
  })

  it('defaults empty arrays when actions/memoryOps missing', () => {
    const output = parser.parse(JSON.stringify({
      status: 'idle',
      thinking: 'nothing',
    }))
    expect(output.actions).toEqual([])
    expect(output.memoryOps).toEqual([])
    expect(output.scratchpad).toBe('')
  })

  it('parses shell actions', () => {
    const output = parser.parse(JSON.stringify({
      status: 'working',
      thinking: 'running tests',
      actions: [
        { type: 'shell', command: 'npm test', mode: 'sync', label: 'tests' },
      ],
      memoryOps: [],
      scratchpad: '',
    }))
    expect(output.actions).toHaveLength(1)
    expect(output.actions[0]).toEqual(expect.objectContaining({
      type: 'shell',
      command: 'npm test',
      mode: 'sync',
    }))
  })

  it('parses send actions', () => {
    const output = parser.parse(JSON.stringify({
      status: 'done',
      thinking: 'notifying',
      actions: [
        { type: 'send', channel: 'slack', to: 'user:george', content: 'Done!' },
      ],
      memoryOps: [],
      scratchpad: '',
    }))
    expect(output.actions[0]).toEqual(expect.objectContaining({
      type: 'send',
      channel: 'slack',
      to: 'user:george',
    }))
  })

  it('parses wait actions', () => {
    const output = parser.parse(JSON.stringify({
      status: 'idle',
      thinking: 'sleeping',
      actions: [
        { type: 'wait', until: { after: '5m' } },
      ],
      memoryOps: [],
      scratchpad: '',
    }))
    expect(output.actions[0]).toEqual(expect.objectContaining({
      type: 'wait',
      until: { after: '5m' },
    }))
  })

  it('rejects invalid status', () => {
    expect(() => parser.parse(JSON.stringify({
      status: 'running',
      thinking: '',
      actions: [],
      memoryOps: [],
      scratchpad: '',
    }))).toThrow()
  })

  it('filters out unknown action types gracefully', () => {
    const output = parser.parse(JSON.stringify({
      status: 'idle',
      thinking: '',
      actions: [
        { type: 'unknown', foo: 'bar' },
        { type: 'send', channel: 'slack', to: 'x', content: 'hi' },
      ],
      memoryOps: [],
      scratchpad: '',
    }))
    expect(output.actions).toHaveLength(1)
    expect(output.actions[0]!.type).toBe('send')
  })
})
