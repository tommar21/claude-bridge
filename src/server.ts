import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { listModels, resolveModel } from "./models.js";
import {
  drainAndShutdown,
  enqueuePersistent,
  enqueueRequest,
  getMetrics,
  isPathDEnabled,
  recordRateLimitStatus,
  recordResolvedModel,
  type Effort,
} from "./cli-worker.js";
import type { OAIChatRequest } from "./translate.js";
import { buildPrompt, extractForPathD, toolsFromRequest } from "./translate.js";
import { intEnv } from "./env.js";
import { BRIDGE_VERSION } from "./version.js";
import { validateChatRequest } from "./request-validate.js";
import {
  buildCompletionResponse,
  mapFinishReason,
  sanitizeClientError,
} from "./response-format.js";

export { BRIDGE_VERSION };

// Max accepted request body. Generous by default — the matrix gateway / Hermes
// legitimately send large multi-turn payloads — but bounded so a single huge
// or slow-drip POST can't buffer unboundedly in memory. Env-tunable.
const MAX_BODY_BYTES = intEnv("CLAUDE_BRIDGE_MAX_BODY_BYTES", 64 * 1024 * 1024, {
  min: 64 * 1024,
});

// Flipped to true on SIGTERM/SIGINT so new chat-completion requests get
// rejected with 503 while we drain. Health + models stay up for LB checks.
let isShuttingDown = false;

