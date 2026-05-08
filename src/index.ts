import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Load .env from project root (zero-dep, no dotenv package needed)
try {
  const envPath = resolve(import.meta.dirname ?? '.', '..', '.env')
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]!]) process.env[match[1]!] = match[2]!
  }
} catch { /* no .env file, that's fine */ }

import { loadConfig } from './config.js'
import { openDatabase, migrate } from './providers/database.js'
import { SQLiteMemoryStore } from './providers/memory/sqlite.js'
import { DefaultMemoryOperationExecutor } from './providers/memory/executor.js'
import { AnthropicLLMProvider } from './providers/llm/anthropic.js'
import { OpenAICompatibleProvider } from './providers/llm/openai-compatible.js'
import { ZodTickOutputParser } from './providers/llm/parser.js'
import { SQLiteTickStore } from './providers/tick-store/sqlite.js'
import { SQLiteInboxStore } from './providers/inbox/sqlite.js'
import { SQLiteOutboxStore } from './providers/outbox/sqlite.js'
import { SlackChannelAdapter } from './providers/channels/slack.js'
import { WhatsAppChannelAdapter } from './providers/channels/whatsapp.js'
import { GmailChannelAdapter } from './providers/channels/gmail.js'
import { LocalComputer } from './providers/computers/local.js'
import { DockerComputer } from './providers/computers/docker.js'
import { DefaultComputerManager } from './providers/computers/manager.js'
import { SQLiteAgentStateStore } from './providers/state-store.js'
import { ReadableBrowser } from './providers/browser.js'
import { DefaultContextAssembler } from './orchestrator/context-assembler.js'
import { Orchestrator } from './orchestrator/orchestrator.js'
import { RealClock } from './providers/clock.js'
import { ConsoleLogger } from './providers/logger.js'
import type { LLMProvider, Logger, ChannelAdapter, OutboxStore, Computer } from './core/index.js'
import type { AgentConfig } from './core/types.js'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command !== 'run-once' && command !== 'run') {
    console.log('Usage: tick <run-once|run> --agent <path>')
    console.log('')
    console.log('Commands:')
    console.log('  run-once    Execute a single tick')
    console.log('  run         Run continuously (heartbeat loop)')
    console.log('')
    console.log('Options:')
    console.log('  --agent     Path to agent directory (e.g. agents/example)')
    console.log('  --db        Path to database file (default: <agent-dir>/tick.db)')
    process.exit(1)
  }

  const agentDir = resolve(getArg(args, '--agent') ?? 'agents/example')
  const dbPath = resolve(getArg(args, '--db') ?? `${agentDir}/tick.db`)

  // Load config
  const daemon = args.includes('--daemon') || !process.stdout.isTTY
  const { config, systemPrompt } = loadConfig(agentDir)
  const logger = new ConsoleLogger(config.id, daemon)

  logger.info(`loading agent "${config.name}" from ${agentDir}`)

  // Open database
  const db = openDatabase(dbPath)
  migrate(db)

  // Core stores
  const clock = new RealClock()
  const memory = new SQLiteMemoryStore(db)
  const memoryExecutor = new DefaultMemoryOperationExecutor(memory)
  const llm = createLLMProvider(config.model, logger)
  const parser = new ZodTickOutputParser()
  const tickStore = new SQLiteTickStore(db)
  const stateStore = new SQLiteAgentStateStore(db)
  const inbox = new SQLiteInboxStore(db)
  const outbox = new SQLiteOutboxStore(db)
  const contextAssembler = new DefaultContextAssembler()

  // Computers
  const computers = createComputers(config, logger)
  const computerManager = new DefaultComputerManager(computers)

  // Channel adapters
  const adapters = await createChannelAdapters(config.channels, logger)

  const orchestrator = new Orchestrator({
    config,
    systemPrompt,
    llm,
    parser,
    memory,
    memoryExecutor,
    contextAssembler,
    tickStore,
    clock,
    logger,
    stateStore,
    browser: new ReadableBrowser(),
    computers: computerManager,
    inbox,
    outbox,
    channelAdapters: adapters,
  })

  // Seed initial memory
  await orchestrator.seedMemory()

  // Start computers and channel adapters
  await computerManager.startAll()
  for (const adapter of adapters) {
    await adapter.start?.()
  }

  if (command === 'run-once') {
    await pollChannels(adapters, inbox, logger)
    const record = await orchestrator.runOnce()
    await drainOutbox(outbox, adapters, computerManager, logger)
    logger.info('tick complete', {
      tickNumber: record.tickNumber,
      status: record.status,
      durationMs: record.durationMs,
      tokens: { in: record.inputTokens, out: record.outputTokens },
    })
  } else if (command === 'run') {
    logger.info('starting continuous mode')

    const intervalMs = parseInterval(config.tickPolicy.heartbeatInterval ?? '15m')
    let running = true

    process.on('SIGINT', () => { running = false; logger.info('shutting down...') })
    process.on('SIGTERM', () => { running = false; logger.info('shutting down...') })

    while (running) {
      try {
        // Poll channels for new messages → inbox
        await pollChannels(adapters, inbox, logger)

        // Skip the LLM call if nothing has changed
        const hasWork = await orchestrator.shouldTick()
        if (!hasWork) {
          await drainOutbox(outbox, adapters, computerManager, logger)
          logger.debug('sleeping', { nextPoll: `${intervalMs / 1000}s` })
          if (running) await sleep(intervalMs)
          continue
        }

        // Run tick
        const record = await orchestrator.runOnce()

        // Drain outbox → channels
        await drainOutbox(outbox, adapters, computerManager, logger)

        // If agent says "working", tick again immediately
        if (record.status === 'working' && running) {
          continue
        }
      } catch (err) {
        logger.error('tick error', { error: (err as Error).message })
      }

      // Wait for heartbeat interval
      if (running) {
        await sleep(intervalMs)
      }
    }

    // Shutdown
    for (const adapter of adapters) {
      await adapter.stop?.()
    }
    await computerManager.stopAll()
    logger.info('stopped')
  }

  db.close()
}

