# tick

A background agentic system where LLMs operate via **ticks** — single invocations that receive state, produce structured decisions, and go back to sleep. The orchestrator runs persistently; the LLM doesn't.

## Quick Start

```bash
npm install
npx tsx src/index.ts run --agent agents/slack-agent
```

## Architecture

```
Orchestrator (persistent)
├── Scheduler     → decides when to invoke the LLM
├── Context       → assembles the prompt (memory, inbox, time, terminals)
├── LLM Call      → structured JSON output (actions, memory ops, scratchpad)
├── Executor      → shell, send, browse, download, wait
└── Stores        → memory (SQLite), inbox/outbox, tick log
```

### The Five Primitives

| Action | Purpose |
|--------|---------|
| `shell` | Execute commands on a Computer (local, Docker, SSH) |
| `send` | Message someone via a channel (Slack, WhatsApp) with optional file attachments |
| `browse` | Fetch a webpage as clean readable markdown |
| `download` | Save a channel attachment to a local file |
| `wait` | Schedule a timer (after duration, at specific time) |

### Memory System

- **Registers**: System prompt, scratchpad, memory index (always loaded)
- **Hot Memory**: Pinned values + last-tick get results (auto-loaded)
- **Memory Map**: Versioned key-value store with FTS search (agent-managed)
- **Auto-conversation**: Rolling `thread:recent` with last 10 messages (automatic)

Memory entries support `related` fields for cross-referencing.

## LLM Providers

Auto-detected from model name, or override with `TICK_LLM_PROVIDER`:

| Provider | Models | Env Var |
|----------|--------|---------|
| Anthropic | `claude-*` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-*`, `o1`, `o3`, `o4` | `OPENAI_API_KEY` |
| OpenCode Go | `deepseek-v4-flash`, `glm-5.1`, `mimo-v2.5-pro`, `kimi-k2.5`, ... | `OPENCODE_API_KEY` |
| x.ai | `grok-*` | `XAI_API_KEY` |
| Ollama | any | (local) |
| Custom URL | any | `TICK_LLM_API_KEY` |

## Computers

Agents execute commands on isolated computers:

```yaml
computers:
  sandbox:
    type: docker
    image: ubuntu:24.04
    memory: 2g
```

Implementations: `LocalComputer`, `DockerComputer` (SSH planned).

Terminals persist across ticks with cwd/env tracking.

## Channels

| Channel | Status | Features |
|---------|--------|----------|
| Slack | ✅ Working | Poll-based, file upload/download, DMs + channels |
| WhatsApp | ✅ Ready | Baileys (QR login), DMs + groups, media, typing indicator |

## Agent Configuration

```yaml
# agents/my-agent/agent.yaml
id: my-agent
name: My Agent
model: deepseek-v4-flash
systemPromptFile: system-prompt.md

tickPolicy:
  heartbeatInterval: 30s
  maxTicksPerHour: 60

computers:
  sandbox:
    type: docker
    image: ubuntu:24.04

channels:
  slack:
    botToken: ${SLACK_BOT_TOKEN}
    channels: [C0123456789]
  whatsapp:
    chats: []  # empty = all chats

seedMemory:
  self:identity: "Helpful assistant with shell access"
```

## CLI

```bash
# Run agent continuously
npx tsx src/index.ts run --agent agents/my-agent

# Single tick
npx tsx src/index.ts run-once --agent agents/my-agent

# Mind viewer (live dashboard in separate terminal)
npx tsx src/mind.ts --agent agents/my-agent
```

Mind viewer has 4 views: `[1]` Overview, `[2]` Memory detail, `[3]` Activity timeline, `[4]` Prompt reconstruction.

## Testing

```bash
npx vitest run     # 51 tests
npx vitest         # watch mode
```

## Project Structure

```
src/
  core/                    # Pure types + interfaces (zero deps)
    types.ts               # Domain model
    interfaces.ts          # Provider contracts
  providers/               # Swappable implementations
    llm/                   # Anthropic, OpenAI-compatible
    memory/                # SQLite with versioning + FTS
    computers/             # Local, Docker
    channels/              # Slack, WhatsApp
    browser.ts             # Readability-based web browser
  orchestrator/            # Core tick loop + context assembly
  mind.ts                  # Live TUI dashboard
agents/                    # Agent definitions
test/                      # Vitest test suite
```
