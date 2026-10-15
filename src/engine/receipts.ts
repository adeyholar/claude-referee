// Local receipts: one JSON line per command run in receipts/<project>/<yyyy-mm>.jsonl, chained by `prev` (sha256 of the previous line).
// Counts, tokens, cost and time only; never request text, file paths or user names. `outcome` copies allowlisted numbers and fixed codes,
// never a decide option name or a claim id. Readers group `verify` (the old name) under `claims`; errorReceipt is a failure before any Session.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./cache.ts";
import type { Env } from "./config.ts";
import type { CheckoutClass } from "./datadir.ts";

export interface Receipt {
  readonly id: string;
  readonly ts: string;
  readonly command: string;
  readonly project: string;
  readonly worktree?: CheckoutClass;
  readonly pack?: string;
  readonly model?: string;
  readonly verdict?: string;
  readonly reason?: string;
  readonly outcome?: ReceiptOutcome;
  readonly error?: string;
  readonly requests: number;
  readonly cached: number;
  readonly input_tokens: number;
  readonly cost_usd: number | null;
  readonly request_ids?: readonly string[];
  readonly qhash?: string;
  readonly cache_keys?: readonly string[];
  readonly prev?: string;
  readonly fresh?: boolean;
  readonly stopped?: number;
  readonly replaced?: number;
  readonly chars?: number;
  readonly ms: number;
  readonly run_id?: string;
  readonly session_id?: string;
}

export interface ReceiptOutcome {
  readonly trust?: string;
  readonly p?: number;
  readonly exit_code?: number;
  readonly evidence_lines?: number;
  readonly runners?: readonly string[];
  readonly lean_p?: number;
  readonly margin?: number;
  readonly orders?: number;
  readonly claims?: number;
  readonly supported?: number;
  readonly unsupported?: number;
  readonly contradicted?: number;
  readonly says_nothing?: number;
  readonly unsure?: number;
  readonly unanswered?: number;
  readonly reasons?: Readonly<Record<string, number>>;
  readonly items?: number;
  readonly yes?: number;
  readonly no?: number;
  readonly review?: number;
  readonly run?: boolean;
}

export const REASON_CODE = /^[a-z][a-z0-9_]{0,39}$/;
export const SESSION_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const RUNNER_NAME = /^[A-Za-z0-9][A-Za-z0-9:._ +-]{0,29}$/;
const TRUST = new Set(["parsed", "exit_code", "unparsed"]);
const RUNNERS_MAX = 8;
const REASONS_MAX = 12;
const CLAIM_LISTS = ["unsupported", "contradicted", "says_nothing", "unsure", "unanswered"] as const;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const round = (v: number): number => Number(v.toFixed(4));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function reasonCode(value: unknown): string | undefined {
  return typeof value === "string" && REASON_CODE.test(value) ? value : undefined;
}

export function outcomeOf(result: Readonly<Record<string, unknown>>): ReceiptOutcome | undefined {
  const out: Record<string, unknown> = {};
  const { trust, p, exit_code: exitCode, runners, lean, orders, reasons } = result;
  if (typeof trust === "string" && TRUST.has(trust)) out["trust"] = trust;
  if (isNumber(p)) out["p"] = round(p);
  if (Number.isInteger(exitCode)) out["exit_code"] = exitCode;
  if (isCount(result["evidence_lines"])) out["evidence_lines"] = result["evidence_lines"];
  if (result["run"] === true) out["run"] = true;
  if (Array.isArray(runners)) {
    const names = [...new Set(runners.map((r) => (isRecord(r) ? r["runner"] : undefined)).filter((n): n is string => typeof n === "string" && RUNNER_NAME.test(n)))];
    if (names.length) out["runners"] = names.slice(0, RUNNERS_MAX);
  }
  if (typeof lean === "string" && isRecord(p) && isNumber(p[lean])) {
    const leanP = p[lean] as number;
    const others = Object.entries(p).flatMap(([k, v]) => (k !== lean && isNumber(v) ? [v] : []));
    out["lean_p"] = round(leanP);
    out["margin"] = round(leanP - (others.length ? Math.max(...others) : 0));
    if (isCount(orders)) out["orders"] = orders;
  }
  if (isCount(result["claims"]) && isCount(result["supported"])) {
    out["claims"] = result["claims"];
    out["supported"] = result["supported"];
    for (const key of CLAIM_LISTS) {
      const list = result[key];
      out[key] = Array.isArray(list) ? list.length : 0;
    }
    if (isRecord(reasons)) {
      const histogram = new Map<string, number>();
      for (const code of Object.values(reasons)) if (reasonCode(code)) histogram.set(code as string, (histogram.get(code as string) ?? 0) + 1);
      const top = [...histogram].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, REASONS_MAX);
      if (top.length) out["reasons"] = Object.fromEntries(top.sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    }
  }
  if (isCount(result["items"]) && isCount(result["yes"]) && isCount(result["no"]) && isCount(result["review"])) {
    for (const key of ["items", "yes", "no", "review"]) out[key] = result[key];
  }
  return Object.keys(out).length ? (out as ReceiptOutcome) : undefined;
}

