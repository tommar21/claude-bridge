import { test } from "node:test";
import assert from "node:assert";
import {
  couldBeErrorAsContent,
  isErrorAsContent,
} from "./error-as-content.ts";

const REAL_ERROR =
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CbujMNeskwtUgPrUt3i9a"}';

test("matches the production out-of-extra-usage error verbatim", () => {
  assert.equal(isErrorAsContent(REAL_ERROR), true);
});

test("matches other status codes and leading whitespace", () => {
  assert.equal(isErrorAsContent("API Error: 429 {}"), true);
  assert.equal(isErrorAsContent("  API Error: 529 overloaded"), true);
});

test("does not match normal replies", () => {
  assert.equal(isErrorAsContent("Hola jefe, ¿qué hacés?"), false);
  assert.equal(isErrorAsContent(""), false);
});

test("does not match replies that merely mention API errors", () => {
  assert.equal(
    isErrorAsContent("Che, ayer vi un API Error: 400 en los logs de jarvis"),
    false,
  );
  assert.equal(isErrorAsContent("API Error: sin código no cuenta"), false);
});

test("couldBeErrorAsContent buffers plausible prefixes only", () => {
  // Prefixes of the error line keep buffering...
  assert.equal(couldBeErrorAsContent("API"), true);
  assert.equal(couldBeErrorAsContent("API Error: 4"), true);
  // ...but ordinary openers flush immediately.
  assert.equal(couldBeErrorAsContent("Hola"), false);
  assert.equal(couldBeErrorAsContent("Dale,"), false);
  // Long-enough accumulations resolve to the strict check.
  assert.equal(couldBeErrorAsContent(REAL_ERROR), true);
  assert.equal(
    couldBeErrorAsContent("API Error happened yesterday, te cuento"),
    false,
  );
});
