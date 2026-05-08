import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import YAML from 'yaml'
import type { AgentConfig, TickPolicy } from './core/types.js'

const DEFAULT_TICK_POLICY: TickPolicy = {
  maxTicksPerMinute: 10,
  debounceMs: 2000,
  urgentBypassesDebounce: true,
  idleCooldownMs: 60_000,
  maxTicksPerHour: 120,
  heartbeatInterval: '15m',
}

export function loadConfig(agentDir: string): { config: AgentConfig; systemPrompt: string } {
  const configPath = resolve(agentDir, 'agent.yaml')
  const raw = readFileSync(configPath, 'utf-8')
  const parsed = YAML.parse(raw)

  const config: AgentConfig = {
    id: parsed.id ?? 'default',
    name: parsed.name ?? parsed.id ?? 'Agent',
    model: parsed.model ?? 'claude-sonnet-4-20250514',  // override in agent.yaml
    systemPromptFile: parsed.systemPromptFile ?? 'system-prompt.md',
    pc: {
      preset: parsed.pc?.preset ?? 'base',
      cpu: parsed.pc?.cpu ?? 2,
      memory: parsed.pc?.memory ?? '4GB',
      disk: parsed.pc?.disk ?? '20GB',
      network: { outbound: parsed.pc?.network?.outbound ?? 'unrestricted' },
      additionalPackages: parsed.pc?.additionalPackages,
    },
    tickPolicy: { ...DEFAULT_TICK_POLICY, ...parsed.tickPolicy },
    channels: parsed.channels ?? {},
    triage: parsed.triage ?? [],
    outboxPolicies: parsed.outboxPolicies ?? [],
    seedMemory: parsed.seedMemory ?? {},
    ...(parsed.computers ? { computers: parsed.computers } : {}),
  } as AgentConfig & { computers?: Record<string, unknown> }

  const promptPath = resolve(dirname(configPath), config.systemPromptFile)
  const systemPrompt = readFileSync(promptPath, 'utf-8')

  return { config, systemPrompt }
}
