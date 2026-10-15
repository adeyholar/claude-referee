// One Session per command run: redacts every request, serves the cache, merges identical in-flight requests,
// calls Jev within the profile budget and totals the run into a single local receipt. An error it records is remembered
// (receipted), so the CLI does not write a second receipt for the same failure.

import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { BREAKER_CODES, breakerOpen, recordBreaker } from "./breaker.ts";
import { cacheKey, readCache, sha256, writeCache } from "./cache.ts";
import { classify } from "./classify.ts";
import { callJev, type Answer, type JevReply } from "./client.ts";
import { BATCH_DEADLINE_MS, CACHE_TTL_MS, PROFILES, costUsd, estimateTokens, resolveModel, type Env } from "./config.ts";
import { checkoutClass, resolveDataDir, projectId } from "./datadir.ts";
import { RefereeError, isRefereeError, type ErrorCode } from "./errors.ts";
import { endpointOf, resolveEndpointKey, type ResolvedKey } from "./key.ts";
import { appendReceipt, envSessionId, newReceiptId, type Receipt, type ReceiptOutcome } from "./receipts.ts";
import { redact, stopError, type PackPatterns, type Stop } from "./redact.ts";

export interface Planned {
  readonly id: string;
  readonly state: EntryType;
  readonly questions: Questions;
  readonly assets?: Readonly<Record<string, Uint8Array>> | undefined;
}

export interface Outcome {
  readonly id: string;
  readonly answers: Readonly<Record<string, Answer>> | null;
  readonly stopped: readonly Stop[];
  readonly cached: boolean;
  readonly error?: ErrorCode;
}

export interface PackRef {
  readonly name: string;
  readonly version: string;
  readonly redact?: PackPatterns | undefined;
}

export interface SessionOptions {
  readonly command: string;
  readonly env: Env;
  readonly cwd: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly pack: PackRef;
  readonly dataDir?: string | undefined;
  readonly fresh?: boolean;
  readonly profile?: keyof typeof PROFILES;
  readonly sessionId?: string | undefined;
  readonly deadlineMs?: number;
}

interface Prepared {
  readonly planned: Planned;
  readonly body: { state: EntryType; questions: Questions; assets?: Readonly<Record<string, Uint8Array>> | undefined };
  readonly stops: readonly Stop[];
}

const receipted = new WeakSet<object>();

export function markReceipted(error: unknown): void {
  if (typeof error === "object" && error !== null) receipted.add(error);
}

export function isReceipted(error: unknown): boolean {
  return typeof error === "object" && error !== null && receipted.has(error);
}

export function questionHash(questions: Questions): string {
  return sha256(JSON.stringify(questions)).slice(0, 12);
}

export function stateHash(state: EntryType): string {
  return sha256(JSON.stringify(state)).slice(0, 12);
}

export function redactRequest(p: Planned, home: string, extra: PackPatterns | undefined): { body: Prepared["body"]; stops: Stop[]; replaced: number } {
  const options = { home, extra };
  const count = (replaced: Readonly<Record<string, number>>) => Object.values(replaced).reduce((a, b) => a + b, 0);
  const state = redact({ state: p.state }, options);
  const questions = redact({ questions: p.questions }, { ...options, keepKeys: true });
  return {
    body: { state: state.value.state, questions: questions.value.questions, ...(p.assets ? { assets: p.assets } : {}) },
    stops: [...state.stopped, ...questions.stopped],
    replaced: count(state.replaced) + count(questions.replaced),
  };
}

export class Session {
  readonly model: string;
  readonly dataDir: string;
  readonly receiptId: string;
  private readonly options: SessionOptions;
  private readonly started: number;
  private readonly endpoint: string | undefined;
  private readonly inflight = new Map<string, Promise<JevReply>>();
  private keyPromise: Promise<ResolvedKey> | undefined;
  private requests = 0;
  private cachedCount = 0;
  private inputTokens = 0;
  private cost = 0;
  private unpriced = false;
  private replacedCount = 0;
  private stoppedCount = 0;
  private answeredModel: string | undefined;
  private unsaved = false;
  private readonly requestIds: string[] = [];
  private readonly questionHashes = new Set<string>();
  private readonly cacheKeys = new Set<string>();

