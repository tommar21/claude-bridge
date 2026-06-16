/**
 * In-bridge HTTP MCP server for Path D (persistent CLI).
 *
 * This is Path D's coordination layer: each persistent CLI is launched with
 * an `--mcp-config` pointing to a per-session URL on this server. When the
 * model emits a `tool_use` block, the CLI makes an MCP `tools/call` HTTP
 * request here. Instead of running the tool locally, this server PARKS the
 * request (holds the HTTP response open) until the bridge's OpenAI-side
 * handler gets a real tool_result from the external caller (OpenClaw
 * runtime) and resolves it via `tryResolveToolCall`. The CLI then unblocks,
 * the model sees the real result, and the conversation continues — with a
 * clean session transcript, no permission-denied artifacts.
 *
 * Why per-session URLs (not one shared endpoint with headers): Claude CLI
 * doesn't attach arbitrary correlation data to outbound MCP calls, but the
 * --mcp-config URL is fixed at CLI spawn time. Encoding sessionKey in the
 * URL gives us unambiguous routing without protocol gymnastics.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface PendingCall {
  toolUseId: string;
  rpcId: number | string;
  res: ServerResponse;
  resolved: boolean;
  receivedAt: number;
  /** Monotonic counter per-process. Lets us distinguish "POST1 vs POST2"
   *  in close logs when the CLI sends two tools/call POSTs with the same
   *  toolUseId (observed in production — root cause TBD). */
  seq: number;
  /** True when the CLI requested SSE (Accept includes text/event-stream).
   *  Headers were written immediately on receipt so the socket transitions
   *  out of "waiting for first byte" and the CLI's pre-byte timeout never
   *  fires while the bridge parks the response. The final tool_result is
   *  written as a single `data:` SSE event followed by res.end(). Once this
   *  is true the response CANNOT fall back to plain JSON. */
  isSse: boolean;
}

let pendingSeq = 0;

/** A tool_use captured from the CLI's stream-json output, consumed by the
 *  PathD session pool to drive the tool-result round-trip. */
export interface CapturedToolUse {
  /** Bridge-internal correlation id, matches the tool_use block id in the
   *  CLI's stream-json output (_meta.claudecode/toolUseId on the MCP side). */
  toolUseId: string;
  /** Tool name as seen by the model — already stripped of any mcp__ prefix. */
  name: string;
  /** Tool arguments, parsed from JSON-RPC params.arguments. */
  args: Record<string, unknown>;
}

interface SessionContext {
  sessionKey: string;
  tools: McpTool[];
  pending: Map<string, PendingCall>;
}

const JSON_RPC_INVALID = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** Strip everything except `[a-zA-Z0-9]`. Mirrors matrix's
 *  `sanitizeToolCallId` (strict mode) so we can fuzzy-match a sanitized
 *  tool_call_id from the OAI caller against the canonical anthropic
 *  `toolu_*` id the CLI registered. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "");
}

export class BridgeMcpHttpServer {
  private server: Server | null = null;
  private actualPort = 0;
  private sessions = new Map<string, SessionContext>();

  async start(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    const addr = this.server!.address();
    this.actualPort = typeof addr === "object" && addr ? addr.port : port;
    return this.actualPort;
  }

  async stop(): Promise<void> {
    // Fail all in-flight pending responses so no consumer hangs.
    for (const ctx of this.sessions.values()) {
      for (const p of ctx.pending.values()) {
        if (!p.resolved) this.finishResponse(p, { error: { code: -32000, message: "server stopping" } });
      }
      ctx.pending.clear();
    }
    this.sessions.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  get port(): number {
    return this.actualPort;
  }

  /** URL the CLI's --mcp-config should point at for this session. */
  urlFor(sessionKey: string): string {
    return `http://127.0.0.1:${this.actualPort}/${encodeURIComponent(sessionKey)}`;
  }

  registerSession(sessionKey: string, tools: McpTool[]): void {
    let ctx = this.sessions.get(sessionKey);
    if (!ctx) {
      ctx = { sessionKey, tools, pending: new Map() };
      this.sessions.set(sessionKey, ctx);
    } else {
      ctx.tools = tools;
    }
  }

  unregisterSession(sessionKey: string): void {
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) return;
    for (const p of ctx.pending.values()) {
      if (!p.resolved) {
        this.finishResponse(p, {
          error: { code: -32000, message: "session unregistered" },
        });
      }
    }
    this.sessions.delete(sessionKey);
  }

