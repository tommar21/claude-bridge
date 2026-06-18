# claude-bridge → Claude Agent SDK: Engineering Feasibility Memo

**Author:** Bridge lead engineer
**Date:** 2026-06-17
**Status:** Decision memo — recommends a path, not yet a commitment to cut over
**Scope:** Migrating `~/openclaw-native/bridge/` from the raw `claude` CLI subprocess pool to `@anthropic-ai/claude-agent-sdk` (the Meridian approach)

---

## 1. Verdict

**Hybrid seam, default-CLI, SDK behind a flag — not a full cutover, not "stay forever on CLI."** Build a `CLAUDE_BRIDGE_ENGINE=cli|sdk` boundary, ship the SDK engine OFF by default, validate it against live crons, and only flip the default after the four parity risks are proven. Keep the CLI engine indefinitely as the rollback.

The reason is not that the SDK is worse — it deletes ~47% of the core path (~1,960 LOC), including the bug-densest park-and-resolve layer — but that **the bridge's value proposition is auth, and the SDK does not change it either way.** The SDK drives the *same bundled `claude` binary* the bridge spawns today, so the `$0-marginal Max-subscription` economics are **preserved**: setting `CLAUDE_CODE_OAUTH_TOKEN` (from our existing `claude setup-token`) and unsetting `ANTHROPIC_API_KEY` runs the SDK on subscription quota at zero marginal cost — mechanically identical to what the bridge exploits now, and exactly what Meridian does in production via the same OAuth channel. **The auth question resolves in favor of migration: there is no economic regression.** The caveat is policy, not code: Anthropic's Agent SDK overview explicitly disallows claude.ai-login/subscription auth for *third-party SDK products you distribute*. For a **personal/internal bridge on Tomi's own Mac**, this is the same already-accepted ToS posture as the current CLI-OAuth stack (see `2026-04-16` migration memory) — we are not changing our exposure, only the package that reads the token. We are not distributing a product. So the policy note is a "do not productize/redistribute this" flag, not a blocker for our use case.

Given equal auth economics, the decision reduces to engineering: the SDK is a versioned API that absorbs the CLI-flag churn that has repeatedly bitten us (`--tools ""`, `--strict-mcp-config`, `--session-id`, the max-turns patch), and it hands us resumable sessions for free. That's worth doing — **carefully, incrementally, behind a flag**, because four behavior-parity risks (effort buckets, Path-D priming, fuzzy tool-id matching, error-as-content) and one architectural impedance mismatch (parking `tool_use` across HTTP turns, which is the *opposite* of the SDK's in-process tool model) each need a live proof before we trust them.

---

## 2. What the migration buys

Concrete, per-module, grounded in the scoping:

**It deletes the gnarliest code in the repo.** `src/mcp-http.ts` (604 LOC) + `src/mcp-server.ts` (116 LOC) → **0**. The entire in-process HTTP MCP server, per-session URLs, JSON-RPC handling, and the **park-and-resolve machinery** (`tryResolveToolCall`, `waitForPending`, parked SSE sockets, the Bun pre-byte-timeout hack at `mcp-http.ts:430-457`, duplicate-POST seq tracking, the DNS-rebinding `isLoopbackHost` guard) all vanish. This is the bug-densest surface we own. It exists *only* because the in-memory CLI expects synchronous tool results; SDK session-resume + a result-injection user turn replaces the whole dance. **This single deletion is the biggest win.**

**`PersistentSession` evaporates.** `src/session-pool.ts` (607 → ~200 LOC). The 580-LOC hand-rolled resumable-session machinery — long-lived child, stdin writer, `consumeStream`, the `readOne`/`emit` mailbox, `_dead` liveness tracking, stderr capture — is exactly what `query({resume: sessionId})` / `unstable_v2_*` provide natively. We keep only genuine bridge-owned *pool policy* (`acquire`/`teardown`/`evictIdle`, `decideSessionAction`, the LRU caps).

**`cli-worker.ts` halves** (1140 → ~450 LOC). `runCLI()`'s raw `spawn("claude", args)` + stdin/stdout/stderr piping collapses into `query({prompt, options})`. The 15+ hand-maintained CLI flags (`--print --output-format stream-json --verbose --model --max-turns --tools "" --mcp-config --strict-mcp-config --session-id --resume --system-prompt --effort`) collapse into typed `options` fields. `writeMcpConfig()` + the `bridge-tools-*.json`/`bridge-mcp-*.json` temp-file plumbing + `cleanupStaleTempFiles()` + the entire `$TMPDIR` race-condition class — **eliminated**, because tools go in-process via `createSdkMcpServer`.

