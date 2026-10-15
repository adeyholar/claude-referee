// Constants shared by the CLI and hooks: names, model, prices, output limits and request budgets.
// Prices: https://docs.typesafe.ai/models.md (input tokens only; output tokens are free).

export const KIT = "claude-referee";
export const VERSION = "0.2.8";
export const DEFAULT_MODEL = "jev-1.13.0";
export const MARKETPLACE = "claude-referee";
export const DEFAULT_BASE_URL = "https://api.typesafe.ai";

export const USD_PER_MTOK: Readonly<Record<string, number>> = {
  "jev-1.13.0": 0.042,
  "jev-1.14.0": 0.042,
};

export const DETAIL_LIMIT = 1500;
export const ERROR_LIMIT = 2000;
export const STATE_TOKEN_LIMIT = 32_000;
export const REQUEST_TOKEN_LIMIT = 64_000;
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const BATCH_DEADLINE_MS = 90_000;

export interface Budget {
  readonly budgetMs: number;
  readonly perAttemptMs: number;
  readonly maxRetries: number;
}

export const PROFILES = {
  cli: { budgetMs: 30_000, perAttemptMs: 10_000, maxRetries: 2 },
  hook: { budgetMs: 2_000, perAttemptMs: 1_500, maxRetries: 0 },
} as const satisfies Record<string, Budget>;

export type Env = Readonly<Record<string, string | undefined>>;

export function resolveModel(env: Env): string {
  return env["TYPESAFE_MODEL"]?.trim() || env["CLAUDE_PLUGIN_OPTION_MODEL"]?.trim() || env["REFEREE_MODEL"]?.trim() || DEFAULT_MODEL;
}

export function costUsd(model: string, inputTokens: number): number | null {
  const price = USD_PER_MTOK[model];
  return price === undefined ? null : (inputTokens * price) / 1_000_000;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
