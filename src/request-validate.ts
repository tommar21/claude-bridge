import type { OAIChatRequest } from "./translate.js";

export type ValidatedRequest =
  | { ok: true; req: OAIChatRequest }
  | { ok: false; error: string };

const ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Permissive structural validation of an incoming OpenAI chat request.
 *
 *  Deliberately lenient: real OpenAI-compatible clients (the matrix gateway,
 *  Hermes) always satisfy this, so it won't reject live traffic. The point is
 *  to turn clearly-malformed bodies into a clean 400 instead of letting an
 *  `as`-cast blow up deep in the pipeline (e.g. buildPrompt reading
 *  `tc.function.name` on a non-object). It does NOT enforce optional-field
 *  types — well-formed-but-unusual requests pass through unchanged; `model`,
 *  `tools`, `stream`, `user` etc. stay guarded by their downstream consumers
 *  (resolveModel passthrough, toolsFromRequest, …). */
export function validateChatRequest(raw: unknown): ValidatedRequest {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "messages must be a non-empty array" };
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m !== "object" || m === null) {
      return { ok: false, error: `messages[${i}] must be an object` };
    }
    const role = (m as Record<string, unknown>).role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      return {
        ok: false,
        error: `messages[${i}].role must be one of system|user|assistant|tool`,
      };
    }
    // Guard the one shape buildPrompt trusts blindly: assistant.tool_calls
    // entries must carry a function.name string (it reads tc.function.name /
    // tc.function.arguments). Reject malformed tool_calls up front.
    const tc = (m as Record<string, unknown>).tool_calls;
    if (tc !== undefined) {
      if (!Array.isArray(tc)) {
        return { ok: false, error: `messages[${i}].tool_calls must be an array` };
      }
      for (let j = 0; j < tc.length; j++) {
        const entry = tc[j] as Record<string, unknown> | null;
        const fn = entry?.function as Record<string, unknown> | undefined;
        if (!fn || typeof fn.name !== "string") {
          return {
            ok: false,
            error: `messages[${i}].tool_calls[${j}].function.name must be a string`,
          };
        }
      }
    }
  }
  return { ok: true, req: raw as OAIChatRequest };
}
