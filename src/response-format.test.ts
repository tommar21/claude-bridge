import { test } from "node:test";
import assert from "node:assert/strict";
import type { CLIResult } from "./cli-worker.ts";
import {
  buildCompletionResponse,
  mapFinishReason,
  sanitizeClientError,
} from "./response-format.ts";

function result(over: Partial<CLIResult>): CLIResult {
  return {
    text: "",
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    stopReason: "end_turn",
    sessionId: "s",
    rateLimitStatus: undefined,
    modelVersion: undefined,
    ...over,
  };
}

test("mapFinishReason: tool calls always win", () => {
  assert.equal(mapFinishReason("end_turn", true), "tool_calls");
  assert.equal(mapFinishReason("tool_use", false), "tool_calls");
});

test("mapFinishReason: max_tokens->length, refusal->content_filter, else stop", () => {
  assert.equal(mapFinishReason("max_tokens", false), "length");
  assert.equal(mapFinishReason("refusal", false), "content_filter");
  assert.equal(mapFinishReason("end_turn", false), "stop");
  assert.equal(mapFinishReason("stop_sequence", false), "stop");
  assert.equal(mapFinishReason(undefined, false), "stop");
});

test("sanitizeClientError: strips stderr tail and CLI-exited body, keeps plain", () => {
  assert.equal(
    sanitizeClientError("CLI error: boom | stderr: /Users/secret/path leaked"),
    "CLI error: boom",
  );
  assert.equal(
    sanitizeClientError("CLI exited 1: /private/tmp/x a huge raw stderr dump"),
    "CLI exited 1",
  );
  assert.equal(sanitizeClientError("plain message"), "plain message");
});

test("buildCompletionResponse: usage + finish_reason for a max_tokens truncation", () => {
  const out = buildCompletionResponse(
    result({ text: "hi", inputTokens: 3, outputTokens: 4, stopReason: "max_tokens" }),
    "claude-haiku-4",
  );
  assert.equal(out.object, "chat.completion");
  const choice = (out.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice.finish_reason, "length");
  assert.equal((choice.message as Record<string, unknown>).content, "hi");
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test("buildCompletionResponse: tool calls -> tool_calls finish + serialized args", () => {
  const out = buildCompletionResponse(
    result({
      toolCalls: [{ id: "t1", name: "search", input: { q: "x" } }],
      inputTokens: 1,
      outputTokens: 1,
      stopReason: "tool_use",
    }),
    "m",
  );
  const choice = (out.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice.finish_reason, "tool_calls");
  const msg = choice.message as Record<string, unknown>;
  assert.equal(msg.content, null);
  const tc = (msg.tool_calls as Array<Record<string, unknown>>)[0];
  const fn = tc.function as Record<string, unknown>;
  assert.equal(fn.name, "search");
  assert.equal(fn.arguments, JSON.stringify({ q: "x" }));
});
