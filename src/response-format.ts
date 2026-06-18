import type { CLIResult, CLIToolCall } from "./cli-worker.js";

/** Map the Claude/Anthropic stop_reason to a valid OpenAI finish_reason.
 *  OpenAI's enum is {stop, length, tool_calls, content_filter, function_call}.
 *  Every terminal site previously emitted just `hasToolCalls ? "tool_calls" :
 *  "stop"`, discarding the real stop_reason — so a max-tokens truncation was
 *  reported as a normal "stop" and a caller couldn't tell the reply was cut
 *  off. */
export function mapFinishReason(
  stopReason: string | undefined,
  hasToolCalls: boolean,
): string {
  if (hasToolCalls) return "tool_calls";
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    // end_turn, stop_sequence, pause_turn, undefined → normal stop
    default:
      return "stop";
  }
}

/** Strip raw `claude` CLI stderr from an error message before it reaches the
 *  HTTP client. The CLI worker appends stderr as a " | stderr: …" tail (and
 *  emits "CLI exited N: <stderr>") which can contain absolute file paths or
 *  auth-state hints. The full message still goes to structured logs and to the
 *  retry classifier — only the client-facing copy is trimmed. */
export function sanitizeClientError(message: string): string {
  let m = message;
  const sIdx = m.indexOf(" | stderr:");
  if (sIdx >= 0) m = m.slice(0, sIdx);
  m = m.replace(/^(CLI exited -?\d+):[\s\S]*$/, "$1");
  return m;
}

function toOAIToolCall(tc: CLIToolCall): Record<string, unknown> {
  return {
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input ?? {}),
    },
  };
}

export function buildCompletionResponse(
  result: CLIResult,
  modelId: string,
): Record<string, unknown> {
  const hasToolCalls = result.toolCalls.length > 0;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text || null,
  };
  if (hasToolCalls) {
    message.tool_calls = result.toolCalls.map(toOAIToolCall);
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(result.stopReason, hasToolCalls),
      },
    ],
    usage: {
      prompt_tokens: result.inputTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.inputTokens + result.outputTokens,
    },
  };
}