export interface ServerConfig {
  port: number;
  host: string;
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function startServer(
  config: ServerConfig,
  onShutdown?: () => Promise<void>,
): void {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      log("error", "Unhandled error", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            message: "Internal server error",
            type: "api_error",
            code: null,
          },
        });
      }
    }
  });

  // Graceful shutdown:
  //   1. Stop accepting new /v1/chat/completions (503)
  //   2. Close the HTTP server so Node's keep-alive connections drain
  //   3. drainAndShutdown() waits up to 10s for in-flight CLI to finish,
  //      then SIGKILLs stragglers
  //   4. onShutdown() (e.g. the persistent pool + MCP server) runs in the SAME
  //      chain, BEFORE exit, so it isn't truncated by a racing process.exit
  //   5. Hard-stop timer (15s total) as last-resort safety net
  let shuttingDownPromise: Promise<void> | null = null;
  const shutdown = (signal: string) => {
    if (shuttingDownPromise) return shuttingDownPromise;
    log("info", "Shutting down", { signal });
    isShuttingDown = true;
    const hardStop = setTimeout(() => {
      log("error", "Hard-stop timer fired — forcing exit");
      process.exit(1);
    }, 15_000);
    hardStop.unref();
    shuttingDownPromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
    })
      .then(() => drainAndShutdown(10_000))
      .then(() => onShutdown?.())
      .then(() => {
        log("info", "Shutdown complete");
        process.exit(0);
      })
      .catch((err) => {
        log("error", "Shutdown error", {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
    return shuttingDownPromise;
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  server.listen(config.port, config.host, () => {
    log(
      "info",
      `Claude Bridge listening on http://${config.host}:${config.port}`,
    );
    log("info", `Models: ${listModels().map((m) => m.id).join(", ")}`);
  });
}

// ─── Router ─────────────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? "/";

  if (url === "/health" || url === "/healthz") {
    return sendJson(res, 200, { status: "ok", version: BRIDGE_VERSION });
  }

  // Introspection for ops: current queue depth, lifetime counts, avg latency.
  // Loopback-only exposure (bridge binds 127.0.0.1 by default) so leaking this
  // isn't a concern, but the payload deliberately contains no request content
  // — counts and numbers only.
  if (url === "/metrics") {
    return sendJson(res, 200, { version: BRIDGE_VERSION, ...getMetrics() });
  }

  if (url === "/v1/models" && req.method === "GET") {
    return handleModels(res);
  }

  if (url === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  sendJson(res, 404, {
    error: { message: `Not found: ${url}`, type: "not_found", code: null },
  });
}

// ─── GET /v1/models ─────────────────────────────────────────────────────────

function handleModels(res: ServerResponse): void {
  const models = listModels().map((m) => ({
    id: m.id,
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  }));
  sendJson(res, 200, { object: "list", data: models });
}

// ─── POST /v1/chat/completions ──────────────────────────────────────────────

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (isShuttingDown) {
    return sendJson(res, 503, {
      error: {
        message: "Bridge is shutting down; retry on the next instance",
        type: "server_shutting_down",
        code: null,
      },
    });
  }
  const bodyResult = await readBody(req, MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    if (bodyResult.reason === "too_large") {
      return sendJson(res, 413, {
        error: {
          message: "Request body too large",
          type: "invalid_request_error",
          code: null,
        },
      });
    }
    return sendJson(res, 400, {
      error: { message: "Empty request body", type: "invalid_request_error", code: null },
    });
  }
  const body = bodyResult.body;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return sendJson(res, 400, {
      error: { message: "Invalid JSON", type: "invalid_request_error", code: null },
    });
  }

  const validated = validateChatRequest(parsedBody);
  if (!validated.ok) {
    return sendJson(res, 400, {
      error: { message: validated.error, type: "invalid_request_error", code: null },
    });
  }
  const oaiReq = validated.req;

  const model = resolveModel(oaiReq.model ?? "claude-sonnet-4");
  const built = buildPrompt(oaiReq);
  const tools = toolsFromRequest(oaiReq);
  const startTime = Date.now();

  // Bridge-specific request hints exposed as headers. Headers (not body
  // fields) so they pass cleanly through clients that don't know to extend
  // the OpenAI request shape (Hermes Agent, openclaw matrix gateway, etc).
  //   X-Bridge-Effort: low|medium|high|xhigh|max — CLI --effort passthrough
  //   X-Bridge-Ultracode: 1 — force xhigh + inject ultracode reminder
  const effortHeader = req.headers["x-bridge-effort"];
  const requestedEffort = typeof effortHeader === "string"
    ? effortHeader.toLowerCase()
    : undefined;
  const VALID_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
  // Narrow the untrusted header to the Effort union once, here at the boundary.
  const effort: Effort | undefined =
    requestedEffort && (VALID_EFFORTS as readonly string[]).includes(requestedEffort)
      ? (requestedEffort as Effort)
      : undefined;
  const ultracodeHeader = req.headers["x-bridge-ultracode"];
  const ultracode = ultracodeHeader === "1" || ultracodeHeader === "true";

  log("info", "Request", {
    model: model.id,
    cliModel: model.cliAlias,
    stream: !!oaiReq.stream,
    messages: oaiReq.messages.length,
    tools: tools.length,
    hasSystemPrompt: !!built.systemPrompt,
    effort,
    ultracode,
  });

  const lastUserMsg = oaiReq.messages.filter((m) => m.role === "user").pop();
  const lastUserText = lastUserMsg
    ? (typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("")
          : String(lastUserMsg.content ?? ""))
    : built.prompt;

  const cliReq = {
    prompt: built.prompt,
    lastMessage: lastUserText,
    model: model.cliAlias,
    systemPrompt: built.systemPrompt,
    tools,
    sessionKey: oaiReq.user,
    effort,
    ultracode,
  };

  // Cancel the in-flight CLI turn if the client disconnects before we finish,
  // instead of letting it run to the 300s timeout burning Max quota.
  const abort = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  // Route to Path D (persistent CLI + in-bridge MCP) when:
  //   - Feature flag is enabled
  //   - Request carries a sessionKey (OpenAI `user` field)
  //   - We can extract either a fresh user message OR a tool_result
  //     (extractForPathD returns null when the shape isn't something we
  //     handle yet, e.g. last message is assistant)
  // Falls through to the v3.3 spawn-fresh path otherwise.
  const pathD = isPathDEnabled() ? extractForPathD(oaiReq) : null;
  if (pathD && oaiReq.user) {
    const persistentReq = {
      sessionKey: oaiReq.user,
      model: model.cliAlias,
      systemPrompt: pathD.systemPrompt,
      tools,
      lastUserContent: pathD.lastUserContent,
      pendingToolResult: pathD.pendingToolResult,
      primingPrompt: pathD.primingPrompt,
      effort,
      ultracode,
    };
    if (oaiReq.stream) {
      await handlePersistentStreaming(req, res, persistentReq, model.id, startTime, abort.signal);
    } else {
      await handlePersistentNonStreaming(res, persistentReq, model.id, startTime, abort.signal);
    }
    return;
  }

  if (oaiReq.stream) {
    await handleStreaming(req, res, cliReq, model.id, startTime, abort.signal);
  } else {
    await handleNonStreaming(res, cliReq, model.id, startTime, abort.signal);
  }
}

async function handlePersistentNonStreaming(
  res: ServerResponse,
  req: Parameters<typeof enqueuePersistent>[0],
  modelId: string,
  startTime: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await enqueuePersistent(req, undefined, signal);
    recordRateLimitStatus(result.rateLimitStatus);
    recordResolvedModel(modelId, result.modelVersion);
    const duration = Date.now() - startTime;
    log("info", "Response", {
      model: modelId,
      duration,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls.length,
      rateLimitStatus: result.rateLimitStatus,
      pathD: true,
      continuation: !!req.pendingToolResult,
    });
    sendJson(res, 200, buildCompletionResponse(result, modelId));
  } catch (err) {
    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Path D request failed", { model: modelId, duration, error: message });
    if (!res.headersSent) {
      const isTimeout = message.includes("timeout");
      sendJson(res, isTimeout ? 504 : 500, {
        error: { message: sanitizeClientError(message), type: "api_error", code: null },
      });
    }
  }
}