**`stream-parser.ts`** (188 → ~60 LOC): hand-rolled `JSON.parse(line)` newline-buffered line dispatch → iterating typed `SDKMessage` events. Fewer "unknown event shape" silent drops.

**Robustness vs CLI flag drift** (the strategic payoff): today every flag in `cli-worker.ts:728` and `session-pool.ts:542` is a hand-maintained contract with an unversioned binary. A CLI rename silently breaks the bridge — it has happened. The SDK is a versioned API that absorbs that churn. We trade an *un*versioned coupling for a versioned one.

**What stays untouched** (the seam that makes this safe): `server.ts` (799 LOC, the OpenAI surface), `translate.ts` (the reason the bridge exists), `models.ts` — all SDK-agnostic. They call `enqueueRequest`/`enqueuePersistent` and don't care how a turn is produced.

---

## 3. What it costs / risks

**(1) Breaks the zero-dep ethos.** Today the bridge has effectively no runtime deps — a deliberate pillar of the native-minimal deployment story (`2026-05-25-docker-to-native`). `@anthropic-ai/claude-agent-sdk` (+ zod for tool schemas) is a substantial tree, and it bundles per-platform native `claude` binaries as optionalDependencies (~11 MB each). *Mitigation:* the SDK ships zero *runtime npm* deps and we lazy-import it only inside `engine/sdk.ts`, so the CLI path stays dep-free until we commit. But this is a real philosophical reversal and should be named as such.

**(2) SDK version coupling, and the resume API is `unstable`.** We trade CLI-flag coupling for SDK-API coupling. The clean per-turn session-resume we most want (`unstable_v2_createSession`/`unstable_v2_resumeSession`) is **explicitly preview/unstable**. Betting the bridge's core loop on a preview API is a genuine risk; the V1 `resume` path is stabler but coarser. **Spike required** to decide V1-vs-V2 before committing.

**(3) Four behavior-parity risks — the load-bearing list:**
- **`--effort` buckets (`low|medium|high|xhigh|max`)** — `cli-worker.ts:741`, `:572`, driven by the `X-Bridge-Effort` header. No confirmed SDK equivalent for `xhigh`/`max`. **This is the single most likely "SDK can't do X" blocker.** If unconfirmed, ultracode-mode (`server.ts:271`) and effort-driven crons regress. **Must verify before cutover.**
- **Path-D priming** — the XML-history `primingPrompt` blob (`translate.ts:241`, `cli-worker.ts:323-330`). Feeding a full XML history as the first user turn *while also* using `resume` risks double-counted history or context confusion, since the SDK replays its own session state. **Needs a live validation.**
- **Fuzzy tool_call_id matching** — `mcp-http.ts:78`/`:290`. Matrix strips `[^a-zA-Z0-9]` from `tool_call_id`; without the fuzzy fallback, production `orphanRecoveries` ran ~55%. We must re-home ~15 LOC of `sanitizeId` + fuzzy-match into the SDK continuation path. **This is the #1 regression risk** — getting it wrong reintroduces a 55%-orphan failure mode.
- **Error-as-content / Max-quota leakage** — `error-as-content.ts` + the `out of extra usage` retry gate. **This does NOT go away.** The SDK spawns the *same* OAuth-Max binary that emits `API Error: 400 ... out of extra usage` as assistant *content*. The SDK may surface some failures as `result.subtype === "error_*"`, but Max-quota-as-content predates structured mapping. **Keep the gate; re-validate against actual SDK error shapes.** (This was the exact bug class from `2026-06-10` — do not regress it.)

**(4) The architectural impedance mismatch.** The bridge is a proxy where the *external* caller owns the tool loop; the SDK assumes *in-process synchronous* tool execution. `createSdkMcpServer`'s `tool()` handler is expected to run the tool and return content — it does **not** natively "park a `tool_use`, end the HTTP turn, resolve later." We must force this with either `canUseTool` deny-as-handoff (record the `tool_use`, return `{behavior:"deny", message}`, surface it over HTTP, resume + inject `tool_result` next turn) or `maxTurns:1` + parse `tool_use` from messages. Neither is the SDK's happy path. **This needs a PoC before any commitment** — it is the thing most likely to be quietly impossible.

**(5) Usage/rate-limit fidelity.** `/metrics`, `recordRateLimitStatus`, and the UI quota warning depend on `rate_limit_event` and resolved `message.model` from stream-json. Resolved model is confirmed via `msg.message.model`; **rate-limit status exposure on `SDKMessage` is uncertain.** Spike to confirm, or the quota warning goes dark.