// --- Computers ---

function createComputers(config: AgentConfig, logger: Logger): Computer[] {
  const computers: Computer[] = []
  const pcConfig = config.pc

  // Check for explicit computer definitions in channels config (temporary location)
  // TODO: move to a dedicated "computers" config section
  const computersConfig = (config as any).computers as Record<string, any> | undefined

  if (computersConfig) {
    for (const [name, cfg] of Object.entries(computersConfig)) {
      const type = cfg.type ?? 'local'
      if (type === 'docker') {
        computers.push(new DockerComputer({
          name,
          image: cfg.image,
          volumes: cfg.volumes,
          ports: cfg.ports,
          env: cfg.env,
          memory: cfg.memory,
          cpus: cfg.cpus,
          network: cfg.network,
        }))
        logger.info(`computer: ${name} (docker)`, { image: cfg.image })
      } else if (type === 'local') {
        computers.push(new LocalComputer(name, cfg.cwd ?? process.cwd()))
        logger.info(`computer: ${name} (local)`)
      }
    }
  }

  // Default to local if nothing configured
  if (computers.length === 0) {
    computers.push(new LocalComputer('local', process.cwd()))
    logger.info('computer: local (default)')
  }

  return computers
}

// --- Channel Adapters ---

async function createChannelAdapters(
  channels: Record<string, unknown>,
  logger: Logger,
): Promise<ChannelAdapter[]> {
  const adapters: ChannelAdapter[] = []

  if (channels.slack) {
    const cfg = channels.slack as Record<string, unknown>
    const botToken = resolveEnvVar(cfg.botToken as string) ?? process.env.SLACK_BOT_TOKEN
    if (botToken) {
      adapters.push(new SlackChannelAdapter({
        botToken,
        channels: (cfg.channels ?? []) as string[],
      }, logger))
    } else {
      logger.warn('slack configured but no bot token found (set SLACK_BOT_TOKEN)')
    }
  }

  if (channels.whatsapp) {
    const cfg = channels.whatsapp as Record<string, unknown>
    const agentDir = cfg.authDir as string | undefined
    adapters.push(new WhatsAppChannelAdapter({
      authDir: agentDir ?? '.whatsapp-auth',
      chats: (cfg.chats ?? []) as string[],
    }, logger))
  }

  if (channels.gmail) {
    const cfg = channels.gmail as Record<string, unknown>
    const email = resolveEnvVar(cfg.email as string) ?? process.env.GMAIL_ADDRESS
    const appPassword = resolveEnvVar(cfg.appPassword as string) ?? process.env.GMAIL_APP_PASSWORD
    if (email && appPassword) {
      adapters.push(new GmailChannelAdapter({
        email,
        appPassword,
        labels: (cfg.labels ?? ['INBOX']) as string[],
      }, logger))
    } else {
      logger.warn('gmail configured but missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD')
    }
  }

  return adapters
}

