/** Detector for CLI "error-as-content" responses.
 *
 *  The Claude CLI (OAuth/Max path) prints upstream API failures as plain
 *  stdout text — e.g. `API Error: 400 {"type":"error",...}` — instead of
 *  exiting non-zero or emitting an error result event. Without this check
 *  the bridge happily returns that text as the assistant completion, so
 *  callers (Hermes, openclaw) never see a real error and their retry /
 *  fallback logic never fires. Seen in production as jarvis replying
 *  "API Error: 400 ... out of extra usage" to a plain "hola".
 *
 *  Kept as a zero-import pure module so the test runner stays happy under
 *  --experimental-strip-types (same pattern as session-pool-decision.ts).
 */

/** Strict prefix: the CLI error line always starts with "API Error:"
 *  followed by an HTTP status code. Anchored + status-digit-checked so a
 *  legitimate assistant reply that merely *mentions* "API Error" later in
 *  the text never matches. */
const ERROR_AS_CONTENT_RE = /^\s*API Error:\s*\d{3}\b/;

/** How many leading chars we need before we can decide. "API Error: 400"
 *  is 14 chars; 24 gives slack for leading whitespace. Streaming handlers
 *  buffer up to this many chars before forwarding the first delta. */
export const ERROR_SNIFF_CHARS = 24;

/** True when the accumulated assistant text IS a CLI-printed API error
 *  (not a real completion). Callers should only trust this when the turn
 *  produced no tool calls. */
export function isErrorAsContent(text: string): boolean {
  return ERROR_AS_CONTENT_RE.test(text);
}

/** True when `text` (a partial prefix) could still turn out to be an
 *  error-as-content response once more chars arrive. Used by the streaming
 *  gate: keep buffering while this holds and the prefix is shorter than
 *  ERROR_SNIFF_CHARS. */
export function couldBeErrorAsContent(text: string): boolean {
  if (text.length >= ERROR_SNIFF_CHARS) return isErrorAsContent(text);
  const probe = "API Error: 400";
  const trimmed = text.replace(/^\s*/, "");
  return probe.startsWith(trimmed) || isErrorAsContent(text);
}