async function handlePersistentStreaming(
  httpReq: IncomingMessage,
  res: ServerResponse,
  req: Parameters<typeof enqueuePersistent>[0],
  modelId: string,
  startTime: number,
  signal?: AbortSignal,
): Promise<void> {
  const msgId = `chatcmpl-${Date.now()}`;
  const ts = Math.floor(Date.now() / 1000);
  let sseOpened = false;
  let roleSent = false;

  const openSSE = () => {
    if (sseOpened) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseOpened = true;
  };
  const emitChunk = (delta: Record<string, unknown>, finish?: string) => {
    writeSSE(res, {
      id: msgId,
      object: "chat.completion.chunk",
      created: ts,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });
  };

  httpReq.on("close", () => {
    if (!res.writableEnded) res.destroy();
  });
  res.on("error", () => {
    if (!res.writableEnded) res.destroy();
  });

  let toolCallsEmitted = 0;
  try {
    const result = await enqueuePersistent(req, {
      onTextDelta: (delta) => {
        openSSE();
        if (!roleSent) {
          emitChunk({ role: "assistant", content: "" });
          roleSent = true;
        }
        emitChunk({ content: delta });
      },
      onToolUse: (tu) => {
        openSSE();
        if (!roleSent) {
          emitChunk({ role: "assistant", content: null });
          roleSent = true;
        }
        emitChunk({
          tool_calls: [
            {
              index: toolCallsEmitted,
              id: tu.id,
              type: "function",
              function: {
                name: tu.name.startsWith("mcp__openclaw__")
                  ? tu.name.slice("mcp__openclaw__".length)
                  : tu.name,
                arguments: JSON.stringify(tu.input ?? {}),
              },
            },
          ],
        });
        toolCallsEmitted++;
      },
    }, signal);

    recordRateLimitStatus(result.rateLimitStatus);
    recordResolvedModel(modelId, result.modelVersion);
    const duration = Date.now() - startTime;
    log("info", "Response", {
      model: modelId,
      duration,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls.length,
      rateLimitStatus: result.rateLimitStatus,
      pathD: true,
      continuation: !!req.pendingToolResult,
      streamed: true,
    });

    openSSE();
    const hasToolCalls = result.toolCalls.length > 0;
    emitChunk({}, mapFinishReason(result.stopReason, hasToolCalls));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Path D stream failed", { model: modelId, error: message, streamed: sseOpened });
    if (!sseOpened) {
      const isTimeout = message.includes("timeout");
      sendJson(res, isTimeout ? 504 : 500, {
        error: { message: sanitizeClientError(message), type: "api_error", code: null },
      });
      return;
    }
    try {
      writeSSE(res, {
        id: msgId,
        object: "chat.completion.chunk",
        created: ts,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        error: { message: sanitizeClientError(message), type: "api_error" },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      res.destroy();
    }
  }
}

async function handleNonStreaming(
  res: ServerResponse,
  cliReq: Parameters<typeof enqueueRequest>[0],
  modelId: string,
  startTime: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await enqueueRequest(cliReq, undefined, signal);
    recordRateLimitStatus(result.rateLimitStatus);
    recordResolvedModel(modelId, result.modelVersion);
    const duration = Date.now() - startTime;
    log("info", "Response", {
      model: modelId,
      duration,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls.length,
      rateLimitStatus: result.rateLimitStatus,
    });
    sendJson(res, 200, buildCompletionResponse(result, modelId));
  } catch (err) {
    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Request failed", { model: modelId, duration, error: message });
    if (!res.headersSent) {
      const isTimeout = message.includes("timeout");
      sendJson(res, isTimeout ? 504 : 500, {
        error: { message: sanitizeClientError(message), type: "api_error", code: null },
      });
    }
  }
}

/**
 * Real streaming: open the SSE response up front and write OAI-format
 * chunks as deltas arrive from the CLI. Text goes out token-by-token;
 * tool_use blocks arrive atomically from stream-json so we forward them
 * as they land (not buffered to the end). Final `result` event triggers
 * the finish chunk + [DONE].
 *
 * If the CLI fails BEFORE emitting anything, we can still send a clean
 * JSON error response (headers not yet written). If it fails AFTER we've
 * started streaming, the SSE stream is already committed — we emit a
 * terminal error chunk and [DONE] so the client can tear down cleanly.
 */
async function handleStreaming(
  req: IncomingMessage,
  res: ServerResponse,
  cliReq: Parameters<typeof enqueueRequest>[0],
  modelId: string,
  startTime: number,
  signal?: AbortSignal,
): Promise<void> {
  const msgId = `chatcmpl-${Date.now()}`;
  const ts = Math.floor(Date.now() / 1000);
  let sseOpened = false;
  let roleSent = false;

  const openSSE = () => {
    if (sseOpened) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseOpened = true;
  };

  const emitChunk = (delta: Record<string, unknown>, finish?: string) => {
    writeSSE(res, {
      id: msgId,
      object: "chat.completion.chunk",
      created: ts,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });
  };

  // Client disconnect: don't keep writing to a dead socket (and don't let
  // the CLI process drag on afterward — the timer in runCLI will eventually
  // kill it, but killing now is cleaner). No-op if no proc attached yet.
  req.on("close", () => {
    if (!res.writableEnded) res.destroy();
  });
  res.on("error", () => {
    if (!res.writableEnded) res.destroy();
  });

  let toolCallsEmitted = 0;
  try {
    const result = await enqueueRequest(cliReq, {
      onTextDelta: (delta) => {
        openSSE();
        if (!roleSent) {
          emitChunk({ role: "assistant", content: "" });
          roleSent = true;
        }
        emitChunk({ content: delta });
      },
      onToolUse: (tu) => {
        openSSE();
        if (!roleSent) {
          emitChunk({ role: "assistant", content: null });
          roleSent = true;
        }
        emitChunk({
          tool_calls: [
            {
              index: toolCallsEmitted,
              id: tu.id,
              type: "function",
              function: {
                name: tu.name.startsWith("mcp__openclaw__")
                  ? tu.name.slice("mcp__openclaw__".length)
                  : tu.name,
                arguments: JSON.stringify(tu.input ?? {}),
              },
            },
          ],
        });
        toolCallsEmitted++;
      },
    }, signal);

    recordRateLimitStatus(result.rateLimitStatus);
    recordResolvedModel(modelId, result.modelVersion);
    const duration = Date.now() - startTime;
    log("info", "Response", {
      model: modelId,
      duration,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls.length,
      rateLimitStatus: result.rateLimitStatus,
      streamed: true,
    });

    openSSE();
    const hasToolCalls = result.toolCalls.length > 0;
    emitChunk({}, mapFinishReason(result.stopReason, hasToolCalls));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Request failed", {
      model: modelId,
      duration,
      error: message,
      streamed: sseOpened,
    });

    if (!sseOpened) {
      // Nothing committed — emit a structured JSON error like non-streaming.
      const isTimeout = message.includes("timeout");
      sendJson(res, isTimeout ? 504 : 500, {
        error: { message: sanitizeClientError(message), type: "api_error", code: null },
      });
      return;
    }
    // SSE already opened: close cleanly with an error-flavored chunk so the
    // client sees a terminal event instead of a hung connection.
    try {
      writeSSE(res, {
        id: msgId,
        object: "chat.completion.chunk",
        created: ts,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        error: { message: sanitizeClientError(message), type: "api_error" },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      res.destroy();
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

type ReadBodyResult =
  | { ok: true; body: string }
  | { ok: false; reason: "empty" | "too_large" };

function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (r: ReadBodyResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Reject before the whole payload buffers in memory.
        settle({ ok: false, reason: "too_large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      settle(body ? { ok: true, body } : { ok: false, reason: "empty" });
    });
    req.on("error", () => settle({ ok: false, reason: "empty" }));
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  // The client may have disconnected (socket destroyed on req close / abort);
  // writing headers to a destroyed response throws. Guard once here so every
  // error/response path is safe instead of repeating the check at each site.
  if (res.destroyed || res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function log(
  level: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(entry)}\n`);
}
