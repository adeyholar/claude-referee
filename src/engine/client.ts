// The only module that talks to TypeSafe. The SDK is imported lazily, so commands that never ask Jev never load it.
// Each call gets a total budget on top of the SDK's per-attempt timeout, because the SDK has no retry budget.
// 429s are retried here, not by the SDK: a Retry-After longer than the budget ends the call as rate_limited.
// Request bodies go uncompressed: SDK 0.7 compresses with zstd by default, and a gateway behind TYPESAFE_BASE_URL may not accept it.

import { setTimeout as sleep } from "node:timers/promises";
import type { ChoiceResponse, EntryType, NoulResponse, Questions, ScoreResponse, TypeSafeClient } from "@typesafe-ai/sdk";
import { classify } from "./classify.ts";
import type { Budget } from "./config.ts";
import { RefereeError } from "./errors.ts";

export type Answer = NoulResponse | ChoiceResponse | ScoreResponse;

export interface JevCall {
  readonly state: EntryType;
  readonly questions: Questions;
  readonly model: string;
  readonly assets?: Readonly<Record<string, Uint8Array>> | undefined;
}

export interface JevReply {
  readonly answers: Readonly<Record<string, Answer>>;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly requestId: string | undefined;
}

export interface CallOptions {
  readonly key: string;
  readonly budget: Budget;
  readonly baseURL?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

const SDK_RETRY_STATUSES: ReadonlySet<number> = new Set([408, ...Array.from({ length: 100 }, (_, i) => 500 + i)]);

function rateLimitWait(error: unknown, attempt: number): number | undefined {
  const e = (typeof error === "object" && error !== null ? error : {}) as { name?: unknown; retryAfterMs?: unknown };
  if (e.name !== "RateLimitError") return undefined;
  return typeof e.retryAfterMs === "number" ? e.retryAfterMs : Math.min(500 * 2 ** attempt, 5000);
}

const stderrLogger = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => void process.stderr.write(`[claude-referee] ${message}\n`),
  error: (message: string) => void process.stderr.write(`[claude-referee] ${message}\n`),
};

async function guarded<T>(options: CallOptions, fn: (client: TypeSafeClient, signal: AbortSignal, sdk: typeof import("@typesafe-ai/sdk")) => Promise<T>, model?: string): Promise<T> {
  const sdk = await import("@typesafe-ai/sdk");
  const endsAt = Date.now() + options.budget.budgetMs;
  const budgetSignal = AbortSignal.timeout(options.budget.budgetMs);
  const signal = options.signal ? AbortSignal.any([options.signal, budgetSignal]) : budgetSignal;
  try {
    const client = new sdk.TypeSafeClient({
      apiKey: options.key,
      logLevel: "warn",
      logger: stderrLogger,
      timeout: options.budget.perAttemptMs,
      compression: false,
      retry: { maxRetries: options.budget.maxRetries, httpStatuses: SDK_RETRY_STATUSES },
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(client, signal, sdk);
      } catch (error) {
        const wait = rateLimitWait(error, attempt);
        if (wait === undefined || attempt >= options.budget.maxRetries || wait >= endsAt - Date.now()) throw error;
        await sleep(wait, undefined, { signal });
      }
    }
  } catch (error) {
    if (budgetSignal.aborted) {
      throw new RefereeError("timeout", `Jev did not answer within ${options.budget.budgetMs} ms.`, {
        next_step: "Try again later; the verdict is unknown, not negative.",
      });
    }
    throw classify(error, model ? { model } : {});
  }
}

// Images are uploaded with the request, so a call that carries them gets a longer per-attempt timeout and total budget than a text-only one.
const IMAGE_BUDGET = { budgetMs: 60_000, perAttemptMs: 30_000 };

export function callJev(call: JevCall, options: CallOptions): Promise<JevReply> {
  const budget = call.assets ? { ...options.budget, budgetMs: Math.max(options.budget.budgetMs, IMAGE_BUDGET.budgetMs), perAttemptMs: Math.max(options.budget.perAttemptMs, IMAGE_BUDGET.perAttemptMs) } : options.budget;
  return guarded({ ...options, budget }, async (client, signal, sdk) => {
    const assets = call.assets ? Object.fromEntries(Object.entries(call.assets).map(([ref, bytes]) => [ref, sdk.image(bytes)])) : undefined;
    const request = { state: call.state as NonNullable<EntryType>, questions: call.questions, model: call.model, ...(assets ? { assets } : {}) };
    const { data, requestId } = await client.systemOne(request, { signal, ...(assets ? { headers: { "TypeSafe-Danger-Zone-Images": "true" } } : {}) }).withResponse();
    return {
      answers: data.answers as Readonly<Record<string, Answer>>,
      model: data.model,
      inputTokens: data.usage.input_tokens,
      requestId,
    };
  }, call.model);
}

export function listModels(options: CallOptions): Promise<string[]> {
  return guarded(options, async (client, signal) => (await client.models.list({ signal })).map((m) => m.name));
}
