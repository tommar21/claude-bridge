import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// True HTTP integration test for server.ts. Under --experimental-strip-types a
// test cannot import server.ts (its local `.js` imports don't resolve to .ts),
// so we exercise the real HTTP surface end-to-end: build dist, start the bridge
// on a throwaway port with a FAKE `claude` on PATH (no real quota burned), and
// drive it over fetch. Forces the legacy engine (no `user` field + PATH_D=0) so
// the fake binary is all that's needed.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PORT = 13999;
let proc: ChildProcess | undefined;
let fakeBin = "";

const base = `http://127.0.0.1:${PORT}`;

before(async () => {
  // server.ts isn't importable under strip-types — test the built artifact.
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });

  // Fake `claude`: drain stdin, emit one assistant turn + a result, exit 0.
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-bin-"));
  const fake = path.join(fakeBin, "claude");
  const assistant =
    '{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}],"usage":{"input_tokens":3,"output_tokens":1},"model":"claude-haiku-4-5"}}';
  const result =
    '{"type":"result","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}';
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env bash\ncat > /dev/null\nprintf '%s\\n' '${assistant}'\nprintf '%s\\n' '${result}'\nexit 0\n`,
  );
  fs.chmodSync(fake, 0o755);

  proc = spawn("node", [path.join(root, "dist", "index.js")], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CLAUDE_BRIDGE_PORT: String(PORT),
      CLAUDE_BRIDGE_MCP_PORT: "0",
      CLAUDE_BRIDGE_PATH_D: "0", // force the legacy spawn path
      CLAUDE_BRIDGE_MAX_BODY_BYTES: "65536", // the floor intEnv allows; test 413 above it
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("bridge did not start in time");
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  try {
    proc?.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  try {
    if (fakeBin) fs.rmSync(fakeBin, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("GET /health -> ok + version", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const j: any = await r.json();
  assert.equal(j.status, "ok");
  assert.equal(typeof j.version, "string");
});

test("GET /v1/models -> the three bridge ids", async () => {
  const r = await fetch(`${base}/v1/models`);
  assert.equal(r.status, 200);
  const j: any = await r.json();
  const ids = j.data.map((m: any) => m.id).sort();
  assert.deepEqual(ids, ["claude-haiku-4", "claude-opus-4", "claude-sonnet-4"]);
});

test("unknown route -> 404", async () => {
  const r = await fetch(`${base}/nope`);
  assert.equal(r.status, 404);
});

test("POST /v1/chat/completions (non-streaming) -> completion via the fake CLI", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 200);
  const j: any = await r.json();
  assert.equal(j.object, "chat.completion");
  assert.equal(j.choices[0].message.content, "pong");
  assert.equal(j.choices[0].finish_reason, "stop");
  assert.equal(j.usage.total_tokens, 4);
});

test("POST with empty messages -> 400", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(r.status, 400);
});

test("POST with a bad role -> 400 with a clear message", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "robot", content: "x" }] }),
  });
  assert.equal(r.status, 400);
  const j: any = await r.json();
  assert.match(j.error.message, /role must be one of/);
});

test("POST with an oversized body -> 413", async () => {
  const big = "x".repeat(100000); // > the 65536 cap
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: big }] }),
  });
  assert.equal(r.status, 413);
  const j: any = await r.json();
  assert.match(j.error.message, /too large/i);
});

test("streaming -> SSE chunks (role, content, finish, [DONE])", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await r.text();
  assert.match(text, /"role":"assistant"/);
  assert.match(text, /"content":"pong"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});