/** Resolve ${ENV_VAR} references in config values */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.match(/^\$\{(.+)\}$/)
  if (match) return process.env[match[1]!]
  return value
}

async function pollChannels(
  adapters: ChannelAdapter[],
  inbox: SQLiteInboxStore,
  logger: Logger,
): Promise<void> {
  for (const adapter of adapters) {
    if (!adapter.poll) continue
    try {
      const items = await adapter.poll()
      if (items.length > 0) {
        await inbox.pushMany(items)
        logger.info(`${adapter.name}: ${items.length} new messages`)
      }
    } catch (err) {
      logger.error(`${adapter.name} poll failed`, { error: (err as Error).message })
    }
  }
}

async function drainOutbox(
  outbox: OutboxStore,
  adapters: ChannelAdapter[],
  computers: DefaultComputerManager,
  logger: Logger,
): Promise<void> {
  const pending = await outbox.fetchPending()
  if (pending.length === 0) return

  const adapterMap = new Map(adapters.map(a => [a.name, a]))

  for (const item of pending) {
    const adapter = adapterMap.get(item.channel)
    if (!adapter) {
      await outbox.markFailed(item.id, `No adapter for channel: ${item.channel}`)
      logger.warn(`no adapter for channel: ${item.channel}`)
      continue
    }
    try {
      // Resolve file paths — copy from container if using Docker
      if (item.attachments.length > 0) {
        item.attachments = await resolveFilePaths(item.attachments, computers, logger)
      }
      await adapter.send(item)
      await outbox.markSent(item.id)
      logger.info(`${item.channel}: sent to ${item.to}`, { files: item.attachments.length || undefined })
    } catch (err) {
      await outbox.markFailed(item.id, (err as Error).message)
      logger.error(`${item.channel}: send failed`, { error: (err as Error).message })
    }
  }
}

