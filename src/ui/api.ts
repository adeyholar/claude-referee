// Data side of the local dashboard: reads the JSON lines in the data directory and shapes them for the page.
// Labels go through labelStop (labels.jsonl); nothing here touches the network or rewrites a store. Stored fields are untrusted: flow turns a malformed one into a placeholder.
// Flow reads at most FLOW_KEYS cache entries per call and FLOW_READS per response; the project id and the transcript dirs (each a git spawn) are computed once per context, the transcript locator once per queue call.
// verify receipts (the old name) are shown and counted as claims; a receipt's outcome is shown as text built only from numbers and fixed codes.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readCache } from "../engine/cache.ts";
import type { Answer } from "../engine/client.ts";
import { CACHE_TTL_MS, type Env } from "../engine/config.ts";
import { dirSize, projectId, tildify } from "../engine/datadir.ts";
import { REASON_CODE, RUNNER_NAME, canonicalCommand, readOverruled, readReceipts, reasonCode, type Receipt } from "../engine/receipts.ts";
import { loadPack, packDirs, threshold } from "../engine/pack.ts";
import { loadProject } from "../engine/project.ts";
import { clopperPearson, suggestThreshold } from "../engine/stopgate/interval.ts";
import { labelStop, readStops, stopStats } from "../engine/stopgate/stops.ts";
import type { StopRecord } from "../engine/stopgate/types.ts";
import { suggestForStops, transcriptLocator } from "../engine/stopgate/weak.ts";
import { claudeProjectsDir, projectTranscriptDirs } from "../engine/usage.ts";

export interface UiContext {
  readonly dataDir: string;
  readonly cwd: string;
  readonly home: string;
  readonly env: Env;
  readonly now: () => number;
}

