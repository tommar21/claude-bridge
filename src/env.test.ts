import { test } from "node:test";
import assert from "node:assert/strict";
import { intEnv } from "./env.ts";

const KEY = "CLAUDE_BRIDGE_TEST_INT";

test("intEnv: parses a valid integer", () => {
  process.env[KEY] = "42";
  assert.equal(intEnv(KEY, 7), 42);
  delete process.env[KEY];
});

test("intEnv: missing or empty falls back to default", () => {
  delete process.env[KEY];
  assert.equal(intEnv(KEY, 7), 7);
  process.env[KEY] = "";
  assert.equal(intEnv(KEY, 7), 7);
  delete process.env[KEY];
});

test("intEnv: NaN value falls back instead of silently becoming 0/NaN", () => {
  // setTimeout(fn, NaN) fires immediately and `n >= NaN` is always false —
  // a NaN must never leak into config. These typo'd values must fall back.
  process.env[KEY] = "5min";
  assert.equal(intEnv(KEY, 300_000), 300_000);
  process.env[KEY] = "eight";
  assert.equal(intEnv(KEY, 8), 8);
  delete process.env[KEY];
});

test("intEnv: clamps to min and max", () => {
  process.env[KEY] = "0";
  assert.equal(intEnv(KEY, 8, { min: 1 }), 1);
  process.env[KEY] = "99999";
  assert.equal(intEnv(KEY, 8, { max: 100 }), 100);
  process.env[KEY] = "50";
  assert.equal(intEnv(KEY, 8, { min: 1, max: 100 }), 50);
  delete process.env[KEY];
});