/** Copy files from Docker containers to host /tmp so they can be uploaded */
async function resolveFilePaths(
  paths: string[],
  computers: DefaultComputerManager,
  logger: Logger,
): Promise<string[]> {
  const { execSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const resolved: string[] = []

  for (const filePath of paths) {
    // If file exists on host, use it directly
    if (existsSync(filePath)) {
      resolved.push(filePath)
      continue
    }

    // Try to copy from the default computer's Docker container
    const defaultComputer = computers.default()
    if (defaultComputer.type === 'docker') {
      const containerName = `tick-${defaultComputer.name}`
      const hostPath = `/tmp/tick-upload-${Date.now()}-${filePath.split('/').pop()}`
      try {
        execSync(`docker cp ${containerName}:${filePath} ${hostPath}`, { timeout: 10000 })
        logger.info(`copied from container: ${filePath} → ${hostPath}`)
        resolved.push(hostPath)
        continue
      } catch (err) {
        logger.error(`failed to copy from container: ${filePath}`, { error: (err as Error).message })
      }
    }

    // Fall through — use original path (will likely fail on upload)
    resolved.push(filePath)
  }

  return resolved
}

// --- LLM Provider Resolution ---

const PROVIDERS: Record<string, { envKey: string; baseUrl: string }> = {
  openai:       { envKey: 'OPENAI_API_KEY',      baseUrl: 'https://api.openai.com/v1' },
  'opencode-go': { envKey: 'OPENCODE_API_KEY',   baseUrl: 'https://opencode.ai/zen/go/v1' },
  xai:          { envKey: 'XAI_API_KEY',         baseUrl: 'https://api.x.ai/v1' },
  together:     { envKey: 'TOGETHER_API_KEY',    baseUrl: 'https://api.together.xyz/v1' },
  groq:         { envKey: 'GROQ_API_KEY',        baseUrl: 'https://api.groq.com/openai/v1' },
  fireworks:    { envKey: 'FIREWORKS_API_KEY',   baseUrl: 'https://api.fireworks.ai/inference/v1' },
  openrouter:   { envKey: 'OPENROUTER_API_KEY',  baseUrl: 'https://openrouter.ai/api/v1' },
  ollama:       { envKey: '',                    baseUrl: 'http://localhost:11434/v1' },
}

function createLLMProvider(model: string, logger: Logger): LLMProvider {
  const explicit = process.env.TICK_LLM_PROVIDER
  const provider = explicit ?? inferProvider(model)

  if (provider === 'anthropic') {
    logger.info(`llm provider: anthropic`)
    return new AnthropicLLMProvider(process.env.ANTHROPIC_API_KEY)
  }

  const entry = PROVIDERS[provider]
  if (entry) {
    const apiKey = entry.envKey ? process.env[entry.envKey] : 'ollama'
    if (!apiKey && entry.envKey) {
      throw new Error(`${entry.envKey} not set for provider "${provider}"`)
    }
    logger.info(`llm provider: ${provider}`, { baseUrl: entry.baseUrl })
    return new OpenAICompatibleProvider(entry.baseUrl, apiKey!)
  }

  if (explicit?.startsWith('http')) {
    const apiKey = process.env.TICK_LLM_API_KEY ?? ''
    logger.info(`llm provider: custom`, { baseUrl: explicit })
    return new OpenAICompatibleProvider(explicit, apiKey)
  }

  throw new Error(`Unknown LLM provider: "${provider}". Set TICK_LLM_PROVIDER to one of: anthropic, ${Object.keys(PROVIDERS).join(', ')}, or a URL`)
}

const OPENCODE_GO_MODELS = new Set([
  'deepseek-v4-flash', 'deepseek-v4-pro',
  'glm-5', 'glm-5.1',
  'kimi-k2.5', 'kimi-k2.6',
  'gpt-oss-120b',
  'mimo-v2.5-pro',
  'minimax-m2.7',
  'gemma-4-26b-a4b-it',
  'llama-3.3-70b-instruct', 'llama-4-maverick-17b-128e-instruct-fp8',
  'mistral-large-instruct-2411',
  'qwen3-coder-480b-a35b-instruct-int4-mixed-ar',
  'qwen3-next-80b-a3b-instruct',
  'qwen3.6-plus', 'qwen3.5-plus',
])

function inferProvider(model: string): string {
  if (OPENCODE_GO_MODELS.has(model)) return 'opencode-go'
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai'
  if (model.startsWith('grok')) return 'xai'
  if (model.startsWith('llama') || model.startsWith('meta-llama')) return 'together'
  if (model.includes('/')) return 'openrouter'
  return 'anthropic'
}

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

function parseInterval(s: string): number {
  const match = s.match(/^(\d+)([smh])$/)
  if (!match) return 60_000
  const [, n, unit] = match
  const ms = { s: 1000, m: 60_000, h: 3600_000 }
  return parseInt(n!) * ms[unit as keyof typeof ms]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