  constructor(options: SessionOptions) {
    this.options = options;
    this.started = options.now();
    this.model = resolveModel(options.env);
    this.dataDir = resolveDataDir(options.env, options.home, options.cwd, options.dataDir);
    this.endpoint = endpointOf(options.env["TYPESAFE_BASE_URL"]);
    this.receiptId = newReceiptId(this.started);
  }

  prepare(planned: readonly Planned[]): Prepared[] {
    return planned.map((p) => {
      const { body, stops, replaced } = redactRequest(p, this.options.home, this.options.pack.redact);
      this.replacedCount += replaced;
      this.questionHashes.add(questionHash(p.questions));
      return { planned: p, body, stops };
    });
  }

  dryRun(planned: readonly Planned[]): Record<string, unknown> {
    const prepared = this.prepare(planned);
    const stops = prepared.flatMap((p) => p.stops);
    if (stops.length > 0) throw stopError(stops);
    const bodies = prepared.map((p) => ({ id: p.planned.id, model: this.model, state: p.body.state, questions: p.body.questions, ...(p.body.assets ? { images: Object.entries(p.body.assets).map(([ref, bytes]) => ({ ref, bytes: bytes.length, sha256: sha256(bytes).slice(0, 12) })) } : {}) }));
    const estTokens = bodies.reduce((sum, b) => sum + estimateTokens(JSON.stringify(b)), 0);
    return { ok: true, verdict: "would_send", dry_run: true, requests: bodies.length, est_tokens: estTokens, replaced: this.replacedCount, sent: bodies };
  }

  async run(planned: readonly Planned[], options: { batch?: boolean; partial?: boolean; concurrency?: number } = {}): Promise<Outcome[]> {
    const prepared = this.prepare(planned);
    const stops = prepared.flatMap((p) => p.stops);
    if (stops.length > 0 && !options.batch) throw stopError(stops);
    const partial = options.batch === true || options.partial === true;
    const deadline = partial ? AbortSignal.timeout(this.options.deadlineMs ?? BATCH_DEADLINE_MS) : undefined;
    const outcomes: Outcome[] = new Array(prepared.length);
    const failures: RefereeError[] = [];
    let fatal: { error: unknown } | undefined;
    let next = 0;
    const worker = async () => {
      while (next < prepared.length) {
        const index = next++;
        const item = prepared[index];
        if (!item) continue;
        if (!partial) {
          try {
            outcomes[index] = await this.one(item);
          } catch (error) {
            fatal ??= { error };
            next = prepared.length;
          }
          continue;
        }
        try {
          if (deadline?.aborted) throw new RefereeError("timeout", "The batch deadline passed.");
          outcomes[index] = await this.one(item, deadline);
        } catch (error) {
          const known = classify(error);
          failures.push(known);
          outcomes[index] = { id: item.planned.id, answers: null, stopped: [], cached: false, error: known.code };
        }
      }
    };
    const width = Math.max(1, Math.min(options.concurrency ?? 6, prepared.length));
    await Promise.all(Array.from({ length: width }, worker));
    if (fatal) throw fatal.error;
    const [firstFailure] = failures;
    if (firstFailure && !outcomes.some((o) => o.answers !== null)) throw firstFailure;
    return outcomes;
  }

  private async one(item: Prepared, signal?: AbortSignal): Promise<Outcome> {
    const id = item.planned.id;
    if (item.stops.length > 0) {
      this.stoppedCount += 1;
      return { id, answers: null, stopped: item.stops, cached: false };
    }
    const pack = this.options.pack;
    const key = cacheKey({ pack: pack.name, packVersion: pack.version, model: this.model, questions: item.body.questions, state: item.body.state, endpoint: this.endpoint });
    this.cacheKeys.add(key);
    if (!this.options.fresh) {
      const hit = readCache(this.dataDir, key, this.options.now(), CACHE_TTL_MS);
      if (hit) {
        this.cachedCount += 1;
        this.answeredModel = hit.model;
        return { id, answers: hit.answers, stopped: [], cached: true };
      }
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.call(item.body, key, signal);
      this.inflight.set(key, pending);
    } else {
      this.cachedCount += 1;
    }
    const reply = await pending;
    return { id, answers: reply.answers, stopped: [], cached: false };
  }

