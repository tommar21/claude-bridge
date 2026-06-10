import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { debugLog, hashString, newRequestId } from "./debug-logger.js";
import {
  couldBeErrorAsContent,
  ERROR_SNIFF_CHARS,
  isErrorAsContent,
} from "./error-as-content.js";
import type { BridgeMcpHttpServer, McpTool } from "./mcp-http.js";
import type { PersistentSessionPool } from "./session-pool.js";
import type { ContentBlock } from "./translate.js";
import {
  linesOf,
  parseStream,
  type StreamEventHandlers,
  type StreamToolUse,
} from "./stream-parser.js";

const MCP_SERVER_NAME = "openclaw";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SCRIPT = path.resolve(__dirname, "./mcp-server.js");

/**
 * System-reminder appended to the system prompt when the caller sets
 * X-Bridge-Ultracode: 1. Nudges the model to default to spawning parallel
 * subagents for substantive work — the bridge-side mirror of Claude.ai's
 * "ultracode mode". Kept generic so it applies to any tool surface the
 * model has (Task/Agent/Workflow). Don't enable this for scripted cron
 * agents that already know their plan; use only for "investigate heavy"
 * style turns where token-cost-vs-completeness should tilt to completeness.
 */
const ULTRACODE_REMINDER = `<system-reminder>
Ultracode mode is on. For any substantive task (research, analysis, multi-file edits, audits):
- Default to spawning parallel subagents when work can be decomposed
- Prioritize completeness and verification over token cost
- For multi-phase work, run discovery → design → implement → review in sequence; verify between phases
- Solo only on conversational turns or trivial mechanical edits

This reminder is sticky for the conversation.
</system-reminder>`;

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CLIRequest {
  prompt: string;
  lastMessage: string;
  model: string;
  systemPrompt?: string;
  tools: ToolDefinition[];
  sessionKey?: string;
  /** Optional CLI --effort passthrough. Allowed values: low|medium|high|xhigh|max.
   *  When omitted, the CLI uses its built-in default (currently medium). Higher
   *  effort = more thinking tokens = slower + costlier but better reasoning. */
  effort?: string;
  /** When true: force --effort xhigh AND append an ultracode system-reminder
   *  to the system prompt nudging the model to default to spawning parallel
   *  subagents for substantive work. Use for "investigate heavy" style turns;
   *  do NOT use for scripted cron agents that already know their plan. */
  ultracode?: boolean;
}

