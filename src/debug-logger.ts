import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

interface DebugConfig {
  enabled: boolean;
  filePath: string;
}

let config: DebugConfig = { enabled: false, filePath: "" };

export function configureDebugLogger(opts: {
  enabled: boolean;
  filePath?: string;
}): void {
  if (!opts.enabled) {
    config = { enabled: false, filePath: "" };
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  // Default under a private, owner-only dir rather than world-readable /tmp:
  // these records contain raw prompt + model-output bodies. mkdir 0700 here +
  // append 0600 below keep them readable only by the bridge user.
  const filePath =
    opts.filePath ??
    path.join(
      os.homedir(),
      ".openclaw",
      "bridge-debug",
      `claude-bridge-debug-${date}.jsonl`,
    );
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  } catch {
    // Dir creation failed — the first append will throw and be swallowed
    // (debug logging must never crash the bridge). Leave config set.
  }
  config = { enabled: true, filePath };
}

/**
 * Append one JSON record to the debug log. No-op when disabled. Never
 * throws — debug logging must never crash the bridge. Unserializable
 * payloads (cycles, BigInts) are dropped silently.
 */
export function debugLog(record: Record<string, unknown>): void {
  if (!config.enabled) return;
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  } catch {
    // Cyclic or otherwise unserializable. Drop.
    return;
  }
  try {
    fs.appendFileSync(config.filePath, line, { mode: 0o600 });
  } catch {
    // Filesystem error — disk full, perms, etc. Drop.
  }
}

export function newRequestId(): string {
  return randomUUID();
}

/** sha256 truncated to first 16 hex chars. Useful for fingerprinting
 *  long values (system prompts, tool schemas) without logging them. */
export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
