import { z } from 'zod/v4'
import type { TickOutputParser } from '../../core/interfaces.js'
import type { TickOutput } from '../../core/types.js'

/** Coerce any value to string — LLMs output numbers, booleans, arrays, objects where strings are expected */
const coerceString = z.any().transform(v => {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(i => typeof i === 'string' ? i : JSON.stringify(i)).join('\n')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
})

const memoryTypeSchema = z.enum([
  'fact', 'state', 'plan', 'preference', 'rule', 'log', 'relationship',
])

const shellActionSchema = z.object({
  type: z.literal('shell'),
  command: z.string(),
  computer: z.string().optional(),
  session: z.string().optional(),
  mode: z.enum(['sync', 'background']).default('sync'),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.union([z.string(), z.number()]).transform(v => String(v)).optional(),
  onTimeout: z.enum(['kill', 'background']).optional(),
  stdin: z.string().optional(),
  label: z.string().optional(),
})

const sendActionSchema = z.object({
  type: z.literal('send'),
  channel: z.string(),
  to: z.string(),
  content: z.string().default(''),
  attachments: z.array(z.string()).optional(),
  replyTo: z.string().optional(),
  threadId: z.string().optional(),
})

const downloadActionSchema = z.object({
  type: z.literal('download'),
  ref: z.string(),
  path: z.string(),
  computer: z.string().optional(),
})

const waitActionSchema = z.object({
  type: z.literal('wait'),
  until: z.union([
    z.literal('immediate'),
    z.literal('on_event'),
    z.object({ after: z.string() }),
    z.object({ at: z.string() }),
  ]),
  onEvent: z.string().optional(),
})

const browseActionSchema = z.object({
  type: z.literal('browse'),
  url: z.string(),
  mode: z.enum(['readable', 'screenshot', 'raw']).default('readable'),
  saveTo: z.string().optional(),
})

const actionSchema = z.discriminatedUnion('type', [
  shellActionSchema,
  sendActionSchema,
  downloadActionSchema,
  browseActionSchema,
  waitActionSchema,
])

const memoryOpSchema = z.union([
  z.object({ op: z.literal('set'), key: z.string(), value: coerceString, summary: coerceString, type: memoryTypeSchema, pinned: z.boolean().optional(), related: z.array(z.string()).optional(), ttl: z.string().optional() }),
  z.object({ op: z.literal('get'), key: z.string() }),
  z.object({ op: z.literal('delete'), key: z.string() }),
  z.object({ op: z.literal('append'), key: z.string(), value: coerceString }),
  z.object({ op: z.literal('list'), prefix: z.string() }),
  z.object({ op: z.literal('search'), query: z.string(), limit: z.number() }),
  z.object({ op: z.literal('pin'), key: z.string() }),
  z.object({ op: z.literal('unpin'), key: z.string() }),
  z.object({ op: z.literal('set_ttl'), key: z.string(), ttl: z.string() }),
  z.object({ op: z.literal('summarize_and_archive'), key: z.string() }),
  z.object({ op: z.literal('rollback'), key: z.string(), toVersion: z.number() }),
  z.object({ op: z.literal('history'), key: z.string() }),
])

const tickOutputSchema = z.object({
  status: z.enum(['working', 'done', 'blocked', 'idle']),
  thinking: coerceString,
  actions: z.array(actionSchema).default([]),
  memoryOps: z.array(memoryOpSchema).default([]),
  scratchpad: coerceString.default(''),
})

export class ZodTickOutputParser implements TickOutputParser {
  parse(raw: string): TickOutput {
    // Handle empty response
    if (!raw || raw.trim().length === 0) {
      return { status: 'idle', thinking: 'LLM returned empty response', actions: [], memoryOps: [], scratchpad: '' }
    }

    const json = extractJSON(raw)

    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      // Try wrapping bare comma-separated objects as an array
      try {
        parsed = JSON.parse(`[${json}]`)
        // If it's an array of ops/actions, wrap in a TickOutput
        if (Array.isArray(parsed)) {
          parsed = wrapBareFragment(parsed)
        }
      } catch {
        // Try to salvage truncated JSON by closing open braces/brackets
        const repaired = repairJSON(json)
        if (repaired) {
          try { parsed = JSON.parse(repaired) } catch { /* */ }
        }
      }
      if (!parsed) {
        // Last resort: return idle tick instead of crashing
        return { status: 'working', thinking: 'LLM returned malformed output — retrying', actions: [], memoryOps: [], scratchpad: '' }
      }
    }

    // Pre-filter: drop actions with unknown types so one bad action doesn't crash the tick
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.actions)) {
      const validTypes = new Set(['shell', 'send', 'download', 'browse', 'wait'])
      obj.actions = obj.actions.filter((a: any) => a && validTypes.has(a.type))
    }

    return tickOutputSchema.parse(obj) as TickOutput
  }
}

/** Attempt to repair truncated JSON by closing open structures */
function repairJSON(json: string): string | null {
  let str = json.trimEnd()

  // Remove trailing comma
  str = str.replace(/,\s*$/, '')

  // Remove incomplete string at end (unmatched quote)
  const quoteCount = (str.match(/(?<!\\)"/g) || []).length
  if (quoteCount % 2 !== 0) {
    str = str.replace(/"[^"]*$/, '""')
  }

  // Count open/close braces and brackets
  let braces = 0
  let brackets = 0
  let inString = false

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '"' && (i === 0 || str[i - 1] !== '\\')) {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
  }

  // Close unclosed structures
  while (brackets > 0) { str += ']'; brackets-- }
  while (braces > 0) { str += '}'; braces-- }

  if (braces < 0 || brackets < 0) return null
  return str
}

/** Wrap bare fragments (array of ops or actions) into a valid TickOutput */
function wrapBareFragment(items: unknown[]): Record<string, unknown> {
  if (items.length === 0) return { status: 'idle', thinking: '', actions: [], memoryOps: [], scratchpad: '' }

  const first = items[0] as Record<string, unknown>

  // Array of memory ops
  if (first.op) {
    return { status: 'working', thinking: 'continuing', actions: [], memoryOps: items, scratchpad: '' }
  }

  // Array of actions
  if (first.type) {
    return { status: 'working', thinking: 'continuing', actions: items, memoryOps: [], scratchpad: '' }
  }

  return { status: 'idle', thinking: '', actions: [], memoryOps: [], scratchpad: '' }
}

/** Extract JSON from raw LLM output — handles markdown code blocks and reasoning prefixes */
function extractJSON(raw: string): string {
  const trimmed = raw.trim()

  // Try raw JSON first
  if (trimmed.startsWith('{')) return trimmed

  // Extract from ```json ... ``` blocks
  const match = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (match?.[1]) return match[1].trim()

  // Find first { and last } — handles models that prefix with reasoning text
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1)

  return trimmed
}