**(6) ToS posture.** Unchanged for our internal use (same OAuth-Max binary), but the SDK overview's explicit "no claude.ai login for products" note means we must never repackage this SDK engine as a distributable. Documentation/guardrail, not a code change.

---

## 4. Recommended incremental path: `CLAUDE_BRIDGE_ENGINE=cli|sdk`

The OpenAI surface is *already* the seam — nothing above `enqueueRequest`/`enqueuePersistent` cares how a turn is produced. Exploit it exactly as the existing `CLAUDE_BRIDGE_PATH_D` flag (`index.ts:24`) does.

**Stage 0 — Spike (no production code).** Resolve the three unknowns that gate everything: (a) does `query()` expose an `--effort xhigh/max` equivalent? (b) does the `canUseTool`-deny-as-handoff pattern actually surface a `tool_use` and stop, resumably? (c) does `SDKMessage` carry rate-limit status? Throwaway script, live OAuth token. **Go/no-go hinges here.**

**Stage 1 — Extract (zero behavior change).** Define `src/engine/types.ts`:
```ts
interface BridgeEngine {
  enqueueRequest(req: CLIRequest, h?: StreamEventHandlers, s?: AbortSignal): Promise<CLIResult>;
  enqueuePersistent(req: PersistentCLIRequest, h?: StreamEventHandlers, s?: AbortSignal): Promise<CLIResult>;
  getMetrics(): BridgeMetrics; drainAndShutdown(): Promise<void>;
}
```
`CLIResult`/`StreamEventHandlers`/`CLIRequest` (`cli-worker.ts:53-92`) are already engine-neutral — keep them as the shared contract. Move today's `cli-worker.ts` + `session-pool.ts` + `mcp-http.ts` + `mcp-server.ts` + `stream-parser.ts` behind `src/engine/cli.ts` **unchanged** — pure extract-and-wrap, full test parity. `index.ts` selects off `process.env.CLAUDE_BRIDGE_ENGINE` (default `cli`). This stage merges invisibly (FF, no screenshots needed — per the project's invisible-refactor pattern).

**Stage 2 — Build `src/engine/sdk.ts` behind the flag, default OFF.** `query()` + `createSdkMcpServer` + `canUseTool`, consuming `SDKMessage`, producing the *same* `CLIResult`/`StreamEventHandlers` callbacks. **Reuse, don't rewrite:** `translate.ts`, the `runCLIWithRetry` wrapper + `TRANSIENT_PATTERNS`, the `error-as-content.ts` gate, the pool *policy* (`session-pool-decision.ts`), and the metrics trackers — all already engine-neutral. Re-home `sanitizeId` + fuzzy-match here. Lazy/dynamic-import the SDK so the CLI path never pays for it.

**Stage 3 — Parity test plan (the gate to flipping default).** Validate against **live, multi-tool-chain crons** — `juan-upwork` and the `*-self-maintenance` jobs that exposed the max-turns bug at `session-pool.ts:556`:
- **Effort parity:** run an `xhigh`/ultracode request through both engines; diff resolved model + thinking behavior.
- **Path-D priming:** a fresh-session-with-history request; assert no double-counted history (compare token usage CLI-vs-SDK).
- **Fuzzy-id:** a Matrix-originated tool round-trip with a sanitized `tool_call_id`; assert `orphanRecoveries` stays ~0, not ~55%.
- **Error-as-content:** force an `out of extra usage` condition; assert the streaming gate still catches it and the retry fires (this is the `2026-06-10` regression test).
- **Roundtrip:** a real Telegram message through jarvis; `/metrics` and the quota warning must match the CLI engine.

**Flip default to `sdk` only after all five match.** Keep `engine/cli.ts` indefinitely — `CLAUDE_BRIDGE_ENGINE=cli` is an instant rollback, exactly how Path D kept the v3.3 legacy path.

---

## 5. Minimal PoC sketch

`query()` wired behind the existing `CLIResult`/`StreamEventHandlers` contract, using the `canUseTool` deny-as-handoff pattern to park `tool_use` across the HTTP turn boundary:

```ts
// src/engine/sdk.ts (sketch — PoC, not production)
import type { CLIRequest, CLIResult, StreamEventHandlers } from "../cli-worker";

export async function enqueueRequestSdk(
  req: CLIRequest, h?: StreamEventHandlers, signal?: AbortSignal,
): Promise<CLIResult> {
  const { query, createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk"); // lazy

  const captured: Array<{ id: string; name: string; input: unknown }> = [];
  const tools = createSdkMcpServer({                // tools from translate.toolsFromRequest(req)
    name: "bridge", version: "1",
    tools: req.tools.map((t) => tool(t.name, t.description, t.zodSchema,
      async () => ({ content: [] }))),             // handler never runs — canUseTool denies first
  });

  let sessionId = req.resumeSessionId;
  let text = "", stopReason: CLIResult["stopReason"] = "end_turn";

  for await (const msg of query({
    prompt: req.prompt,                             // translate.buildPrompt(...) / tool_result user turn
    options: {
      model: req.model, maxTurns: 1,                // park after one assistant turn
      ...(sessionId ? { resume: sessionId } : {}),
      mcpServers: { bridge: tools },
      includePartialMessages: Boolean(h?.onTextDelta),
      env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! }, // $0-marginal Max
      canUseTool: async (name, input) => {          // deny-as-handoff: record + stop, caller executes
        captured.push({ id: crypto.randomUUID(), name, input });
        return { behavior: "deny", message: "forwarded to bridge caller; end turn" };
      },
    },
  })) {
    if (signal?.aborted) break;
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
    if (msg.type === "stream_event") h?.onTextDelta?.(extractDelta(msg)); // typed events, no JSON.parse(line)
    if (msg.type === "assistant") for (const b of msg.message.content)
      if (b.type === "text") text += b.text;
    if (msg.type === "result") {                    // re-validate error-as-content gate here too
      h?.onUsage?.(msg.usage); h?.onResolvedModel?.(msg.modelUsage);
    }
  }
  if (captured.length) stopReason = "tool_use";     // re-home sanitizeId/fuzzy-match on continuation
  return { text, stopReason, sessionId, toolUses: captured /* mapped to CLIResult shape */ };
}
```

The shape proves the thesis: `server.ts`/`translate.ts` are untouched, the SDK loop replaces ~720 LOC of park-and-resolve, and the `canUseTool`-deny is the load-bearing trick that must survive Stage 0.

---

## 6. Effort estimate & go/no-go

| Stage | Work | Effort |
|---|---|---|
| **0 — Spike** | Verify effort buckets, `canUseTool`-deny parking, rate-limit on `SDKMessage` | **S** (1 day, throwaway) |
| **1 — Extract** | `engine/types.ts` + move CLI modules behind `engine/cli.ts`, flag wiring, test parity | **M** (2–3 days, zero behavior change) |
| **2 — Build SDK engine** | `engine/sdk.ts`: `query()`+MCP+`canUseTool`, re-home fuzzy-id, reuse retry/error-gate/pool-policy | **L** (1–2 weeks, the real work) |
| **3 — Parity validation** | 5-point live-cron test plan, flip default | **M** (3–5 days, mostly waiting on live crons) |

**Total: ~3–4 weeks of focused work**, front-loaded with a cheap go/no-go spike.

**Recommendation: GO on Stages 0–1; conditional GO on 2–3.**
- **Stage 0–1 are unconditionally worth it.** The spike is one day and de-risks everything; the extract is a clean invisible refactor that improves the codebase even if we never ship the SDK engine.
- **Proceed to Stage 2 only if Stage 0 confirms** all three unknowns — especially that `canUseTool`-deny actually parks resumably and that `--effort xhigh/max` has an equivalent. If either fails, **stop at Stage 1** and stay on CLI; the SDK can't meet parity and the migration is net-negative.
- **Flip the default to `sdk` only after Stage 3's five checks match the CLI engine**, with `CLAUDE_BRIDGE_ENGINE=cli` retained permanently as rollback.

**Still-uncertain, needs the Stage-0 spike to confirm (do not commit without):** (1) `--effort xhigh/max` SDK equivalence; (2) `canUseTool`-deny-as-handoff resumability across HTTP turns; (3) `rate_limit_event` exposure on `SDKMessage`; (4) V1 `resume` vs `unstable_v2_*` stability tradeoff for our per-turn model; (5) Path-D priming + `resume` not double-counting history. None of these is a code-level block we've *confirmed* impossible — they're the five things to prove before the bridge bets its core loop on the SDK.

---

**One-line summary for the standup:** The SDK keeps our $0-Max economics and deletes ~47% of the bridge (the whole park-and-resolve layer), so it's worth migrating — but behind a `CLAUDE_BRIDGE_ENGINE=cli|sdk` flag, default-CLI, gated on a one-day spike that proves the `canUseTool`-deny tool-parking trick and `--effort` parity, because those two are the only things that can quietly make it impossible.

---

## 7. Decision (2026-06-17, after an adversarial decision panel)

**DECISION: do NOT build the SDK engine now, and do NOT default to it. Keep the CLI as the default engine indefinitely. Build the SDK engine reactively, only when a real trigger fires. This document IS the ready-to-execute plan.**

### Two gating unknowns RESOLVED (favorably) by the panel