export const EXPORT_KINDS = ["receipts", "stops", "labels"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const QUEUE_LIMIT = 50;
const EXCERPT_CHARS = 2000;
const STOP_ID = /^[A-Za-z0-9_-]{1,40}$/;
const BIDI_CONTROL = /[؜‎‏‪-‮⁦-⁩]/g;

function visible(text: string): string {
  return text.replace(BIDI_CONTROL, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);
}

const projects = new WeakMap<UiContext, string>();
const transcriptDirs = new WeakMap<UiContext, string[]>();

function once<T>(map: WeakMap<UiContext, T>, ctx: UiContext, make: () => T): T {
  let value = map.get(ctx);
  if (value === undefined) map.set(ctx, (value = make()));
  return value;
}

function project(ctx: UiContext): string {
  return once(projects, ctx, () => projectId(ctx.cwd));
}

function projectStops(ctx: UiContext): StopRecord[] {
  const id = project(ctx);
  return readStops(ctx.dataDir).filter((r) => r.project === id);
}

function interval(x: number, n: number): [number, number] | null {
  if (n < 1) return null;
  const ci = clopperPearson(x, n);
  return [ci.lower, ci.upper];
}

export function queue(ctx: UiContext) {
  const unlabelled = projectStops(ctx)
    .filter((r) => r.decision?.would_block === true && r.label === undefined)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const picked = unlabelled.slice(0, QUEUE_LIMIT);
  const dirs = once(transcriptDirs, ctx, () => projectTranscriptDirs(ctx.env, ctx.home, ctx.cwd));
  const hints = suggestForStops(transcriptLocator(dirs, claudeProjectsDir(ctx.env, ctx.home)), picked);
  return {
    total: unlabelled.length,
    stops: picked.map((r) => ({
      id: r.id,
      ts: r.ts,
      edits: r.edits,
      checks: r.checks,
      claims_done: r.decision?.claims_done ?? null,
      claims_verified: r.decision?.claims_verified ?? null,
      configured: text(r.configured),
      task_excerpt: visible(r.task_excerpt?.slice(0, EXCERPT_CHARS) ?? ""),
      final_excerpt: visible(r.final_excerpt?.slice(0, EXCERPT_CHARS) ?? ""),
      suggestion: hints.get(r.id) ?? null,
      marks: { truncated_checks: r.truncated_checks ?? 0, subagent_calls: r.subagent_calls ?? 0, subagent_reports: r.subagent_reports ?? 0, stale_pass: r.stale_pass === true },
    })),
  };
}

export function label(ctx: UiContext, id: unknown, value: unknown): "ok" | "bad_input" | "not_found" {
  if (typeof id !== "string" || !STOP_ID.test(id) || (value !== "right" && value !== "wrong")) return "bad_input";
  const stop = projectStops(ctx).find((r) => r.id === id);
  if (!stop || stop.decision?.would_block !== true) return "not_found";
  return labelStop(ctx.dataDir, id, value, new Date(ctx.now()).toISOString()) ? "ok" : "not_found";
}

function sum(receipts: readonly Receipt[], key: "requests" | "cached" | "input_tokens" | "cost_usd"): number {
  return receipts.reduce((total, r) => total + (r[key] ?? 0), 0);
}

export function overview(ctx: UiContext) {
  const since = new Date(ctx.now() - WINDOW_DAYS * DAY_MS).toISOString();
  const receipts = readReceipts(ctx.dataDir, project(ctx)).filter((r) => r.ts >= since);
  const byCommand: Record<string, number> = {};
  for (const r of receipts) {
    const command = canonicalCommand(r.command);
    byCommand[command] = (byCommand[command] ?? 0) + 1;
  }
  const stops = projectStops(ctx).filter((r) => r.ts >= since);
  const stats = stopStats(stops);
  let current = 0.7;
  try {
    const config = loadProject(ctx.cwd);
    if (config) current = threshold(loadPack(config.pack, packDirs(ctx.env)), config.thresholds, "stop.gate", "claims_done", 0.7);
  } catch {
    void 0;
  }
  return {
    days: WINDOW_DAYS,
    receipts: {
      runs: receipts.length,
      requests: sum(receipts, "requests"),
      cached: sum(receipts, "cached"),
      input_tokens: sum(receipts, "input_tokens"),
      cost_usd: sum(receipts, "cost_usd"),
      by_command: byCommand,
    },
    stops: { ...stats, precision_ci95: interval(stats.right, stats.labelled), false_block_rate_ci95: interval(stats.wrong, stats.labelled) },
    threshold_suggestion: suggestThreshold(stops, current),
  };
}

export const FLOW_DAYS = [1, 7, 30] as const;
const FLOW_LIMIT = 200;
const FLOW_ANSWERS = 40;
const FLOW_KEYS = 12;
const FLOW_READS = 600;
const FLOW_OPTIONS = 6;
const CACHE_KEY = /^[0-9a-f]{64}$/;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" ? visible(v) : null;
}

function answerView(id: string, a: Answer) {
  const base = { id: visible(id), type: a.type };
  if (a.type === "noul") {
    const yes = num(a.noul);
    if (yes === null) return { ...base, value: "?", p: null, options: [] };
    return { ...base, value: yes >= 0.5 ? "yes" : "no", p: yes >= 0.5 ? yes : Math.round((1 - yes) * 10_000) / 10_000, options: [] };
  }
  if (a.type === "score") return { ...base, value: num(a.score)?.toFixed(2) ?? "?", p: num(a.confidence), options: [] };
  if (a.type === "choice") {
    const options = Object.entries(a.probabilities ?? {})
      .flatMap(([label, p]) => (num(p) === null ? [] : [{ label: visible(label), p: p as number }]))
      .sort((x, y) => y.p - x.p)
      .slice(0, FLOW_OPTIONS);
    return { ...base, value: text(a.choice) ?? "?", p: num(a.confidence), options };
  }
  return null;
}

function jevAnswers(ctx: UiContext, keys: unknown, budget: { reads: number }) {
  const found: { model: string; answered_at: string; questions: NonNullable<ReturnType<typeof answerView>>[] }[] = [];
  const list: unknown[] = Array.isArray(keys) ? keys : [];
  const read = list.slice(0, Math.min(FLOW_KEYS, budget.reads));
  budget.reads -= read.length;
  let missing = 0;
  for (const key of read) {
    const entry = typeof key === "string" && CACHE_KEY.test(key) ? readCache(ctx.dataDir, key, ctx.now(), CACHE_TTL_MS) : null;
    const at = entry && num(entry.ts) !== null ? new Date(entry.ts) : null;
    if (!entry || !at || Number.isNaN(at.getTime()) || typeof entry.answers !== "object" || entry.answers === null) {
      missing++;
      continue;
    }
    const questions = Object.entries(entry.answers)
      .slice(0, FLOW_ANSWERS)
      .flatMap(([id, a]) => (a && typeof a === "object" ? (answerView(id, a) ?? []) : []));
    found.push({ model: text(entry.model) ?? "?", answered_at: at.toISOString(), questions });
  }
  return { answers: found, answers_missing: missing, answers_more: list.length - read.length };
}

