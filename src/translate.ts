// ─── OpenAI Types (kept for request parsing) ───────────────────────────────

export interface OAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OAIContentPart[] | null;
  name?: string;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

export interface OAIChatRequest {
  model: string;
  messages: OAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: OAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  stop?: string | string[];
  user?: string;
}

// ─── Anthropic Content Blocks ───────────────────────────────────────────────

export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: ContentBlock[] | string;
      is_error?: boolean;
    };

/**
 * Convert OpenAI-shape message content into Anthropic content blocks.
 * Preserves images (both data-URL and http) and text. Unknown OAI part
 * types are dropped silently — caller should validate upstream.
 */
export function toContentBlocks(content: OAIMessage["content"]): ContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: String(content) }];
  }
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text != null) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" && part.image_url?.url) {
      const block = toImageBlock(part.image_url);
      if (block) blocks.push(block);
    }
    // unknown types: drop. Stage 1 only handles text + image.
  }
  return blocks;
}

/** Translate an OpenAI image_url into an Anthropic image block.
 *
 *  Returns null (drop) for anything we can't represent, rather than handing
 *  Anthropic a non-fetchable `data:` URL as if it were an http source — the
 *  old code fell through to a `{type:"url"}` source for ANY non-`;base64,`
 *  input (e.g. `data:image/svg+xml;utf8,<svg>`), which Anthropic rejects. */
export function toImageBlock(image: { url: string; detail?: string }): ContentBlock | null {
  const url = image.url;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { type: "image", source: { type: "url", url } };
  }
  // data:<media-type>[;<param>...];base64,<data>  (multi-param per RFC 2397)
  const base64Match = url.match(/^data:([^;,]+)(?:;[^;,=]+(?:=[^;,]*)?)*;base64,(.+)$/);
  if (base64Match) {
    return {
      type: "image",
      source: { type: "base64", media_type: base64Match[1], data: base64Match[2] },
    };
  }
  // Inline (non-base64) data URL, e.g. data:image/svg+xml,<svg...> or
  // data:image/png;utf8,...  — decode the payload to base64 so Anthropic gets
  // a valid base64 source instead of an unfetchable data: URL.
  const inlineMatch = url.match(/^data:([^;,]+)(?:;[^;,]+)*,(.*)$/);
  if (inlineMatch) {
    try {
      const data = Buffer.from(decodeURIComponent(inlineMatch[2]), "utf-8").toString("base64");
      return { type: "image", source: { type: "base64", media_type: inlineMatch[1], data } };
    } catch {
      return null;
    }
  }
  return null;
}

/** Escape a string for safe interpolation into an XML attribute / element. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Re-stringify OpenAI tool-call arguments to guaranteed-valid JSON. The OAI
 *  `arguments` string is valid JSON only by convention; if it's empty or
 *  malformed, embedding it raw produced corrupt JSON inside <tool_call>. */
function safeJsonArgs(raw: string | undefined): string {
  if (!raw) return "{}";
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return "{}";
  }
}

// ─── Prompt Building ────────────────────────────────────────────────────────

export interface BuiltPrompt {
  prompt: string;
  systemPrompt: string | undefined;
}

/**
 * Assemble the text sent to Claude CLI.
 *
 * Tool definitions are no longer injected here — they are registered through
 * an MCP stdio server so the model sees them as structured tools. Historical
 * tool_calls and tool_result messages still need narration because Claude CLI
 * stores its own session state and we don't rewrite that state; the narration
 * keeps the model grounded when a session is resumed or a new session is
 * primed with prior turns.
 */
export function buildPrompt(oai: OAIChatRequest): BuiltPrompt {
  const systemParts: string[] = [];
  const conversationParts: string[] = [];

  for (const msg of oai.messages) {
    if (msg.role === "system") {
      systemParts.push(extractText(msg.content));
    }
  }

  for (const msg of oai.messages) {
    switch (msg.role) {
      case "system":
        break;
      case "user":
        conversationParts.push(extractText(msg.content));
        break;
      case "assistant": {
        const text = extractText(msg.content);
        const toolParts: string[] = [];
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            // JSON.stringify the name (proper escaping inside the JSON literal)
            // and re-stringify arguments so the embedded JSON is always valid,
            // even if the caller sent an empty/malformed `arguments` string.
            toolParts.push(
              `<tool_call>{"name":${JSON.stringify(tc.function.name)},"arguments":${safeJsonArgs(tc.function.arguments)}}</tool_call>`,
            );
          }
        }
        const combined = [text, ...toolParts].filter(Boolean).join("\n");
        if (combined) {
          conversationParts.push(`<previous_response>${combined}</previous_response>`);
        }
        break;
      }
      case "tool":
        // Escape only the attribute value (a stray `"` would break the tag).
        // The body is left as-is on purpose: it's narration the model reads,
        // and escaping `<`/`>` would corrupt code/markup inside tool results.
        conversationParts.push(
          `<tool_result tool_call_id="${xmlEscape(msg.tool_call_id ?? "")}">${extractText(msg.content)}</tool_result>`,
        );
        break;
    }
  }

  return {
    prompt: conversationParts.join("\n\n"),
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

export function extractText(content: OAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return String(content ?? "");
}

export function toolsFromRequest(
  oai: OAIChatRequest,
): Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> {
  if (!oai.tools?.length) return [];
  return oai.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: (t.function.parameters as Record<string, unknown>) ?? {
      type: "object",
      properties: {},
    },
  }));
}

