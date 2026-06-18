import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChatRequest } from "./request-validate.ts";

test("validateChatRequest: accepts a normal request", () => {
  const r = validateChatRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.ok, true);
});

test("validateChatRequest: rejects a non-object body", () => {
  assert.equal(validateChatRequest("nope").ok, false);
  assert.equal(validateChatRequest(null).ok, false);
  assert.equal(validateChatRequest(42).ok, false);
});

test("validateChatRequest: rejects empty or missing messages", () => {
  assert.equal(validateChatRequest({ messages: [] }).ok, false);
  assert.equal(validateChatRequest({ model: "m" }).ok, false);
  assert.equal(validateChatRequest({ messages: "x" }).ok, false);
});

test("validateChatRequest: rejects a bad/missing role", () => {
  assert.equal(validateChatRequest({ messages: [{ role: "robot", content: "x" }] }).ok, false);
  assert.equal(validateChatRequest({ messages: [{ content: "x" }] }).ok, false);
  assert.equal(validateChatRequest({ messages: [null] }).ok, false);
});

test("validateChatRequest: accepts well-formed assistant tool_calls", () => {
  const r = validateChatRequest({
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }],
      },
    ],
  });
  assert.equal(r.ok, true);
});

test("validateChatRequest: rejects malformed tool_calls", () => {
  assert.equal(
    validateChatRequest({
      messages: [{ role: "assistant", tool_calls: [{ id: "c", type: "function", function: {} }] }],
    }).ok,
    false,
  );
  assert.equal(
    validateChatRequest({ messages: [{ role: "assistant", tool_calls: "nope" }] }).ok,
    false,
  );
});