const OUTCOME_NUMBERS = ["p", "exit_code", "lean_p", "margin", "orders", "claims", "supported", "unsupported", "contradicted", "says_nothing", "unsure", "unanswered", "items", "yes", "no", "review"] as const;

function outcomeText(r: Receipt): string | null {
  const raw: unknown = r.outcome;
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const parts: string[] = [];
  const reason = reasonCode(r.reason);
  if (reason) parts.push(`reason ${reason}`);
  if (typeof o["trust"] === "string" && REASON_CODE.test(o["trust"])) parts.push(`trust ${o["trust"]}`);
  for (const key of OUTCOME_NUMBERS) {
    const value = num(o[key]);
    if (value !== null) parts.push(`${key} ${Math.round(value * 10_000) / 10_000}`);
  }
  const runners = Array.isArray(o["runners"]) ? o["runners"].filter((n): n is string => typeof n === "string" && RUNNER_NAME.test(n)).slice(0, 8) : [];
  if (runners.length) parts.push(`runners ${runners.join(", ")}`);
  const reasons = typeof o["reasons"] === "object" && o["reasons"] !== null && !Array.isArray(o["reasons"]) ? Object.entries(o["reasons"] as Record<string, unknown>) : [];
  const counted = reasons.flatMap(([code, n]) => (REASON_CODE.test(code) && num(n) !== null ? [`${code} ${n as number}`] : [])).slice(0, 12);
  if (counted.length) parts.push(`reasons ${counted.join(", ")}`);
  return parts.length ? parts.join("; ") : null;
}

function shortSession(id: unknown): string | null {
  return typeof id === "string" && id !== "unknown" && id !== "" ? visible(id.slice(0, 8)) : null;
}

export function flow(ctx: UiContext, query: { days?: unknown; command?: unknown } = {}) {
  const days = (FLOW_DAYS as readonly number[]).includes(Number(query.days)) ? Number(query.days) : 7;
  const since = new Date(ctx.now() - days * DAY_MS).toISOString();
  const receipts = readReceipts(ctx.dataDir, project(ctx)).filter((r) => r.ts >= since);
  const stops = projectStops(ctx).filter((r) => r.ts >= since);
  const commands = [...new Set(receipts.flatMap((r) => (typeof r.command === "string" ? [canonicalCommand(r.command)] : [])))].sort();
  if (stops.length) commands.push("stop");
  const command = typeof query.command === "string" && commands.includes(query.command) ? query.command : "all";
  const voided = readOverruled(ctx.dataDir);
  const calls = command === "stop" ? [] : receipts.filter((r) => command === "all" || (typeof r.command === "string" && canonicalCommand(r.command) === command));
  const stopRows = command === "all" || command === "stop" ? stops : [];
  const budget = { reads: FLOW_READS };
  const rows = [...calls.map((r) => ({ ts: r.ts, r })), ...stopRows.map((s) => ({ ts: s.ts, s }))].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const events = rows.slice(0, FLOW_LIMIT).map((row) => {
    if ("r" in row) {
      const r = row.r;
      return {
        kind: "call" as const,
        id: r.id,
        ts: r.ts,
        command: typeof r.command === "string" ? visible(canonicalCommand(r.command)) : "unknown",
        pack: text(r.pack),
        model: text(r.model),
        verdict: text(r.verdict),
        error: text(r.error),
        outcome: outcomeText(r),
        requests: num(r.requests) ?? 0,
        cached: num(r.cached) ?? 0,
        input_tokens: num(r.input_tokens) ?? 0,
        cost_usd: num(r.cost_usd) ?? 0,
        ms: num(r.ms),
        session: shortSession(r.session_id),
        overruled: voided.has(r.id),
        ...jevAnswers(ctx, r.cache_keys, budget),
      };
    }
    const s = row.s;
    return {
      kind: "stop" as const,
      id: s.id,
      ts: s.ts,
      mode: text(s.mode) ?? "unknown",
      session: shortSession(s.session_id),
      skipped: text(s.skipped),
      error: text(s.error),
      configured: text(s.configured),
      edits: num(s.edits) ?? 0,
      checks: num(s.checks) ?? 0,
      ms: num(s.ms),
      claims_done: num(s.decision?.claims_done),
      claims_verified: num(s.decision?.claims_verified),
      would_block: typeof s.decision?.would_block === "boolean" ? s.decision.would_block : null,
      label: s.label === "right" || s.label === "wrong" ? s.label : null,
    };
  });
  return { days, command, commands, total: rows.length, shown: events.length, events };
}

