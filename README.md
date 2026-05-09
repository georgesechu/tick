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

## TickCaller (Live Call Integration)

Chrome extension that captures tab audio + microphone during calls (Google Meet, Zoom, etc.) and streams 60-second transcription chunks to the agent. The agent sees an active call in its prompt and can contribute via Slack.

### Architecture

```
Chrome Extension (ext/tickcaller/)
  ├── popup.js     — one-button UI: "Call Johan" / "End Call"
  ├── background.js — service worker, tabCapture lifecycle
  ├── offscreen.js  — holds MediaStream + MediaRecorder, cycles every 60s
  └── options.js    — server URL + token config
         │
         │ HTTP POST (tab+mic audio chunks)
         ▼
Tick Call Server (:7070)
  ├── POST /call/start  → creates CallSession in SQLite
  ├── POST /call/chunk  → saves webm, transcribes via Whisper API
  ├── POST /call/stop   → finalizes session
  └── GET  /call/status → debug endpoint
         │
         │ signals eventSignal (wakes tick loop)
         ▼
Context Assembler
  └── ═══ ACTIVE CALL ═══
        George is on a live call — 12m 34s
        Tab: "Team Standup" (meet.google.com/abc-def)
        LATEST TRANSCRIPT (last ~60s): ...
      ═══════════════════════════════════════
```

### Setup

```bash
# .env — required
TICKCALLER_TOKEN=some-shared-secret     # auth token (shared with extension)
WHISPER_API_KEY=sk-...                  # OpenAI or Groq API key
WHISPER_BACKEND=openai                  # "openai" (default) or "groq"

# .env — optional
TICKCALLER_PORT=7070                    # default: 7070
```

1. Load `ext/tickcaller/` as unpacked extension in `chrome://extensions`
2. Open extension options → set Server URL to `http://localhost:7070` and Token to your `TICKCALLER_TOKEN`
3. Grant microphone access in the options page
4. Navigate to a call tab (Google Meet, etc.), click the extension → "Call Johan"

### Extension Files

| File | Role |
|------|------|
| `manifest.json` | MV3. Permissions: `tabCapture`, `offscreen`, `storage`, `activeTab` |
| `background.js` | Service worker. Gets `tabCapture.getMediaStreamId()`, manages offscreen document |
| `offscreen.js` | Holds MediaStream + MediaRecorder. Cycles recorders every 60s. Tab+mic mix via AudioContext |
| `popup.html/js/css` | One-button UI. Captures tab title/URL in popup context (activeTab scope) |
| `options.html/js` | Server URL + token + mic permission |

### Backend Files

| File | Role |
|------|------|
| `src/providers/call/types.ts` | `CallSession`, `CallSegment`, `ActiveCallContext`, `CallStore` interface |
| `src/providers/call/store.ts` | `SQLiteCallStore` — calls + segments tables, FTS5 transcript search |
| `src/providers/call/transcribe.ts` | Whisper API (OpenAI or Groq) — single fetch per chunk |
| `src/providers/call/server.ts` | HTTP server with multipart parser (no deps), token auth, CORS |

### Key Design Decisions

- **60s chunks** (vs agent-bridge's 2.5s) — agent ticks every 30s, so 60s chunks give fresh transcript every 1-2 ticks without hammering the API
- **Recorder cycling** (not timeslice) — `MediaRecorder.start(timeslice)` emits chunks without webm headers; cycling produces self-contained files any decoder handles
- **Tab audio un-muting** — `tabCapture` mutes the tab; we route through `AudioContext.destination` so the user still hears the meeting
- **Mic permission warming** — Chrome's permission prompt from offscreen docs auto-dismisses; we warm in the popup and fallback in options
- **Fire-and-forget stop** — background.js doesn't await offscreen stop response (popup can close mid-wait)

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
    call/                  # TickCaller: live call transcription
      types.ts             # CallSession, CallSegment, CallStore
      store.ts             # SQLite store (calls + segments + FTS)
      transcribe.ts        # Whisper API (OpenAI/Groq)
      server.ts            # HTTP server for extension
    browser.ts             # Readability-based web browser
  orchestrator/            # Core tick loop + context assembly
  mind.ts                  # Live TUI dashboard
ext/
  tickcaller/              # Chrome extension for live call capture
agents/                    # Agent definitions
test/                      # Vitest test suite
```