export interface CLIToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CLIResult {
  text: string;
  toolCalls: CLIToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  sessionId: string;
  rateLimitStatus: string | undefined;
  /** Resolved model version (e.g. "claude-opus-4-5-20251201") that the
   *  upstream CLI reported in its stream. Differs from `request.model`
   *  (a short alias like "opus") and from the OpenAI-shape `model` field
   *  in the response (which echoes the requested id like "claude-opus-4").
   *  `undefined` when the stream finished without emitting an assistant
   *  event (error before content, immediate tool_use, etc). */
  modelVersion: string | undefined;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface WorkerPoolConfig {
  timeoutMs: number;
  maxConcurrent: number;
  maxSessions: number;
}

let poolConfig: WorkerPoolConfig = {
  timeoutMs: 300_000,
  maxConcurrent: 8,
  maxSessions: 200,
};

export function configurePool(config: WorkerPoolConfig): void {
  poolConfig = config;
}

// ─── Path D wiring ──────────────────────────────────────────────────────────

interface PathDConfig {
  enabled: boolean;
  mcpServer: BridgeMcpHttpServer;
  sessionPool: PersistentSessionPool;
}

let pathDConfig: PathDConfig | null = null;

export function configurePathD(config: PathDConfig): void {
  pathDConfig = config;
}

export function isPathDEnabled(): boolean {
  return !!(pathDConfig && pathDConfig.enabled);
}

/** Request shape for Path D. Distinct from CLIRequest because the persistent
 *  path handles continuations (tool_result injection) differently. */
export interface PersistentCLIRequest {
  sessionKey: string;
  model: string;
  systemPrompt: string | undefined;
  tools: McpTool[];
  /** Content blocks for the latest user message (text, images, etc).
   *  Empty array when this is a pure continuation. */
  lastUserContent: ContentBlock[];
  /** If present, deliver this tool_result via the bridge MCP before reading
   *  the next checkpoint. Content is content-blocks (preserves structure). */
  pendingToolResult:
    | { toolUseId: string; content: ContentBlock[] }
    | null;
  /** XML-encoded full history. Used only when the persistent session is
   *  fresh. Sent as the first user message INSTEAD of lastUserContent. */
  primingPrompt: string | undefined;
  /** See CLIRequest.effort. */
  effort?: string;
  /** See CLIRequest.ultracode. */
  ultracode?: boolean;
}

function fingerprint(spec: {
  model: string;
  tools: McpTool[];
  systemPrompt: string | undefined;
  effort?: string;
}): string {
  const hash = createHash("sha256");
  hash.update(spec.model);
  hash.update("\0");
  hash.update(spec.systemPrompt ?? "");
  hash.update("\0");
  // Include effort so a request that changes effort mid-session triggers a
  // respawn. The CLI accepts --effort only at startup; reusing a session
  // started with --effort medium and ignoring a later xhigh request would
  // silently lose the requested behavior.
  hash.update(spec.effort ?? "");
  hash.update("\0");
  const sortedTools = [...spec.tools].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of sortedTools) {
    hash.update(t.name);
    hash.update("\0");
    hash.update(JSON.stringify(t.inputSchema));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Wrap stream handlers so the leading assistant text is buffered until we
 *  know it is NOT a CLI error-as-content line ("API Error: 400 ..."). If it
 *  IS one, the text is swallowed entirely: the caller's SSE stream stays
 *  uncommitted, the turn-level check throws, and retries / clean JSON 500s
 *  remain possible. Without this gate the error text streams out as normal
 *  deltas and poisons the response before we can classify it. */
function gateErrorAsContent(handlers: StreamEventHandlers | undefined): {
  handlers: StreamEventHandlers | undefined;
  /** Flush a held non-error prefix at end of turn (short replies). */
  finalize: () => void;
} {
  if (!handlers) return { handlers: undefined, finalize: () => {} };
  let buffer = "";
  let decided = false;
  let suppressed = false;
  const flushBuffer = () => {
    if (buffer) {
      handlers.onTextDelta?.(buffer);
      buffer = "";
    }
  };
  return {
    handlers: {
      onTextDelta: (d) => {
        if (suppressed) return; // swallow the rest of the error line
        if (decided) {
          handlers.onTextDelta?.(d);
          return;
        }
        buffer += d;
        if (couldBeErrorAsContent(buffer)) {
          if (buffer.length >= ERROR_SNIFF_CHARS && isErrorAsContent(buffer)) {
            suppressed = true;
            decided = true;
            buffer = "";
          }
          // else: still an ambiguous prefix — keep buffering.
          return;
        }
        decided = true;
        flushBuffer();
      },
      onToolUse: (t) => {
        // A tool_use means this is a real completion; release held text.
        if (!decided) {
          decided = true;
          flushBuffer();
        }
        handlers.onToolUse?.(t);
      },
    },
    finalize: () => {
      if (!decided && !isErrorAsContent(buffer)) {
        decided = true;
        flushBuffer();
      }
    },
  };
}

/** Path D entry point. Either sends a fresh user message on a reused
 *  session, or delivers a tool_result to a previously-captured tool_use
 *  and continues reading events. Returns once the CLI emits tool_use
 *  (partial turn — caller must execute the tool and retry) or `result`
 *  (final turn). */
export async function enqueuePersistent(
  request: PersistentCLIRequest,
  handlers?: StreamEventHandlers,
): Promise<CLIResult> {
  if (!pathDConfig || !pathDConfig.enabled) {
    throw new Error("Path D is not enabled");
  }
  const { mcpServer, sessionPool } = pathDConfig;

  // Per-session serialization is still required: two concurrent requests
  // for the same sessionKey would race on the CLI's stream.
  return serializeOnSession(request.sessionKey, async () => {
    await acquireSlot();
    log("info", "PathD queue", { active: inFlight, waiting: waiters.length });
    const requestId = newRequestId();
    metrics.totalRequests++;
    const startedAt = Date.now();
    try {
      // Resolve effort + ultracode. Ultracode overrides effort (forces xhigh)
      // and appends the ultracode reminder to the system prompt. Both are
      // baked into the spec fingerprint so a request that changes either
      // triggers a fresh session — the CLI accepts --effort + --system-prompt
      // only at startup.
      const effectiveEffort = request.ultracode
        ? "xhigh"
        : request.effort;
      const effectiveSystemPrompt = request.ultracode
        ? `${request.systemPrompt ?? ""}\n\n${ULTRACODE_REMINDER}`.trim()
        : request.systemPrompt;
      const spec_fp = fingerprint({
        model: request.model,
        tools: request.tools,
        systemPrompt: effectiveSystemPrompt,
        effort: effectiveEffort,
      });
      const acquireSpec = {
        model: request.model,
        tools: request.tools,
        systemPrompt: effectiveSystemPrompt,
        spec_fp,
        effort: effectiveEffort,
      };
      const acquired = sessionPool.acquire(request.sessionKey, acquireSpec);
      let session = acquired.session;
      let isFresh = acquired.isFresh;
      debugLog({
        requestId,
        phase: "request",
        path: "pathD",
        sessionKey: request.sessionKey,
        model: request.model,
        systemPromptLen: request.systemPrompt?.length ?? 0,
        systemPromptHash: hashString(request.systemPrompt ?? ""),
        tools: request.tools.map((t) => ({
          name: t.name,
          schemaHash: hashString(JSON.stringify(t.inputSchema)),
        })),
        lastUserContent: request.lastUserContent,
        pendingToolResult: request.pendingToolResult,
        isFresh,
        primingMode: isFresh && !!request.primingPrompt,
        primingPromptLen: request.primingPrompt?.length ?? 0,
      });

      if (isFresh && request.primingPrompt) {
        // First turn on a fresh session that has prior history. Send the full
        // XML-encoded history as one user message — the model's response IS the
        // answer to the user's latest question (which is included in the blob).
        // Subsequent turns are incremental + native.
        session.sendUserMessage([
          { type: "text", text: request.primingPrompt },
        ]);
      } else if (request.pendingToolResult) {
        // Continuation: try to resolve the parked MCP tools/call. If the
        // pending entry is missing (orphan — bridge restart, CLI death,
        // or session eviction between matrix receiving the tool_use and
        // sending the tool_result back), tear down the broken session and
        // re-prime with the full conversation history. The caller's
        // tool_result is included inside the priming XML blob, so the
        // model still sees it as conversational context.
        const resolved = mcpServer.tryResolveToolCall(
          request.sessionKey,
          request.pendingToolResult.toolUseId,
          request.pendingToolResult.content,
        );
        if (!resolved) {
          if (!request.primingPrompt) {
            // No priming context to recover with. Surface the original
            // error so the caller knows the session is unrecoverably
            // broken for this tool_result. Matrix-style retry will hit
            // the same error; right operator action is to reset.
            throw new Error(
              `no pending tool call: ${request.pendingToolResult.toolUseId}`,
            );
          }
          log("warn", "Orphan tool_result — respawning + re-priming", {
            sessionKey: request.sessionKey,
            toolUseId: request.pendingToolResult.toolUseId,
            requestId,
          });
          metrics.orphanRecoveries++;
          sessionPool.teardown(request.sessionKey);
          const reAcquired = sessionPool.acquire(request.sessionKey, acquireSpec);
          session = reAcquired.session;
          isFresh = reAcquired.isFresh;
          session.sendUserMessage([
            { type: "text", text: request.primingPrompt },
          ]);
        }
      } else {
        // Initial: feed the user message to stdin.
        session.sendUserMessage(request.lastUserContent);
      }

      const gate = gateErrorAsContent(handlers);
      const cp = await session.nextCheckpoint(gate.handlers, poolConfig.timeoutMs);
      gate.finalize();

      // If the stream gave us a tool_use, block briefly until the MCP
      // HTTP POST for it lands in the bridge's pending map. The two
      // signals (stream-json event vs MCP POST) are independent channels
      // and the stream usually wins by a few ms; without this gate, a
      // fast caller round-trips with a tool_result before pending exists
      // and resolveToolCall throws "no pending tool call".
      if (cp.toolUse) {
        await mcpServer.waitForPending(request.sessionKey, cp.toolUse.toolUseId);
      }

      const toolCalls: CLIToolCall[] = cp.toolUse
        ? [
            {
              id: cp.toolUse.toolUseId,
              name: cp.toolUse.name.startsWith("mcp__openclaw__")
                ? cp.toolUse.name.slice("mcp__openclaw__".length)
                : cp.toolUse.name,
              input: cp.toolUse.args,
            },
          ]
        : [];

      const stopReason =
        toolCalls.length > 0 ? "tool_use" : cp.result?.stopReason ?? "end_turn";
      if (cp.result?.isError && toolCalls.length === 0 && !cp.text) {
        throw new Error(`CLI error: ${cp.result.errorMessage ?? "unknown"}`);
      }
      // CLI printed an upstream API failure as assistant text (e.g.
      // "API Error: 400 ... out of extra usage"). Surface it as a real
      // error so callers retry/fallback instead of delivering the error
      // line as a chat reply. Tear the session down: its in-CLI history
      // now contains the failed turn and is not safely reusable.
      if (toolCalls.length === 0 && isErrorAsContent(cp.text)) {
        sessionPool.teardown(request.sessionKey);
        throw new Error(`CLI error-as-content: ${cp.text.slice(0, 300)}`);
      }

      metrics.successes++;
      metrics.latencyMsSum += Date.now() - startedAt;
      metrics.latencyMsCount++;
      debugLog({
        requestId,
        phase: "response",
        path: "pathD",
        stopReason,
        hasToolCalls: toolCalls.length > 0,
        toolCallNames: toolCalls.map((t) => t.name),
        textLen: cp.text.length,
        textPreview: cp.text.slice(0, 500),
        inputTokens: cp.result?.inputTokens ?? 0,
        outputTokens: cp.result?.outputTokens ?? 0,
      });
      return {
        text: cp.text,
        toolCalls,
        inputTokens: cp.result?.inputTokens ?? 0,
        outputTokens: cp.result?.outputTokens ?? 0,
        stopReason,
        sessionId: session.sessionId,
        rateLimitStatus: cp.result?.rateLimitStatus,
        modelVersion: cp.result?.modelVersion,
      };
    } catch (err) {
      metrics.failures++;
      throw err;
    } finally {
      releaseSlot();
    }
  });
}

// ─── Session Management ─────────────────────────────────────────────────────
// Maps OpenClaw session keys to CLI session UUIDs. LRU-evicted by insertion
// order: touching a key re-inserts it so the Map's iteration order becomes
// least-recently-used first.

const sessions = new Map<string, string>();

function touchSession(sessionKey: string, sessionId: string): void {
  sessions.delete(sessionKey);
  sessions.set(sessionKey, sessionId);
  while (sessions.size > poolConfig.maxSessions) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function getOrCreateSessionId(sessionKey: string | undefined): {
  sessionId: string;
  isNew: boolean;
} {
  if (!sessionKey) {
    return { sessionId: randomUUID(), isNew: true };
  }
  const existing = sessions.get(sessionKey);
  if (existing) {
    touchSession(sessionKey, existing);
    return { sessionId: existing, isNew: false };
  }
  const sessionId = randomUUID();
  touchSession(sessionKey, sessionId);
  return { sessionId, isNew: true };
}

// ─── Concurrency Limiter ────────────────────────────────────────────────────

let inFlight = 0;
const waiters: Array<() => void> = [];
// Track every live `claude` child process so graceful shutdown can drain
// in-flight work and kill whatever remains past the drain deadline. Using a
// Set (not a count) because we need actual process refs to kill on timeout.
const activeProcs = new Set<ChildProcess>();

// Per-session serialization. Two concurrent requests on the same sessionKey
// would both spawn `claude --resume <id>` against the same on-disk session,
// and whichever finishes last clobbers the other's work. Chain them instead:
// each request on a session awaits the previous one before proceeding.
// Keyed by sessionKey; the stored Promise resolves when the current holder
// finishes (success or failure). We clean up when the tail matches so the
// map doesn't grow forever.
const sessionTail = new Map<string, Promise<unknown>>();

function serializeOnSession<T>(
  sessionKey: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sessionKey) return fn();
  const prior = sessionTail.get(sessionKey) ?? Promise.resolve();
  const run = prior.then(
    () => fn(),
    () => fn(), // prior failure shouldn't block us
  );
  sessionTail.set(sessionKey, run);
  const cleanup = () => {
    if (sessionTail.get(sessionKey) === run) sessionTail.delete(sessionKey);
  };
  run.then(cleanup, cleanup);
  return run;
}

async function acquireSlot(): Promise<void> {
  while (inFlight >= poolConfig.maxConcurrent) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

// ─── MCP Config ─────────────────────────────────────────────────────────────

interface McpConfigFiles {
  configPath: string;
  cleanup: () => void;
}

function writeMcpConfig(tools: ToolDefinition[]): McpConfigFiles {
  const id = randomUUID();
  const toolsPath = path.join(os.tmpdir(), `bridge-tools-${id}.json`);
  const configPath = path.join(os.tmpdir(), `bridge-mcp-${id}.json`);
  fs.writeFileSync(toolsPath, JSON.stringify(tools));
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: "node",
          args: [MCP_SERVER_SCRIPT, toolsPath],
        },
      },
    }),
  );
  return {
    configPath,
    cleanup: () => {
      try {
        fs.unlinkSync(toolsPath);
      } catch {}
      try {
        fs.unlinkSync(configPath);
      } catch {}
    },
  };
}

