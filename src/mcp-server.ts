/**
 * Standalone MCP stdio server spawned by Claude CLI per request.
 *
 * Purpose: advertise caller-supplied tool schemas to the CLI so Claude emits
 * structured `tool_use` blocks (parseable from stream-json) instead of the
 * XML-in-text we used before. The bridge runs Claude with permissions denied
 * for these tools, so `tools/call` should never be invoked in practice — but
 * we still return a valid response if it is, so the CLI doesn't hang.
 */

import * as fs from "node:fs";
import { BRIDGE_VERSION } from "./version.js";

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

const [, , toolsPath] = process.argv;
if (!toolsPath) {
  process.stderr.write("[mcp-server] missing tools file argv\n");
  process.exit(1);
}

let tools: McpTool[];
try {
  tools = JSON.parse(fs.readFileSync(toolsPath, "utf-8")) as McpTool[];
} catch (err) {
  process.stderr.write(
    `[mcp-server] failed to load tools: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

process.stdin.setEncoding("utf-8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as JsonRpcMessage);
    } catch (err) {
      log(
        `parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
});

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(msg: string): void {
  process.stderr.write(`[mcp-server] ${msg}\n`);
}

function handle(msg: JsonRpcMessage): void {
  if (!msg.method) return;

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-bridge", version: BRIDGE_VERSION },
      },
    });
    return;
  }

  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    return;
  }

  if (msg.method === "tools/call") {
    // Bridge denies permissions upstream, so reaching here means a fallback
    // path. Return a benign placeholder instead of hanging.
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [
          { type: "text", text: "TOOL_DEFERRED_TO_BRIDGE_CALLER" },
        ],
        isError: false,
      },
    });
    return;
  }

  if (msg.method.startsWith("notifications/")) return;

  send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: `method not found: ${msg.method}` },
  });
}

log(`started with ${tools.length} tool(s)`);
