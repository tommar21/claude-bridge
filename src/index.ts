import { BRIDGE_VERSION, startServer } from "./server.js";
import {
  cleanupStaleTempFiles,
  configurePathD,
  configurePool,
} from "./cli-worker.js";
import { BridgeMcpHttpServer } from "./mcp-http.js";
import { PersistentSessionPool } from "./session-pool.js";
import { configureDebugLogger } from "./debug-logger.js";

const port = parseInt(process.env.CLAUDE_BRIDGE_PORT ?? "3456", 10);
const host = process.env.CLAUDE_BRIDGE_HOST ?? "127.0.0.1";
const timeoutMs = parseInt(process.env.CLAUDE_BRIDGE_TIMEOUT_MS ?? "300000", 10);
const maxConcurrent = parseInt(
  process.env.CLAUDE_BRIDGE_MAX_CONCURRENT ?? "8",
  10,
);
const maxSessions = parseInt(
  process.env.CLAUDE_BRIDGE_MAX_SESSIONS ?? "200",
  10,
);

// Path D (persistent CLI per session + in-process MCP) is now the default
// since v3.5.0 — validated in production with orphanRecoveries=0% after
// the v3.4.4 fuzzy-id-lookup fix. Set CLAUDE_BRIDGE_PATH_D=0 to revert to
// the legacy spawn-fresh path if needed. The plumbing always starts (MCP
// server + session pool); cli-worker.ts only routes to them when the flag
// is true (which it now is unless explicitly disabled).
const pathDEnabled = !/^(0|false|no|off)$/i.test(
  process.env.CLAUDE_BRIDGE_PATH_D ?? "1",
);
const pathDPort = parseInt(process.env.CLAUDE_BRIDGE_MCP_PORT ?? "0", 10);

const debugPromptEnabled = /^(1|true|yes|on)$/i.test(
  process.env.CLAUDE_BRIDGE_DEBUG_PROMPT ?? "",
);
const debugPromptFile = process.env.CLAUDE_BRIDGE_DEBUG_PROMPT_FILE;

configurePool({ timeoutMs, maxConcurrent, maxSessions });
configureDebugLogger({
  enabled: debugPromptEnabled,
  filePath: debugPromptFile,
});
cleanupStaleTempFiles();

const mcpServer = new BridgeMcpHttpServer();
const mcpPort = await mcpServer.start(pathDPort, "127.0.0.1");
const sessionPool = new PersistentSessionPool({
  mcpServer,
  config: {
    idleEvictMs: parseInt(process.env.CLAUDE_BRIDGE_IDLE_EVICT_MS ?? "600000", 10),
    maxLifetimeMs: parseInt(process.env.CLAUDE_BRIDGE_MAX_LIFETIME_MS ?? "3600000", 10),
    maxSessions: parseInt(process.env.CLAUDE_BRIDGE_MAX_PERSISTENT_SESSIONS ?? "32", 10),
    nextCheckpointTimeoutMs: timeoutMs,
  },
});

configurePathD({ enabled: pathDEnabled, mcpServer, sessionPool });

console.log("╔══════════════════════════════════════════╗");
console.log(`║        Claude Bridge v${BRIDGE_VERSION}              ║`);
console.log("║  OpenAI ↔ Claude CLI + MCP tools         ║");
console.log("╚══════════════════════════════════════════╝");
console.log("");
console.log(`  Timeout:        ${timeoutMs}ms`);
console.log(`  Max concurrent: ${maxConcurrent}`);
console.log(`  Max sessions:   ${maxSessions}`);
console.log(`  Bind:           ${host}:${port}`);
console.log(`  API:            http://${host}:${port}/v1/chat/completions`);
console.log(`  Path D:         ${pathDEnabled ? "enabled" : "disabled"} (MCP on 127.0.0.1:${mcpPort})`);
console.log(
  `  Debug log:      ${debugPromptEnabled ? `enabled (${debugPromptFile ?? `/tmp/claude-bridge-debug-${new Date().toISOString().slice(0, 10)}.jsonl`})` : "disabled"}`,
);
console.log("");

startServer({ port, host });

// Bridge shutdown path already drains CLIs — extend it to also stop the
// MCP server + persistent pool on SIGTERM/SIGINT.
async function shutdownExtras(): Promise<void> {
  await sessionPool.shutdown();
  await mcpServer.stop();
}
process.on("SIGTERM", () => {
  void shutdownExtras();
});
process.on("SIGINT", () => {
  void shutdownExtras();
});