  /** Block briefly until the MCP POST for this tool_use_id lands in the
   *  pending map. The stream-json event that the bridge reads from the CLI
   *  can fire slightly before the MCP tools/call HTTP request arrives here,
   *  so the bridge needs to wait for this gate before returning the
   *  tool_use to the OAI caller — otherwise a fast caller round-trips with
   *  a tool_result before pending exists and tryResolveToolCall misses. */
  async waitForPending(sessionKey: string, toolUseId: string, timeoutMs = 10_000): Promise<void> {
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) throw new Error(`session not registered: ${sessionKey}`);
    if (this.findPending(ctx, toolUseId)) return;
    const deadline = Date.now() + timeoutMs;
    // Tight polling is fine here: the MCP POST usually lands within a few
    // event-loop ticks, and the only alternative (wiring per-id events)
    // bloats the pending-call data structure for a race that's ~ms wide.
    while (Date.now() < deadline) {
      if (this.findPending(ctx, toolUseId)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitForPending timeout: ${toolUseId} did not arrive within ${timeoutMs}ms`);
  }

  /** Try to deliver a tool_result. Returns true on success, false if the
   *  pending entry is missing (e.g. bridge restarted, CLI died, or session
   *  was respawned between turns). Callers use this to detect orphan
   *  tool_result deliveries and recover (typically by respawning the
   *  session and re-priming with the full conversation history). */
  tryResolveToolCall(
    sessionKey: string,
    toolUseId: string,
    content: unknown,
  ): boolean {
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) return false;
    const match = this.findPending(ctx, toolUseId);
    if (!match) return false;
    const { pending, key, matchedBy } = match;
    if (matchedBy === "fuzzy") {
      // Critical: matrix (and other OpenAI-compatible clients) may strip
      // non-alphanumeric chars from tool_call_id before sending tool_result
      // back. The bridge stores pending under the canonical anthropic
      // `toolu_*` id from the CLI; without fuzzy lookup we'd think the
      // pending was missing and trigger an orphan-recovery respawn.
      process.stdout.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          msg: "MCP resolve via fuzzy match",
          sessionKey,
          lookupId: toolUseId,
          canonicalId: key,
        })}\n`,
      );
    }
    if (pending.resolved) {
      ctx.pending.delete(key);
      return true;
    }
    this.finishResponse(pending, {
      result: {
        content: this.normalizeContent(content),
        isError: false,
      },
    });
    ctx.pending.delete(key);
    return true;
  }

  /** Locate a pending entry by `toolUseId`. Tries exact match first; if that
   *  fails, falls back to alphanumeric-only comparison so we tolerate OAI
   *  clients that strip `[^a-zA-Z0-9]` (matrix's
   *  `sanitizeToolCallIdsForCloudCodeAssist` with `strict` mode does this,
   *  turning `toolu_01ABC...` into `toolu01ABC...` on tool_result delivery).
   *
   *  The fuzzy fallback iterates the pending map — typically 0-2 entries
   *  during normal flow under `--max-turns 1`, so the linear scan is fine.
   *  On ambiguous matches (extremely unlikely for native anthropic ids), we
   *  prefer the most recently-added pending (highest seq) and log a warning
   *  so the operator can investigate.
   *
   *  HISTORICAL CONTEXT (PR #13, v3.4.4): without this fuzzy fallback the
   *  bridge would miss every matrix-originated tool_result lookup, trigger
   *  unregisterSession (SIGTERM the CLI), and orphan-respawn the session.
   *  Production orphanRecoveries ran at ~55% before this. After: 0%.
   *
   *  WHY WE DIDN'T FIX IT UPSTREAM IN MATRIX: the architecturally "clean"
   *  fix is `preserveNativeAnthropicToolUseIds: true` on the matrix-side
   *  claude-bridge provider plugin. That would require either creating a
   *  bundled extension in matrix's `extensions/claude-bridge/` (5-6 files
   *  of boilerplate for one config flag) or extending matrix's user-config
   *  schema to allow per-provider transcript-policy overrides (touches
   *  core config-public-surface). The bridge fuzzy lookup costs ~10 LOC
   *  AND protects against any future OAI-compatible client that sanitizes
   *  ids the same way, so it's strictly better than the matrix-side path.
   *  Keep this defensive even if matrix ever adds the upstream opt-in. */
  private findPending(
    ctx: SessionContext,
    lookupId: string,
  ): { pending: PendingCall; key: string; matchedBy: "exact" | "fuzzy" } | undefined {
    const exact = ctx.pending.get(lookupId);
    if (exact) return { pending: exact, key: lookupId, matchedBy: "exact" };

    // No early-exit on "lookupId is already sanitized". The COMMON case is
    // matrix sending the already-sanitized form (`toolu01ABC...`) and the
    // canonical map keying it under `toolu_01ABC...`. We always want to fall
    // back to the alphanumeric-only comparison.
    const sanitizedLookup = sanitizeId(lookupId);
    let bestMatch: { pending: PendingCall; key: string } | undefined;
    let allMatches: Array<{ key: string; seq: number }> | undefined;
    for (const [key, pending] of ctx.pending) {
      if (sanitizeId(key) !== sanitizedLookup) continue;
      if (!bestMatch || pending.seq > bestMatch.pending.seq) {
        bestMatch = { pending, key };
      }
      (allMatches ??= []).push({ key, seq: pending.seq });
    }
    if (!bestMatch) return undefined;
    if (allMatches && allMatches.length > 1) {
      process.stdout.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "MCP fuzzy lookup ambiguous, picking highest seq",
          sessionKey: ctx.sessionKey,
          lookupId,
          candidates: allMatches,
          picked: bestMatch.key,
        })}\n`,
      );
    }
    return { pending: bestMatch.pending, key: bestMatch.key, matchedBy: "fuzzy" };
  }

  // ─── HTTP handling ──────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CLI does a GET for SSE on the same URL as part of MCP HTTP transport
    // discovery; we don't need streaming, so reply with 405.
    if (req.method === "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SSE transport not supported; use POST JSON-RPC" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    const sessionKey = this.sessionKeyFromUrl(req.url ?? "");
    if (!sessionKey) {
      this.writeJson(res, 400, { error: "missing session key in URL" });
      return;
    }
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) {
      this.writeJson(res, 404, { error: `session not registered: ${sessionKey}` });
      return;
    }

    const body = await this.readBody(req);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(body) as Record<string, unknown>;
    } catch {
      this.writeJson(res, 400, { error: "invalid JSON" });
      return;
    }

    const method = typeof msg.method === "string" ? msg.method : "";
    const rpcId = msg.id as number | string | undefined;

    if (method === "initialize") {
      this.writeJsonRpc(res, rpcId, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-bridge-mcp", version: "path-d" },
      });
      return;
    }

    if (method === "tools/list") {
      this.writeJsonRpc(res, rpcId, { tools: ctx.tools });
      return;
    }

    if (method === "tools/call") {
      await this.handleToolsCall(ctx, msg, res, req);
      return;
    }

    if (method.startsWith("notifications/")) {
      res.writeHead(202);
      res.end();
      return;
    }

    this.writeJsonRpcError(res, rpcId, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
  }

  private async handleToolsCall(
    ctx: SessionContext,
    msg: Record<string, unknown>,
    res: ServerResponse,
    req: IncomingMessage,
  ): Promise<void> {
    const rpcId = msg.id as number | string | undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    // Claude CLI stamps this on every outbound tool call — matches the
    // `id` on the tool_use block in stream-json, which is how the bridge
    // correlates "this captured call" to "that tool_use event".
    const toolUseId = typeof meta["claudecode/toolUseId"] === "string"
      ? (meta["claudecode/toolUseId"] as string)
      : `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (rpcId === undefined) {
      this.writeJsonRpcError(res, null, JSON_RPC_INVALID, "tools/call requires an id");
      return;
    }

    // Per MCP Streamable HTTP transport spec, the CLI sends
    // `Accept: application/json, text/event-stream` — the server picks
    // which protocol to use. If we reply with plain JSON, the CLI parks
    // the socket waiting for response headers. Bun's HTTP client closes
    // that pre-byte wait at ~500ms regardless of MCP_TIMEOUT or
    // BUN_CONFIG_HTTP_IDLE_TIMEOUT (which only governs *idle* sockets,
    // not "waiting for first byte"). By choosing SSE and writing
    // 200 + Content-Type: text/event-stream + a comment frame
    // immediately, the socket transitions to "actively streaming" and
    // the parked tools/call response stays alive until the bridge has a
    // real tool_result to deliver (via finishResponse → `data:` event).
    const acceptHeader = (req.headers.accept ?? "").toString().toLowerCase();
    const isSse = acceptHeader.includes("text/event-stream");
    if (isSse) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable nginx-style proxy buffering just in case anything sits
        // in front of us in dev/test setups. In-process this is a no-op.
        "X-Accel-Buffering": "no",
      });
      // SSE comment line. Flushes headers to the client and pumps the
      // first byte so the CLI's pre-byte timeout never fires. Once we've
      // written headers we're committed to SSE — finishResponse must
      // emit a `data:` event, not a JSON body.
      res.write(": waiting for tool_result\n\n");
    }

    const seq = ++pendingSeq;
    const pending: PendingCall = {
      toolUseId,
      rpcId,
      res,
      resolved: false,
      receivedAt: Date.now(),
      seq,
      isSse,
    };
    // If a previous pending with the same toolUseId exists (CLI sent a
    // duplicate POST after a respawn), the new pending becomes the canonical
    // one for tryResolveToolCall. We do NOT close the old socket here — it
    // may still receive a result if the CLI is actually listening on it;
    // let it die naturally. (Duplicate-POST behavior is no longer expected
    // post-v3.4.4 since orphan-recovery-driven respawns stopped, but the
    // guard is cheap and defensive.)
    ctx.pending.set(toolUseId, pending);
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "MCP tools/call pending",
        sessionKey: ctx.sessionKey,
        toolUseId,
        rpcId,
        seq,
        tool: name,
      })}\n`,
    );

    // If the client socket dies, drop the pending entry — but ONLY if the
    // map still points to this exact pending. With duplicate POSTs (same
    // toolUseId), POST1's close handler must NOT delete POST2's entry from
    // the map. Only log unexpected closes (warn); the happy-path resolve
    // closes are silent now that v3.4.4 made them the norm.
    res.once("close", () => {
      const stillInMap = ctx.pending.get(toolUseId) === pending;
      if (pending.resolved) return;
      pending.resolved = true;
      if (stillInMap) ctx.pending.delete(toolUseId);
      const ageMs = Date.now() - pending.receivedAt;
      process.stdout.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "MCP pending CLOSED before resolve",
          sessionKey: ctx.sessionKey,
          toolUseId,
          rpcId,
          seq,
          ageMs,
          headersSent: res.headersSent,
          stillInMap,
          isSse,
        })}\n`,
      );
    });

    // The pending entry stays until it's claimed + resolved via the pending
    // map (tryResolveToolCall). Safe because --max-turns enforces one
    // tool_use at a time per turn.
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private sessionKeyFromUrl(url: string): string | null {
    // URL arrives as `/<sessionKey>` or `/<sessionKey>?...`
    const path = url.split("?")[0].replace(/^\/+/, "").replace(/\/+$/, "");
    if (!path) return null;
    try {
      return decodeURIComponent(path);
    } catch {
      return null;
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private writeJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  private writeJsonRpc(res: ServerResponse, id: number | string | undefined, result: unknown): void {
    this.writeJson(res, 200, { jsonrpc: "2.0", id: id ?? null, result });
  }

  private writeJsonRpcError(
    res: ServerResponse,
    id: number | string | null | undefined,
    code: number,
    message: string,
  ): void {
    this.writeJson(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }

  private finishResponse(pending: PendingCall, body: Record<string, unknown>): void {
    pending.resolved = true;
    try {
      const payload = { jsonrpc: "2.0", id: pending.rpcId, ...body };
      if (pending.isSse) {
        // Headers were already written when the call arrived. Emit the
        // final result as a single SSE data event then close — per MCP
        // Streamable HTTP transport spec, the server MAY close the stream
        // after sending its response message. We don't reuse the stream
        // for further events.
        const json = JSON.stringify(payload);
        pending.res.write(`data: ${json}\n\n`);
        pending.res.end();
      } else {
        this.writeJson(pending.res, 200, payload);
      }
    } catch {
      // Socket already closed — nothing to do, pending is already flagged.
    }
  }

  private normalizeContent(content: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (content && typeof content === "object") {
      return [content as Record<string, unknown>];
    }
    return [{ type: "text", text: String(content) }];
  }
}