export function envSessionId(env: Env): string | undefined {
  const id = env["CLAUDE_CODE_SESSION_ID"];
  return id !== undefined && SESSION_ID.test(id) ? id : undefined;
}

export function canonicalCommand(command: string): string {
  return command === "verify" ? "claims" : command;
}

export function newReceiptId(now: number, random: () => number = Math.random): string {
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `r${now.toString(36)}${tail}`;
}

export function receiptsDir(dataDir: string): string {
  return join(dataDir, "receipts");
}

function chainLines(dataDir: string, project: string): string[] {
  const dir = join(receiptsDir(dataDir), project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter((l) => l.trim());
}

export function appendReceipt(dataDir: string, receipt: Receipt): boolean {
  try {
    const dir = join(receiptsDir(dataDir), receipt.project);
    mkdirSync(dir, { recursive: true });
    const last = chainLines(dataDir, receipt.project).at(-1);
    const chained: Receipt = last === undefined ? receipt : { ...receipt, prev: sha256(last) };
    appendFileSync(join(dir, `${receipt.ts.slice(0, 7)}.jsonl`), JSON.stringify(chained) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function errorReceipt(fields: { command: string; project: string; worktree?: CheckoutClass; error: string; started: number; now: number; fresh?: boolean; runId?: string | undefined; sessionId?: string | undefined }): Receipt {
  return {
    id: newReceiptId(fields.started),
    ts: new Date(fields.now).toISOString(),
    command: canonicalCommand(fields.command),
    project: fields.project,
    ...(fields.worktree ? { worktree: fields.worktree } : {}),
    error: fields.error,
    requests: 0,
    cached: 0,
    input_tokens: 0,
    cost_usd: 0,
    ...(fields.fresh ? { fresh: true } : {}),
    ms: Math.max(0, fields.now - fields.started),
    ...(fields.runId ? { run_id: fields.runId } : {}),
    ...(fields.sessionId ? { session_id: fields.sessionId } : {}),
  };
}

export function readReceipts(dataDir: string, project?: string): Receipt[] {
  const root = receiptsDir(dataDir);
  if (!existsSync(root)) return [];
  const projects = project ? [project] : readdirSync(root);
  const out: Receipt[] = [];
  for (const p of projects.sort()) {
    const dir = join(root, p);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as Partial<Record<keyof Receipt, unknown>> | null;
          if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.id === "string" && typeof value.ts === "string") out.push(value as Receipt);
        } catch {
          continue;
        }
      }
    }
  }
  return out;
}

export interface ChainBreak {
  readonly project: string;
  readonly id: string;
  readonly kind: "mismatch" | "fork" | "unreadable";
}

export interface ChainReport {
  readonly receipts: number;
  readonly chained: number;
  readonly unchained: number;
  readonly breaks: readonly ChainBreak[];
}

// A `fork` is a prev that matches an earlier line, which two runs appending at once produce; a `mismatch` matches nothing.
export function verifyChain(dataDir: string, project?: string): ChainReport {
  const root = receiptsDir(dataDir);
  const projects = project ? [project] : existsSync(root) ? readdirSync(root).sort() : [];
  let receipts = 0;
  let chained = 0;
  const breaks: ChainBreak[] = [];
  for (const p of projects) {
    const seen: string[] = [];
    for (const line of chainLines(dataDir, p)) {
      receipts += 1;
      let r: Receipt | null = null;
      try {
        r = JSON.parse(line) as Receipt;
      } catch {
        breaks.push({ project: p, id: "?", kind: "unreadable" });
      }
      if (r?.prev !== undefined) {
        chained += 1;
        if (r.prev !== seen.at(-1)) breaks.push({ project: p, id: r.id, kind: seen.includes(r.prev) ? "fork" : "mismatch" });
      }
      seen.push(sha256(line));
    }
  }
  return { receipts, chained, unchained: receipts - chained, breaks };
}

function overrulePath(dataDir: string): string {
  return join(dataDir, "overruled.jsonl");
}

export function readOverruled(dataDir: string): Set<string> {
  const out = new Set<string>();
  let text: string;
  try {
    text = readFileSync(overrulePath(dataDir), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    try {
      const id = (JSON.parse(line) as { id?: unknown } | null)?.id;
      if (typeof id === "string") out.add(id);
    } catch {
      continue;
    }
  }
  return out;
}

// Voids a decision: records it outside the chain (receipts are never rewritten) and drops the cache entries it used.
export function overruleReceipt(dataDir: string, id: string, ts: string): { dropped: number } | null {
  const receipt = readReceipts(dataDir).find((r) => r.id === id);
  if (!receipt) return null;
  mkdirSync(dataDir, { recursive: true });
  if (!readOverruled(dataDir).has(id)) appendFileSync(overrulePath(dataDir), JSON.stringify({ id, ts }) + "\n");
  let dropped = 0;
  for (const key of receipt.cache_keys ?? []) {
    const file = join(dataDir, "cache", `${key}.json`);
    if (existsSync(file)) {
      rmSync(file, { force: true });
      dropped += 1;
    }
  }
  return { dropped };
}