- **Tool-parking across an HTTP turn — PROVEN possible** in Meridian's production code (1.4k★), and the mechanism is now known to copy (NOT the `canUseTool`-deny we'd assumed):
  - in-process MCP server registers the client's tool defs (no-op handlers) so the model emits structured `tool_use` — registered **alphabetically for prompt-cache stability** (`src/proxy/passthroughTools.ts`);
  - a **`PreToolUse` hook returning `decision: "block"`** captures the tool_use and halts the turn (`src/proxy/server.ts`);
  - resume via **`resume: sessionId`** sending **only the new user message** (which carries the client's `tool_result`); the SDK reconstructs prior context (`src/proxy/query.ts`, `src/proxy/messages.ts`);
  - sessions re-matched by content fingerprints (`lineageHash`/`messageHashes`) if the client doesn't echo the session id.
  - **Caveat (per red-team):** the load-bearing block-hook + resume code was *attested in prose + one confirming comment*, only the no-op MCP server was quoted verbatim — **read Meridian's hook source directly before building Stage 2.**
  - **Sharp edges to design around (Meridian open issues):** #528 duplicate `tool_use` blocks on parallel tool calls; #496 model-side tool reliability; #516/#495 `400 "out of extra usage"` recurs through the proxy (same class we hit on jarvis 2026-06-10).
- **Effort `xhigh`/`max` — CONFIRMED** in installed `sdk.d.ts@0.3.156`: `effort?: EffortLevel` where `EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max'`. No regression. (`xhigh` silently downgrades to `high` on non-capable models — but the CLI drives the *same binary*, so no SDK-vs-CLI delta; nothing to assert per-request.)
- **Resume — STABLE** V1 top-level Option (no `unstable_*`/`@experimental` markers). Safe.
- **Rate-limit — exposed** via `SDKRateLimitEvent` (camelCase `status`/`utilization`/`resetsAt`); needs a small field-rename adapter vs today's stream-json. Minor.

### Why defer, and why NOT default to SDK

1. **No nameable benefit today.** Same `claude` binary, same OAuth/Max entitlement, same **account-wide shared quota** (proven in 2026-06-10 deep-dive — the wall is not per-engine), same $0, same latency. The only prize is maintenance relief, and it's collectable later.
2. **ToS asymmetry.** Anthropic's docs frame raw `claude -p` as *ordinary Claude Code use* (tolerated) but name the Agent SDK as the *build-products → use API key* path; `CLAUDE_CODE_OAUTH_TOKEN` is undocumented in the SDK types. Defaulting the fleet to the SDK voluntarily walks subscription traffic onto the more-restricted-as-documented lane. (Red-team softens "strictly dominated" → "weakly dominated under detection-uncertainty" — both drive the same binary/token so server-side distinguishability is unproven — but the precautionary call stands: don't volunteer onto it.)
3. **Maintenance relief is real but re-earned, not free.** ~1,100–1,300 LOC of incident-prone code collapses, but error-as-content, quota-window handling, and fuzzy-id get re-earned on the new substrate; net LOC ~flat, the cost is *trust* (weeks of live cron validation), not code.
4. **Anthropic promises advance notice** before any billing/auth change → the correct posture is reactive, not pre-paid.

### "Fall back to CLI if anything" — yes, but as an OPERATOR switch, not automatic

A per-request "try SDK, catch → CLI" fallback is **not achievable**: once a byte hits the SSE stream (`committed`), a retry corrupts it; a mid-conversation SDK session death can't fail over without a full re-prime; and every fallback **double-spends the shared Max quota**. The rollback must be a coarse env flip + restart (mirroring the existing `CLAUDE_BRIDGE_PATH_D=0` pattern), never a per-turn safety net.

### The ONE make-or-break hard gate (only when building)

**Stage-0 spike (~1 day): prove the SDK rides the same Keychain OAuth at $0 with no API key.** If it can't (forces per-token billing) or `CLAUDE_CODE_OAUTH_TOKEN` gets revoked for SDK use → the swap is pointless/impossible and this doc is the whole deliverable.

### Action taken now

This decision + the resolved unknowns recorded here. **Nothing built**: no `@anthropic-ai/claude-agent-sdk` dependency, no engine, no seam refactor, no default change. (The engine-seam refactor is also deferred — a single-implementation `Engine` interface is premature abstraction until the engine actually exists.)

### Triggers to revisit (build Stage 2 then)

Anthropic blesses Agent-SDK-over-subscription-OAuth as supported; OR the CLI path is deprecated/breaks unshimmably; OR the SDK delivers a benefit nameable in dollars/seconds/quota. None exist as of 2026-06-17.