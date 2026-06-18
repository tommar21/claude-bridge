import { test } from "node:test";
import assert from "node:assert/strict";
import { toContentBlocks, buildPrompt } from "./translate.ts";

test("toContentBlocks: http(s) image_url -> url source", () => {
  const blocks = toContentBlocks([
    { type: "image_url", image_url: { url: "https://x.test/a.png" } },
  ]);
  assert.deepEqual(blocks, [
    { type: "image", source: { type: "url", url: "https://x.test/a.png" } },
  ]);
});

test("toContentBlocks: base64 data URL -> base64 source", () => {
  const blocks = toContentBlocks([
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
  assert.deepEqual(blocks, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
  ]);
});

test("toContentBlocks: non-base64 data URL is decoded to base64, not passed as a url", () => {
  // Regression: the old code fell through to a {type:'url'} source for any
  // non-`;base64,` data URL, handing Anthropic an unfetchable data: URL.
  const blocks = toContentBlocks([
    { type: "image_url", image_url: { url: "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E" } },
  ]);
  assert.equal(blocks.length, 1);
  const src = (blocks[0] as { source: { type: string; media_type?: string; data?: string } }).source;
  assert.equal(src.type, "base64");
  assert.equal(src.media_type, "image/svg+xml");
  assert.equal(Buffer.from(src.data ?? "", "base64").toString("utf-8"), "<svg></svg>");
});

test("buildPrompt: tool_call args are re-stringified to valid JSON; name is escaped", () => {
  const out = buildPrompt({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          // malformed/empty arguments + a name with a quote
          { id: "c1", type: "function", function: { name: 'we"ird', arguments: "" } },
        ],
      },
    ],
  });
  // Empty arguments -> {} ; name JSON-escaped -> the embedded JSON parses.
  const m = out.prompt.match(/<tool_call>(.*)<\/tool_call>/s);
  assert.ok(m, "has a <tool_call> block");
  const parsed = JSON.parse(m![1]);
  assert.equal(parsed.name, 'we"ird');
  assert.deepEqual(parsed.arguments, {});
});

test("buildPrompt: tool_result attribute id is XML-escaped", () => {
  const out = buildPrompt({
    model: "m",
    messages: [{ role: "tool", tool_call_id: 'a"b<c', content: "result text" }],
  });
  assert.match(out.prompt, /tool_call_id="a&quot;b&lt;c"/);
});

test("toContentBlocks: string content becomes single text block", () => {
  assert.deepEqual(toContentBlocks("hello"), [{ type: "text", text: "hello" }]);
});

test("toContentBlocks: empty string becomes empty array", () => {
  assert.deepEqual(toContentBlocks(""), []);
});

test("toContentBlocks: null/undefined becomes empty array", () => {
  assert.deepEqual(toContentBlocks(null), []);
  assert.deepEqual(toContentBlocks(undefined), []);
});

test("toContentBlocks: text part preserved", () => {
  assert.deepEqual(
    toContentBlocks([{ type: "text", text: "hi" }]),
    [{ type: "text", text: "hi" }],
  );
});

test("toContentBlocks: data-URL image becomes base64 image block", () => {
  const result = toContentBlocks([
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    },
  ]);
  assert.deepEqual(result, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    },
  ]);
});

test("toContentBlocks: http image URL becomes url image block", () => {
  const result = toContentBlocks([
    { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
  ]);
  assert.deepEqual(result, [
    {
      type: "image",
      source: { type: "url", url: "https://example.com/cat.png" },
    },
  ]);
});

test("toContentBlocks: mixed text + image preserved in order", () => {
  const result = toContentBlocks([
    { type: "text", text: "look at this:" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "text");
  assert.equal(result[1].type, "image");
});

test("toContentBlocks: data-URL with charset param parses correctly", () => {
  const result = toContentBlocks([
    {
      type: "image_url",
      image_url: { url: "data:image/png;charset=utf-8;base64,XYZ=" },
    },
  ]);
  assert.deepEqual(result, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "XYZ=" },
    },
  ]);
});

test("toContentBlocks: image_url without url is dropped", () => {
  const result = toContentBlocks([
    // @ts-expect-error — runtime data without required url field
    { type: "image_url", image_url: {} },
    { type: "text", text: "hi" },
  ]);
  assert.deepEqual(result, [{ type: "text", text: "hi" }]);
});

import { extractForPathD } from "./translate.ts";

test("extractForPathD: last user text → lastUserContent has text block", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hola" },
    ],
  });
  assert.ok(result, "extractForPathD returned null");
  assert.equal(result.systemPrompt, "be helpful");
  assert.deepEqual(result.lastUserContent, [{ type: "text", text: "hola" }]);
  assert.equal(result.pendingToolResult, null);
});

test("extractForPathD: last user with image preserves image block", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,XYZ" },
          },
        ],
      },
    ],
  });
  assert.ok(result);
  assert.equal(result.lastUserContent.length, 2);
  assert.equal(result.lastUserContent[0].type, "text");
  assert.equal(result.lastUserContent[1].type, "image");
});

test("extractForPathD: role=tool → pendingToolResult.content is content blocks", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "user", content: "do thing" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "the result", tool_call_id: "call_1" },
    ],
  });
  assert.ok(result);
  assert.deepEqual(result.lastUserContent, []);
  assert.deepEqual(result.pendingToolResult, {
    toolUseId: "call_1",
    content: [{ type: "text", text: "the result" }],
  });
});

test("extractForPathD: anthropic-style tool_result in user message preserves structure", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "user", content: "x" },
      {
        role: "user",
        content: [
          {
            // @ts-expect-error — adapter shape, not in OAIContentPart
            type: "tool_result",
            tool_use_id: "call_2",
            content: [
              { type: "text", text: "row 1" },
              { type: "text", text: "row 2" },
            ],
          },
        ],
      },
    ],
  });
  assert.ok(result);
  assert.deepEqual(result.pendingToolResult, {
    toolUseId: "call_2",
    content: [
      { type: "text", text: "row 1" },
      { type: "text", text: "row 2" },
    ],
  });
});

test("extractForPathD: single user message → primingPrompt undefined", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hola" },
    ],
  });
  assert.ok(result);
  assert.equal(result.primingPrompt, undefined);
});

test("extractForPathD: multi-turn history → primingPrompt populated with full XML history", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "system", content: "be helpful" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ],
  });
  assert.ok(result);
  assert.ok(result.primingPrompt, "primingPrompt should be populated");
  // Must include both user turns and the prior assistant turn
  assert.ok(result.primingPrompt.includes("first question"));
  assert.ok(result.primingPrompt.includes("first answer"));
  assert.ok(result.primingPrompt.includes("second question"));
  // System should NOT appear in primingPrompt (it's passed via --system-prompt)
  assert.ok(!result.primingPrompt.includes("be helpful"));
});

test("extractForPathD: tool-result continuation also populates primingPrompt", () => {
  // Even if the conversation has many turns, when the LATEST is a tool_result,
  // primingPrompt is still computed (history count > 1). Whether to use it is
  // enqueuePersistent's decision based on isFresh.
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "user", content: "do thing" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "the result", tool_call_id: "call_1" },
    ],
  });
  assert.ok(result);
  assert.ok(result.primingPrompt);
  assert.ok(result.pendingToolResult);
});