// ─── Path D extraction ──────────────────────────────────────────────────────

export interface PathDExtracted {
  systemPrompt: string | undefined;
  /** Last user message content as Anthropic content blocks. Empty array if
   *  the request is a pure tool_result continuation. */
  lastUserContent: ContentBlock[];
  /** When the caller delivers a tool_result, this is the payload + the
   *  tool_use id it resolves. Content is content-blocks (not flattened). */
  pendingToolResult:
    | { toolUseId: string; content: ContentBlock[] }
    | null;
  /** When set, the persistent session is being acquired against a request
   *  whose history has more than one user/tool turn. If the session is
   *  fresh, send this XML-encoded blob as the first user message instead
   *  of `lastUserContent`. The model's response IS the response to the
   *  user's latest question (the blob includes the latest user message
   *  inline via buildPrompt). On the next turn, history is in the
   *  persistent session's internal state and we go incremental. */
  primingPrompt: string | undefined;
}

/**
 * Extract just the information Path D needs from an OpenAI request.
 * Unlike buildPrompt, this is *incremental*: the persistent CLI already
 * holds the prior conversation in memory, so we only care about the last
 * message the caller sent (a fresh user message OR a tool_result).
 *
 * - Last role=tool (OAI-native) → continuation. `tool_call_id` is the id
 *   of the tool_use block this result belongs to.
 * - Last role=user with a tool_result content block (Anthropic-style
 *   adapter) → continuation. Extract `tool_use_id` + `content`.
 * - Last role=user with text content → initial. Pack the text.
 *
 * Returns null if the shape is something we don't handle (e.g. no
 * messages). Caller should fall back to the v3.3 path.
 */
export function extractForPathD(oai: OAIChatRequest): PathDExtracted | null {
  if (!oai.messages?.length) return null;
  const systemParts: string[] = [];
  for (const msg of oai.messages) {
    if (msg.role === "system") systemParts.push(extractText(msg.content));
  }
  const systemPrompt =
    systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  const nonSystemCount = oai.messages.filter((m) => m.role !== "system").length;
  const primingPrompt =
    nonSystemCount > 1 ? buildPrompt(oai).prompt : undefined;

  const last = oai.messages[oai.messages.length - 1];
  if (!last) return null;

  if (last.role === "tool") {
    const toolUseId = last.tool_call_id;
    if (!toolUseId) return null;
    return {
      systemPrompt,
      lastUserContent: [],
      pendingToolResult: {
        toolUseId,
        content: toContentBlocks(last.content),
      },
      primingPrompt,
    };
  }

  if (last.role === "user") {
    // Anthropic-style tool_result inside a user message. First match wins
    // (with --max-turns there's only one anyway).
    if (Array.isArray(last.content)) {
      const parts = last.content as unknown as Array<Record<string, unknown>>;
      for (const part of parts) {
        if (
          part.type === "tool_result" &&
          typeof part.tool_use_id === "string"
        ) {
          const rawContent = part.content;
          let content: ContentBlock[];
          if (typeof rawContent === "string") {
            content = rawContent === "" ? [] : [{ type: "text", text: rawContent }];
          } else if (Array.isArray(rawContent)) {
            content = rawContent as ContentBlock[];
          } else {
            content = [];
          }
          return {
            systemPrompt,
            lastUserContent: [],
            pendingToolResult: { toolUseId: part.tool_use_id, content },
            primingPrompt,
          };
        }
      }
    }
    return {
      systemPrompt,
      lastUserContent: toContentBlocks(last.content),
      pendingToolResult: null,
      primingPrompt,
    };
  }

  // Last message is assistant or system — doesn't match either pattern.
  return null;
}
