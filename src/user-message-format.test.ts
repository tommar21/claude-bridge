import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUserMessageLine } from "./user-message-format.ts";

test("formatUserMessageLine: text block produces correct stream-json line", () => {
  const line = formatUserMessageLine([{ type: "text", text: "hi" }]);
  // Trailing newline is required for stream-json line-delimited input
  assert.ok(line.endsWith("\n"));
  const parsed = JSON.parse(line);
  assert.equal(parsed.type, "user");
  assert.equal(parsed.message.role, "user");
  assert.deepEqual(parsed.message.content, [{ type: "text", text: "hi" }]);
});

test("formatUserMessageLine: image block preserved in JSON", () => {
  const block = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png", data: "XYZ" },
  };
  const line = formatUserMessageLine([block]);
  const parsed = JSON.parse(line);
  assert.deepEqual(parsed.message.content, [block]);
});

test("formatUserMessageLine: empty array still produces valid stream-json line", () => {
  // sendUserMessage filters empties before calling, but the helper itself
  // doesn't enforce that — keep behavior pure.
  const line = formatUserMessageLine([]);
  const parsed = JSON.parse(line);
  assert.deepEqual(parsed.message.content, []);
});
