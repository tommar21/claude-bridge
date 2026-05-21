import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { BridgeMcpHttpServer } from "./mcp-http.ts";

/** Build a tiny ServerResponse-like stub. We only care about writeHead/end
 *  not throwing — the bridge writes a JSON-RPC payload then closes. */
function makeStubRes(): ServerResponse {
  const headers: Record<string, unknown> = {};
  let writtenStatus = 0;
  let writtenBody = "";
  return {
    writeHead(status: number, hdrs?: Record<string, unknown>) {
      writtenStatus = status;
      if (hdrs) Object.assign(headers, hdrs);
      return this;
    },
    end(body?: string) {
      writtenBody = body ?? "";
      return this;
    },
    once() {
      return this;
    },
    on() {
      return this;
    },
    get statusCode() {
      return writtenStatus;
    },
    get body() {
      return writtenBody;
    },
  } as unknown as ServerResponse;
}

test("tryResolveToolCall: returns false when session not registered", () => {
  const server = new BridgeMcpHttpServer();
  const ok = server.tryResolveToolCall("missing-session", "toolu_x", "result");
  assert.equal(ok, false);
});

test("tryResolveToolCall: returns false when pending entry missing", () => {
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  const ok = server.tryResolveToolCall("s1", "toolu_x", "result");
  assert.equal(ok, false);
});

test("resolveToolCall: still throws when pending missing (backward compat)", () => {
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  assert.throws(
    () => server.resolveToolCall("s1", "toolu_x", "result"),
    /no pending tool call: toolu_x/,
  );
});

test("tryResolveToolCall: returns true on successful resolve, deletes pending", () => {
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  // Inject a pending entry directly via the internal map. We can't easily
  // simulate the full HTTP roundtrip in a unit test, but we can verify the
  // resolve path works on whatever the bridge has tracked.
  const sessions = (server as unknown as { sessions: Map<string, { pending: Map<string, unknown> }> })
    .sessions;
  const ctx = sessions.get("s1");
  assert.ok(ctx);
  const stub = makeStubRes();
  ctx.pending.set("toolu_x", {
    toolUseId: "toolu_x",
    rpcId: 1,
    res: stub,
    resolved: false,
    receivedAt: Date.now(),
    seq: 1,
    isSse: false,
  });
  const ok = server.tryResolveToolCall("s1", "toolu_x", "the result");
  assert.equal(ok, true);
  // After resolve, the entry should be removed.
  assert.equal(ctx.pending.has("toolu_x"), false);
});

// ─── findPending fuzzy match tests ──────────────────────────────────────
//
// These lock in the v3.4.4 fix: matrix (and any OpenAI-compatible client
// running `sanitizeToolCallIdsForCloudCodeAssist`) strips `[^a-zA-Z0-9]`
// from `tool_call_id` before sending tool_result back. The bridge stores
// pending under the canonical anthropic `toolu_01ABC...` id from the CLI,
// so the lookup needs a fuzzy alphanumeric-only fallback. Without these
// tests, a refactor of `findPending` could silently break the orphan-rate
// fix that took 5 PRs to find.

type InternalSessionCtx = { pending: Map<string, Record<string, unknown>>; sessionKey: string };

function injectPending(
  server: BridgeMcpHttpServer,
  sessionKey: string,
  toolUseId: string,
  opts: { seq: number; res?: ServerResponse; isSse?: boolean } = { seq: 1 },
): void {
  const sessions = (server as unknown as {
    sessions: Map<string, InternalSessionCtx>;
  }).sessions;
  const ctx = sessions.get(sessionKey);
  if (!ctx) throw new Error(`session not registered: ${sessionKey}`);
  ctx.pending.set(toolUseId, {
    toolUseId,
    rpcId: 1,
    res: opts.res ?? makeStubRes(),
    resolved: false,
    receivedAt: Date.now(),
    seq: opts.seq,
    isSse: opts.isSse ?? false,
  });
}

test("fuzzy lookup: matrix-sanitized id resolves the canonical pending", () => {
  // Real production case: CLI registers pending with the underscore form,
  // matrix strips the underscore on tool_result delivery. The lookup MUST
  // find the entry, otherwise an orphan-recovery cascade triggers and we
  // regress to the ~55% orphan rate that v3.4.4 fixed.
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  injectPending(server, "s1", "toolu_01ABCdefGHI", { seq: 1 });
  const ok = server.tryResolveToolCall("s1", "toolu01ABCdefGHI", "ok");
  assert.equal(ok, true);
  const sessions = (server as unknown as { sessions: Map<string, InternalSessionCtx> })
    .sessions;
  // The entry must be deleted under its CANONICAL key, not the sanitized
  // lookup key — otherwise a future lookup with the same canonical id
  // would falsely hit a leftover entry.
  assert.equal(sessions.get("s1")?.pending.has("toolu_01ABCdefGHI"), false);
});

test("fuzzy lookup: exact match wins over fuzzy fallback", () => {
  // If both an exact and a fuzzy candidate exist, exact must win. Otherwise
  // the bridge might resolve the wrong call when a (theoretically possible)
  // collision happens.
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  injectPending(server, "s1", "toolu_01X", { seq: 1 });
  injectPending(server, "s1", "toolu01X", { seq: 2 });
  const ok = server.tryResolveToolCall("s1", "toolu01X", "ok");
  assert.equal(ok, true);
  // Only the EXACT-match entry should have been deleted.
  const sessions = (server as unknown as { sessions: Map<string, InternalSessionCtx> })
    .sessions;
  assert.equal(sessions.get("s1")?.pending.has("toolu_01X"), true);
  assert.equal(sessions.get("s1")?.pending.has("toolu01X"), false);
});

test("fuzzy lookup: missing id returns false (no false positives)", () => {
  // A lookup id with no underscore-or-canonical counterpart must NOT match
  // anything. This guards against the alphanumeric fold accidentally
  // matching unrelated ids that happen to share alphanumeric chars.
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  injectPending(server, "s1", "toolu_01ABC", { seq: 1 });
  const ok = server.tryResolveToolCall("s1", "toolu_NOPE", "x");
  assert.equal(ok, false);
});

test("fuzzy lookup: ambiguous match picks highest seq", () => {
  // Native anthropic ids make ambiguity essentially impossible
  // (`toolu_[A-Za-z0-9]{22+}` is collision-resistant), but custom non-native
  // ids or test fixtures could collide. The tie-breaker must be deterministic
  // and prefer the most recent entry (highest seq).
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  injectPending(server, "s1", "tool_u_01", { seq: 1 });
  injectPending(server, "s1", "toolu_01", { seq: 2 });
  // Both sanitize to "toolu01". Both are present in the map. Lookup with
  // "toolu01" must pick seq=2.
  const stub2Pending = (server as unknown as {
    sessions: Map<string, InternalSessionCtx>;
  }).sessions.get("s1")?.pending.get("toolu_01");
  assert.ok(stub2Pending);
  const ok = server.tryResolveToolCall("s1", "toolu01", "ok");
  assert.equal(ok, true);
  // seq=2 entry must be the one removed; seq=1 stays in the map.
  const remaining = (server as unknown as {
    sessions: Map<string, InternalSessionCtx>;
  }).sessions.get("s1")?.pending;
  assert.equal(remaining?.has("toolu_01"), false);
  assert.equal(remaining?.has("tool_u_01"), true);
});
