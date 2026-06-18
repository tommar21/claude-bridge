export interface BridgeModel {
  id: string;
  cliAlias: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
}

const MODELS: BridgeModel[] = [
  {
    id: "claude-opus-4",
    cliAlias: "opus",
    name: "Claude Opus 4",
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
  },
  {
    id: "claude-sonnet-4",
    cliAlias: "sonnet",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
  },
  {
    id: "claude-haiku-4",
    cliAlias: "haiku",
    name: "Claude Haiku 4",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
];

export function resolveModel(requested: string): BridgeModel {
  const byId = MODELS.find((m) => m.id === requested);
  if (byId) return byId;

  // Common aliases
  const aliasMap: Record<string, string> = {
    opus: "claude-opus-4",
    sonnet: "claude-sonnet-4",
    haiku: "claude-haiku-4",
  };
  const fromAlias = MODELS.find((m) => m.id === aliasMap[requested]);
  if (fromAlias) return fromAlias;

  // Passthrough
  return {
    id: requested,
    cliAlias: requested,
    name: requested,
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
  };
}

export function listModels(): BridgeModel[] {
  return MODELS;
}