const SENT = [
  { when: "Every call that asks Jev", what: "The pack's question text and the input it asks about, redacted first" },
  { when: "done", what: "Your criterion and the output you pipe in; recognised runner output is parsed in code and only counts, exit code, failing test names and the matched summary and exit-code lines go out" },
  { when: "decide", what: "The decision, inline context, option texts and context_files contents, asked in two option orders" },
  { when: "judge, claims and verify", what: "The items, claims and source text you pass in" },
  { when: "look (experimental)", what: "Your criteria and the image files you name with --image, unredacted: pixels cannot be redacted, so a screenshot can show secrets" },
  { when: "Done-gate in shadow or soft mode", what: "Prompt start (1,500 chars), final message end (2,000 chars), check commands with pass/fail and edited file paths" },
  { when: "This dashboard", what: "Nothing: no network call leaves this process, no telemetry, no external fonts or scripts" },
] as const;

function fileInfo(dataDir: string, name: string): { name: string; bytes: number } | null {
  const path = join(dataDir, name);
  if (!existsSync(path)) return null;
  try {
    const st = statSync(path);
    return { name, bytes: st.isDirectory() ? dirSize(path) : st.size };
  } catch {
    return null;
  }
}

export function privacy(ctx: UiContext) {
  const id = project(ctx);
  const stops = readStops(ctx.dataDir);
  const stored = ["receipts", "cache", "results", "stops.jsonl", "labels.jsonl", "overruled.jsonl"].flatMap((n) => fileInfo(ctx.dataDir, n) ?? []);
  return {
    data_dir: tildify(ctx.dataDir, ctx.home),
    total_bytes: dirSize(ctx.dataDir),
    stored,
    counts: {
      receipts_this_project: readReceipts(ctx.dataDir, id).length,
      receipts_all_projects: readReceipts(ctx.dataDir).length,
      stops_this_project: stops.filter((r) => r.project === id).length,
      stops_all_projects: stops.length,
      labelled_this_project: stops.filter((r) => r.project === id && r.label !== undefined).length,
    },
    stores_text: [
      { name: "stops.jsonl", holds: "Prompt and final-message excerpts of done-gate stops, scores, your labels" },
      { name: "receipts", holds: "Counts, tokens, cost, latency and hashes per run, plus outcome numbers and fixed codes (trust, p, runner names, claim and item counts); no request text, criteria, claim text, option names, items or paths" },
      { name: "cache", holds: "Jev's answers keyed by hashes; not reused after 30 days, kept on disk until an overrule or uninstall" },
    ],
    would_be_sent: SENT,
  };
}

export function exportKind(ctx: UiContext, kind: unknown): { filename: string; body: string } | null {
  if (typeof kind !== "string" || !(EXPORT_KINDS as readonly string[]).includes(kind)) return null;
  const rows: unknown[] =
    kind === "receipts"
      ? readReceipts(ctx.dataDir, project(ctx))
      : kind === "stops"
        ? projectStops(ctx)
        : projectStops(ctx).flatMap((r) => (r.label !== undefined ? [{ id: r.id, label: r.label, labelled_at: r.labelled_at }] : []));
  return { filename: `claude-referee-${kind}.jsonl`, body: rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "") };
}
