# Claude Bridge

OpenAI-compatible proxy for Claude, backed by a pool of local **Claude CLI**
workers with **MCP-based structured tool calling**. Lets any OpenAI-compatible
client (the OpenClaw matrix gateway, Hermes Agent, IDEs, agent frameworks) talk
to Claude through a Claude Max/Pro subscription — the bridge drives the `claude`
CLI, which owns the auth, so no API key or token extraction is required.

## Architecture

```
OpenAI client → Claude Bridge (:3456) → `claude` CLI (stream-json) → Anthropic
                      ↕
            OpenAI ↔ Claude translation
            in-process MCP HTTP server (structured tool calls)
```

The bridge spawns the official `claude` CLI with `--output-format stream-json`
and parses its event stream. Tool calls are exposed to the model through an
**in-process MCP server** so the model emits real structured `tool_use` blocks
(no XML-in-text). Two execution paths:

- **Path D (default, persistent sessions)** — when the request carries a
  session key (the OpenAI `user` field), it reuses a long-running `claude`
  process per session. The first turn with prior history primes the session by
  sending the full conversation as one user message; later turns deliver only
  the incremental message via native `tool_use`/`tool_result` — no XML re-injection
  each turn. Set `CLAUDE_BRIDGE_PATH_D=0` to disable and always spawn fresh.
- **Legacy (spawn-per-request)** — used when Path D is disabled or no session
  key is present. One `claude` subprocess per request.

## Features

- **Native tool calling** — MCP-registered structured tools, not XML injection
- **Real streaming** — incremental SSE tokens including tool-call streaming
- **Persistent sessions (Path D)** — reuse one CLI process per session key
- **Auto-retry** — fixed 2s/8s backoff (max 3 attempts) for *transient* failures
  only (timeouts, 5xx, overloaded/rate-limit, "out of extra usage"), and only
  before any byte has been streamed to the caller
- **Error-as-content guard** — the CLI sometimes prints an upstream failure
  (`API Error: 529 …`) as plain assistant text; the bridge detects this (any
  HTTP status, streaming or not) and surfaces it as a real error so callers
  retry/fallback instead of delivering the error as a chat reply
- **Per-request hints via headers** — `X-Bridge-Effort` and `X-Bridge-Ultracode`
- **Model aliases** — friendly ids mapped to the CLI's `--model` aliases
- **Vision support** — translates base64 image content between formats
- **Graceful shutdown** — drains in-flight CLIs, then SIGKILLs stragglers

## Requirements

- Node **22+**
- The `claude` CLI installed and authenticated (e.g. via Claude Max/Pro login).
  The bridge passes the parent environment through to the child, so a
  `claude`-recognized `ANTHROPIC_API_KEY` also works if set.

## Quick Start

```bash
npm install && npm run build
npm start            # listens on 127.0.0.1:3456 by default
```

Point your OpenAI-compatible client's base URL at `http://127.0.0.1:3456/v1`.

### Docker

> Note: the canonical deploy here is **native** (run via `bootstrap.sh`); the
> Docker path below is kept for portability but is not how this host runs.

```bash
docker build -t claude-bridge .
docker run -p 3456:3456 claude-bridge
```

The default bind is loopback (`127.0.0.1`); set `CLAUDE_BRIDGE_HOST=0.0.0.0`
explicitly if you need to expose it (e.g. inside a container/LAN).

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `CLAUDE_BRIDGE_PORT` | `3456` | Listen port |
| `CLAUDE_BRIDGE_HOST` | `127.0.0.1` | Bind address (loopback by default) |
| `CLAUDE_BRIDGE_TIMEOUT_MS` | `300000` | Per-request timeout (ms) |
| `CLAUDE_BRIDGE_MAX_CONCURRENT` | `8` | Max concurrent CLI workers (global) |
| `CLAUDE_BRIDGE_MAX_SESSIONS` | `200` | Legacy session-id LRU cap |
| `CLAUDE_BRIDGE_MAX_BODY_BYTES` | `67108864` | Max request body size (64 MiB) → 413 |
| `CLAUDE_BRIDGE_PATH_D` | `1` | Persistent sessions; `0` to disable |
| `CLAUDE_BRIDGE_MCP_PORT` | `0` | In-process MCP server port (`0` = ephemeral) |
| `CLAUDE_BRIDGE_IDLE_EVICT_MS` | `600000` | Tear down a Path-D session after this idle time |
| `CLAUDE_BRIDGE_MAX_LIFETIME_MS` | `3600000` | Max Path-D session lifetime before respawn |
| `CLAUDE_BRIDGE_MAX_PERSISTENT_SESSIONS` | `32` | Max simultaneous Path-D sessions |
| `CLAUDE_BRIDGE_PATHD_MAX_TURNS` | `16` | Max CLI turns per Path-D message |
| `CLAUDE_BRIDGE_DEBUG_PROMPT` | `0` | `1`/`true` logs full request+response payloads |
| `CLAUDE_BRIDGE_DEBUG_PROMPT_FILE` | `~/.openclaw/bridge-debug/claude-bridge-debug-YYYY-MM-DD.jsonl` | Debug log path |

Invalid numeric values (e.g. a typo like `5min`) fall back to the documented
default with a warning rather than silently disabling a limit.

### Per-request headers

| Header | Values | Effect |
|---|---|---|
| `X-Bridge-Effort` | `low`\|`medium`\|`high`\|`xhigh`\|`max` | CLI `--effort` passthrough |
| `X-Bridge-Ultracode` | `1`/`true` | Force `xhigh` + inject an ultracode system-reminder |

## Available Models

The bridge maps friendly ids to the `claude` CLI's `--model` aliases; the CLI
resolves each alias to whatever current Anthropic model it points at.

| Bridge ID (`/v1/models`) | CLI `--model` alias |
|---|---|
| `claude-opus-4` | `opus` |
| `claude-sonnet-4` | `sonnet` |
| `claude-haiku-4` | `haiku` |

Any unrecognized model id is passed through to the CLI verbatim.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health`, `/healthz` | GET | Health check + version |
| `/metrics` | GET | Queue depth, lifetime counts, avg latency (counts only, no content) |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |

## Debugging

Capture exactly what the bridge sent to the CLI when agents misbehave:

```bash
CLAUDE_BRIDGE_DEBUG_PROMPT=1 npm start
```

Each request appends two JSON-lines records to
`~/.openclaw/bridge-debug/claude-bridge-debug-YYYY-MM-DD.jsonl` (owner-only,
`0600`): a `phase: "request"` record (system-prompt length, hashed tool
schemas, the user content/messages) and a `phase: "response"` record (stop
reason, tool calls, a preview of assistant text).

```bash
grep '"sessionKey":"agent:veronica:..."' ~/.openclaw/bridge-debug/*.jsonl | jq .
```

**Off by default** — it adds I/O per request and the records contain raw
message bodies, so keep it disabled in normal operation.

## License

MIT
