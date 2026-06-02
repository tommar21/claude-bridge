/**
 * Parses Claude CLI `--output-format stream-json --verbose` events.
 *
 * We collect assistant text and structured tool_use blocks from the first
 * turn only — later events (user messages the CLI fabricates for permission
 * denials, follow-up assistant outputs) are ignored because our flow is
 * single-shot: the bridge hands tool_use back to the caller to execute.
 */

export interface StreamToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StreamResult {
  text: string;
  toolUses: StreamToolUse[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  rateLimitStatus: string | undefined;
  /**
   * The model version the upstream actually resolved + used, as reported
   * by the Claude CLI in its assistant message envelope. Caller passes
   * `--model opus` (alias), upstream resolves to e.g. `claude-opus-4-5-20251201`.
   * Surface this so the UI / metrics can show which concrete version each
   * cron run actually hit (useful when Anthropic ships a new variant
   * silently under the same alias).
   */
  modelVersion: string | undefined;
  isError: boolean;
  errorMessage: string | undefined;
}

interface AssistantContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamEvent {
  type?: string;
  message?: {
    content?: AssistantContentBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string | null;
    /** Resolved model version (e.g. "claude-opus-4-5-20251201") — present
     *  on assistant events from the Claude CLI's stream-json output. */
    model?: string;
  };
  rate_limit_info?: { status?: string };
  subtype?: string;
  is_error?: boolean;
  errors?: string[];
  stop_reason?: string;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function* linesOf(
  readable: NodeJS.ReadableStream,
): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of readable) {
    buffer += (chunk as Buffer).toString("utf-8");
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
    }
  }
  if (buffer.trim()) yield buffer;
}

/**
 * Live event handlers. Fire as structured events are parsed, before the
 * final StreamResult resolves. Use these to forward deltas to an SSE
 * stream instead of waiting for the CLI to finish. Omit them for the
 * classic "buffer everything" behavior used by non-streaming callers.
 * Handlers should stay synchronous; they run inline on the parse loop.
 */
export interface StreamEventHandlers {
  onTextDelta?: (delta: string) => void;
  onToolUse?: (tu: StreamToolUse) => void;
}

export async function parseStream(
  lines: AsyncIterable<string>,
  handlers?: StreamEventHandlers,
): Promise<StreamResult> {
  let text = "";
  const toolUses: StreamToolUse[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  let rateLimitStatus: string | undefined;
  let modelVersion: string | undefined;
  let isError = false;
  let errorMessage: string | undefined;
  let sawUserInjection = false;

  for await (const line of lines) {
    if (!line.trim()) continue;
    let evt: StreamEvent;
    try {
      evt = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }

    if (evt.type === "rate_limit_event") {
      rateLimitStatus = evt.rate_limit_info?.status;
      continue;
    }

    if (evt.type === "assistant" && !sawUserInjection) {
      const content = evt.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
          handlers?.onTextDelta?.(block.text);
        } else if (block.type === "tool_use" && block.id && block.name) {
          const tu: StreamToolUse = {
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          };
          toolUses.push(tu);
          handlers?.onToolUse?.(tu);
        }
      }
      // Capture the resolved model version on the first assistant event
      // we see. Subsequent events on the same turn carry the same model,
      // so only-first is fine; we don't need to re-set on every chunk.
      if (!modelVersion && typeof evt.message?.model === "string") {
        modelVersion = evt.message.model;
      }
      const usage = evt.message?.usage;
      if (usage) {
        if (typeof usage.input_tokens === "number")
          inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number")
          outputTokens = usage.output_tokens;
      }
      continue;
    }

    if (evt.type === "user") {
      // CLI injected a synthetic user message (typically a permission-denied
      // tool_result). The bridge operates single-shot, so freeze here.
      sawUserInjection = true;
      continue;
    }

    if (evt.type === "result") {
      if (typeof evt.stop_reason === "string") stopReason = evt.stop_reason;
      if (evt.usage) {
        if (typeof evt.usage.input_tokens === "number")
          inputTokens = evt.usage.input_tokens;
        if (typeof evt.usage.output_tokens === "number")
          outputTokens = evt.usage.output_tokens;
      }
      if (evt.is_error === true) {
        errorMessage =
          evt.errors?.[0] ?? (typeof evt.result === "string" ? evt.result : undefined);
        // Only escalate to error if nothing useful came out of the turn.
        // Max-turns errors AFTER a tool_use are expected and not real errors.
        isError = toolUses.length === 0 && stopReason !== "tool_use";
      }
      break;
    }
  }

  return {
    text,
    toolUses,
    inputTokens,
    outputTokens,
    stopReason,
    rateLimitStatus,
    modelVersion,
    isError,
    errorMessage,
  };
}