  private async call(body: Prepared["body"], key: string, signal?: AbortSignal): Promise<JevReply> {
    const breakerSession = this.options.profile === "hook" ? this.options.sessionId : undefined;
    if (breakerSession && breakerOpen(this.dataDir, breakerSession)) {
      throw new RefereeError("breaker_open", "Skipped: Jev failed three times in a row in this session.", { next_step: "Hooks skip Jev until the session ends; the CLI still calls it." });
    }
    this.keyPromise ??= resolveEndpointKey(this.options.env, this.options.platform);
    const { key: apiKey } = await this.keyPromise;
    let reply: JevReply;
    try {
      reply = await callJev(
        { state: body.state, questions: body.questions, model: this.model, assets: body.assets },
        { key: apiKey, budget: PROFILES[this.options.profile ?? "cli"], baseURL: this.options.env["TYPESAFE_BASE_URL"], signal },
      );
    } catch (error) {
      if (breakerSession && isRefereeError(error) && BREAKER_CODES.has(error.code)) recordBreaker(this.dataDir, breakerSession, false, this.options.now());
      throw error;
    }
    if (breakerSession) recordBreaker(this.dataDir, breakerSession, true, this.options.now());
    this.requests += 1;
    this.inputTokens += reply.inputTokens ?? 0;
    const usd = reply.inputTokens === null ? null : costUsd(reply.model, reply.inputTokens);
    if (usd === null) this.unpriced = true;
    else this.cost += usd;
    this.answeredModel = reply.model;
    if (reply.requestId) this.requestIds.push(reply.requestId);
    if (!writeCache(this.dataDir, key, { ts: this.options.now(), model: reply.model, answers: reply.answers, inputTokens: reply.inputTokens ?? 0 })) this.unsaved = true;
    return reply;
  }

  stats(): { requests: number; cached: number } {
    return { requests: this.requests, cached: this.cachedCount };
  }

  saved(): boolean {
    return !this.unsaved;
  }

  record(fields: { verdict?: string; reason?: string; outcome?: ReceiptOutcome | undefined; error?: RefereeError; chars?: number } = {}): Receipt {
    const env = this.options.env;
    const sessionId = this.options.sessionId ?? envSessionId(env);
    const receipt: Receipt = {
      id: this.receiptId,
      ts: new Date(this.options.now()).toISOString(),
      command: this.options.command,
      project: projectId(this.options.cwd),
      worktree: checkoutClass(this.options.cwd),
      pack: this.options.pack.name,
      model: this.answeredModel ?? this.model,
      ...(fields.verdict !== undefined ? { verdict: fields.verdict } : {}),
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
      ...(fields.outcome !== undefined ? { outcome: fields.outcome } : {}),
      ...(fields.error !== undefined ? { error: fields.error.code } : {}),
      requests: this.requests,
      cached: this.cachedCount,
      input_tokens: this.inputTokens,
      cost_usd: this.unpriced ? null : Number(this.cost.toFixed(8)),
      ...(this.requestIds.length > 0 ? { request_ids: this.requestIds } : {}),
      ...(this.questionHashes.size > 0 ? { qhash: [...this.questionHashes].sort().join(",") } : {}),
      ...(this.cacheKeys.size > 0 ? { cache_keys: [...this.cacheKeys].sort() } : {}),
      ...(this.options.fresh ? { fresh: true } : {}),
      ...(this.stoppedCount > 0 ? { stopped: this.stoppedCount } : {}),
      ...(this.replacedCount > 0 ? { replaced: this.replacedCount } : {}),
      ...(fields.chars !== undefined ? { chars: fields.chars } : {}),
      ms: Math.max(0, this.options.now() - this.started),
      ...(env["EVAL_RUN_ID"] ? { run_id: env["EVAL_RUN_ID"] } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    };
    if (!appendReceipt(this.dataDir, receipt)) this.unsaved = true;
    if (fields.error !== undefined) markReceipted(fields.error);
    return receipt;
  }
}