const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function stripMcpPrefix(tu: StreamToolUse): CLIToolCall {
  const name = tu.name.startsWith(MCP_PREFIX)
    ? tu.name.slice(MCP_PREFIX.length)
    : tu.name;
  return { id: tu.id, name, input: tu.input };
}

// ─── Request Execution ──────────────────────────────────────────────────────

// ─── Transient-error retry ──────────────────────────────────────────────────

// Conservative: only retry errors we can be confident come from transport
// flakiness (CLI timeout, network reset, 5xx upstream). Logical errors
// (wrong model name, invalid arg) must surface immediately so the caller
// fixes the request instead of hammering the same bad input 3 times.
const TRANSIENT_PATTERNS = [
  /CLI timeout after/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /network\s+error/i,
  /\b5\d{2}\b/, // 500-599 upstream
  /rate.?limit/i,
  /overloaded/i,
  // claude.ai Max quota exhaustion surfaced by the CLI as content; proven
  // to recover within seconds (rolling-window quota), so worth retrying.
  /out of extra usage/i,
];

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

async function runCLIWithRetry(
  request: CLIRequest,
  handlers?: StreamEventHandlers,
): Promise<CLIResult> {
  const maxAttempts = 3;
  // Observed quota windows ("out of extra usage") last seconds to ~2min;
  // 0.5s/1.5s retries all landed inside the same bad window. 2s/8s still
  // bounds added latency at ~10s worst-case while clearing short windows.
  const backoffMs = [2000, 8000]; // wait before attempt 2, 3
  let lastErr: unknown;
  // If we've already streamed any bytes to the caller, a retry would emit a
  // second leading assistant turn into the same SSE stream — confusing for
  // the client and arguably worse than just failing. Track a "committed"
  // flag: once any text/tool has hit the handler, retries are off.
  let committed = false;
  const trackedHandlers: StreamEventHandlers | undefined = handlers
    ? {
        onTextDelta: (d) => {
          committed = true;
          handlers.onTextDelta?.(d);
        },
        onToolUse: (t) => {
          committed = true;
          handlers.onToolUse?.(t);
        },
      }
    : undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runCLI(request, trackedHandlers);
    } catch (err) {
      lastErr = err;
      const canRetry =
        attempt < maxAttempts && !committed && isTransient(err);
      if (!canRetry) throw err;
      metrics.retries++;
      const wait = backoffMs[attempt - 1] ?? 1500;
      log("warn", "CLI transient error, retrying", {
        attempt,
        wait,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr; // unreachable, keeps TS happy
}

export async function enqueueRequest(
  request: CLIRequest,
  handlers?: StreamEventHandlers,
): Promise<CLIResult> {
  // Per-session serialization first, then global concurrency. Order matters:
  // if two requests on session X arrive while a third on session Y runs, Y
  // goes parallel to the first X; the second X waits for the first X to
  // finish before consuming a concurrency slot.
  return serializeOnSession(request.sessionKey, async () => {
    await acquireSlot();
    log("info", "Queue", { active: inFlight, waiting: waiters.length });
    metrics.totalRequests++;
    const startedAt = Date.now();
    try {
      const result = await runCLIWithRetry(request, handlers);
      metrics.successes++;
      metrics.latencyMsSum += Date.now() - startedAt;
      metrics.latencyMsCount++;
      return result;
    } catch (err) {
      metrics.failures++;
      throw err;
    } finally {
      releaseSlot();
    }
  });
}

async function runCLI(
  request: CLIRequest,
  handlers?: StreamEventHandlers,
): Promise<CLIResult> {
  const { sessionId, isNew } = getOrCreateSessionId(request.sessionKey);
  const hasTools = request.tools.length > 0;

  // Resolve effort + ultracode the same way Path D does. Ultracode forces
  // xhigh effort and appends the ultracode reminder to the system prompt.
  // For the legacy path the system prompt augmentation only matters on a
  // fresh session — once resumed, --system-prompt is ignored by the CLI.
  const effectiveEffort = request.ultracode ? "xhigh" : request.effort;
  const effectiveSystemPrompt = request.ultracode && request.systemPrompt !== undefined
    ? `${request.systemPrompt}\n\n${ULTRACODE_REMINDER}`.trim()
    : request.ultracode
      ? ULTRACODE_REMINDER
      : request.systemPrompt;

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    request.model,
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
  ];
  if (effectiveEffort) {
    args.push("--effort", effectiveEffort);
  }

  let mcpCleanup: (() => void) | undefined;
  if (hasTools) {
    const mcp = writeMcpConfig(request.tools);
    args.push("--mcp-config", mcp.configPath);
    mcpCleanup = mcp.cleanup;
  } else {
    args.push("--mcp-config", JSON.stringify({ mcpServers: {} }));
  }

  if (isNew) {
    args.push("--session-id", sessionId);
    if (effectiveSystemPrompt) {
      args.push("--system-prompt", effectiveSystemPrompt);
    }
  } else {
    args.push("--resume", sessionId);
  }

  const promptToSend = isNew ? request.prompt : request.lastMessage;

  log("info", "CLI spawn", {
    sessionId: sessionId.slice(0, 8),
    isNew,
    model: request.model,
    toolCount: request.tools.length,
    promptLen: promptToSend.length,
  });

  const requestId = newRequestId();
  debugLog({
    requestId,
    phase: "request",
    path: "legacy",
    sessionKey: request.sessionKey,
    model: request.model,
    systemPromptLen: request.systemPrompt?.length ?? 0,
    systemPromptHash: hashString(request.systemPrompt ?? ""),
    tools: request.tools.map((t) => ({
      name: t.name,
      schemaHash: hashString(JSON.stringify(t.inputSchema)),
    })),
    prompt: promptToSend,
    isNew,
  });

  const proc = spawn("claude", args, {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeProcs.add(proc);
  proc.once("close", () => activeProcs.delete(proc));

  proc.stdin?.write(promptToSend);
  proc.stdin?.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    if (request.sessionKey) sessions.delete(request.sessionKey);
  }, poolConfig.timeoutMs);

  try {
    const gate = gateErrorAsContent(handlers);
    const [parsed, exitCode, stderrText] = await Promise.all([
      parseStream(linesOf(proc.stdout!), gate.handlers),
      new Promise<number | null>((resolve) =>
        proc.on("close", (code) => resolve(code)),
      ),
      collectStream(proc.stderr!),
    ]);
    gate.finalize();

    if (timedOut) {
      throw new Error(`CLI timeout after ${poolConfig.timeoutMs}ms`);
    }

    const toolCalls = parsed.toolUses.map(stripMcpPrefix);
    const stopReason =
      toolCalls.length > 0 ? "tool_use" : parsed.stopReason;

    if (parsed.isError && toolCalls.length === 0 && !parsed.text) {
      const hint = parsed.errorMessage ?? `exit ${exitCode}`;
      const stderrHint = stderrText.slice(0, 300);
      if (request.sessionKey) sessions.delete(request.sessionKey);
      throw new Error(`CLI error: ${hint}${stderrHint ? ` | stderr: ${stderrHint}` : ""}`);
    }

    // Upstream API failure printed as assistant text by the CLI (the
    // out-of-extra-usage / overloaded class). Throw so runCLIWithRetry can
    // retry it as transient; the streaming gate above guarantees nothing
    // was forwarded to the caller, so a retry emits a clean fresh turn.
    if (toolCalls.length === 0 && isErrorAsContent(parsed.text)) {
      if (request.sessionKey) sessions.delete(request.sessionKey);
      throw new Error(`CLI error-as-content: ${parsed.text.slice(0, 300)}`);
    }

    if (exitCode !== 0 && toolCalls.length === 0 && !parsed.text) {
      if (request.sessionKey) sessions.delete(request.sessionKey);
      throw new Error(
        `CLI exited ${exitCode}: ${stderrText.slice(0, 500)}`,
      );
    }

    debugLog({
      requestId,
      phase: "response",
      path: "legacy",
      stopReason,
      hasToolCalls: toolCalls.length > 0,
      toolCallNames: toolCalls.map((t) => t.name),
      textLen: parsed.text.length,
      textPreview: parsed.text.slice(0, 500),
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    });
    return {
      text: parsed.text,
      toolCalls,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      stopReason,
      sessionId,
      rateLimitStatus: parsed.rateLimitStatus,
      modelVersion: parsed.modelVersion,
    };
  } finally {
    clearTimeout(timer);
    mcpCleanup?.();
  }
}

// ─── Rate-limit tracker ─────────────────────────────────────────────────────
// Latest rate_limit_event seen from any in-flight session. Surfaces via
// getMetrics() so the UI can warn the user before they fire a costly
// cron. Captures the raw status string ("standard", "warning", "approaching",
// "exhausted") + when it landed, so callers can age out stale data.

let latestRateLimit: { status: string; updatedAtMs: number } | null = null;

/**
 * Record a rate_limit_event status from a finished CLI worker. Called by
 * the session-pool path after each model invocation that streamed one.
 * Safe to call with `undefined` — those are ignored so the previous good
 * status sticks until something fresher arrives.
 */
export function recordRateLimitStatus(status: string | undefined): void {
  if (!status) return;
  latestRateLimit = { status, updatedAtMs: Date.now() };
}

export function getLatestRateLimit(): {
  status: string;
  updatedAtMs: number;
  ageMs: number;
} | null {
  if (!latestRateLimit) return null;
  return {
    status: latestRateLimit.status,
    updatedAtMs: latestRateLimit.updatedAtMs,
    ageMs: Date.now() - latestRateLimit.updatedAtMs,
  };
}

// ─── Resolved model version tracker ─────────────────────────────────────────
// For each model slug we serve (claude-opus-4, claude-sonnet-4, claude-haiku-4),
// remember the latest resolved upstream version we've seen in any assistant
// event. Surfaces via getMetrics() so the UI / monitoring can show "opus is
// currently serving 4-5-20251201 (last seen 2m ago)" — useful for catching
// silent upstream version flips that change behavior under a stable slug.

const latestResolvedModels = new Map<
  string,
  { version: string; updatedAtMs: number }
>();

/**
 * Record the resolved model version reported by the CLI on its assistant
 * event for a request that asked for `slug`. Safe to call with `undefined`
 * version — those are ignored so the last good entry sticks.
 */
export function recordResolvedModel(
  slug: string,
  version: string | undefined,
): void {
  if (!version) return;
  latestResolvedModels.set(slug, { version, updatedAtMs: Date.now() });
}

export function getResolvedModels(): Record<
  string,
  { version: string; updatedAtMs: number; ageMs: number }
> {
  const out: Record<
    string,
    { version: string; updatedAtMs: number; ageMs: number }
  > = {};
  const now = Date.now();
  for (const [slug, entry] of latestResolvedModels) {
    out[slug] = {
      version: entry.version,
      updatedAtMs: entry.updatedAtMs,
      ageMs: now - entry.updatedAtMs,
    };
  }
  return out;
}

async function collectStream(
  readable: NodeJS.ReadableStream,
): Promise<string> {
  let data = "";
  for await (const chunk of readable) {
    data += (chunk as Buffer).toString("utf-8");
  }
  return data;
}

// ─── Metrics ────────────────────────────────────────────────────────────────

const metrics = {
  totalRequests: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  // Path D orphan tool_result recoveries: matrix delivered a tool_result
  // for a toolUseId the bridge no longer has pending (bridge restart, CLI
  // death, session eviction). We tear down + respawn + re-prime instead of
  // surfacing a 500. This counter shows how often that path is taken.
  orphanRecoveries: 0,
  // Latency running sum + count (in ms). Simpler than a histogram and good
  // enough for p50-ish reporting. If we ever care about tail latency we'd
  // plug in a real HDR histogram.
  latencyMsSum: 0,
  latencyMsCount: 0,
  // Start time so /metrics can report uptime.
  startedAtMs: Date.now(),
};

export interface BridgeMetrics {
  uptimeSec: number;
  totalRequests: number;
  successes: number;
  failures: number;
  retries: number;
  orphanRecoveries: number;
  avgLatencyMs: number | null;
  inFlight: number;
  waiting: number;
  activeProcesses: number;
  sessions: number;
  sessionTails: number;
  rateLimit: { status: string; updatedAtMs: number; ageMs: number } | null;
  /** Latest upstream-resolved model version per slug we've served. Useful
   *  for spotting silent upstream version flips (e.g. opus alias starts
   *  resolving to a newer model with different behavior). */
  resolvedModels: Record<
    string,
    { version: string; updatedAtMs: number; ageMs: number }
  >;
}

export function getMetrics(): BridgeMetrics {
  return {
    uptimeSec: Math.round((Date.now() - metrics.startedAtMs) / 1000),
    totalRequests: metrics.totalRequests,
    successes: metrics.successes,
    failures: metrics.failures,
    retries: metrics.retries,
    orphanRecoveries: metrics.orphanRecoveries,
    avgLatencyMs:
      metrics.latencyMsCount === 0
        ? null
        : Math.round(metrics.latencyMsSum / metrics.latencyMsCount),
    inFlight,
    waiting: waiters.length,
    activeProcesses: activeProcs.size,
    sessions: sessions.size,
    sessionTails: sessionTail.size,
    // Surface the most recent rate_limit_event status the upstream
    // Anthropic API sent us. `null` until we've seen at least one
    // streaming response (i.e. immediately after bridge boot).
    rateLimit: getLatestRateLimit(),
    // Latest upstream-resolved model version per slug we've served.
    // Empty until we've seen at least one assistant event for each slug.
    resolvedModels: getResolvedModels(),
  };
}

// ─── Shutdown / Cleanup ─────────────────────────────────────────────────────

/**
 * Drain in-flight CLI requests, then SIGKILL anything still running.
 * Returns once all child processes have exited (or been killed).
 */
export async function drainAndShutdown(timeoutMs = 10_000): Promise<void> {
  if (activeProcs.size === 0) return;
  log("info", "Drain start", { active: activeProcs.size });
  const deadline = Date.now() + timeoutMs;
  while (activeProcs.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (activeProcs.size > 0) {
    log("warn", "Drain timeout — killing remaining", { remaining: activeProcs.size });
    for (const proc of activeProcs) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  } else {
    log("info", "Drain complete");
  }
}

/**
 * Remove stale `bridge-*.json` and `bridge-mcp-*.json` files in os.tmpdir().
 * Normal operation cleans these per-request via mcpCleanup; this handles the
 * crash path where the process exited before cleanup ran.
 */
export function cleanupStaleTempFiles(): void {
  try {
    const tmp = os.tmpdir();
    const entries = fs.readdirSync(tmp);
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith("bridge-") || !name.endsWith(".json")) continue;
      try {
        fs.unlinkSync(path.join(tmp, name));
        removed++;
      } catch {}
    }
    if (removed > 0) log("info", "Startup tmp cleanup", { removed });
  } catch (err) {
    log("warn", "tmp cleanup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function log(
  level: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
