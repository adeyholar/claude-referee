// Helpers shared by the commands: input reading, pack selection and the Jev command lifecycle.
// A Jev command plans its requests first, so --dry-run can show them without touching the network or disk.
// Its receipt takes the verdict, the reason code and outcomeOf(result); any failure once the Session exists is receipted there.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DETAIL_LIMIT } from "../engine/config.ts";
import { RefereeError, isRefereeError } from "../engine/errors.ts";
import { roundDeep, type Result } from "../engine/output.ts";
import { loadPack, packDirs, type Pack } from "../engine/pack.ts";
import { loadProject, type ProjectConfig } from "../engine/project.ts";
import { outcomeOf, reasonCode, type Receipt } from "../engine/receipts.ts";
import { Session, markReceipted, type Outcome, type Planned } from "../engine/session.ts";
import type { Context } from "./types.ts";

export const JEV_COST = "One Jev request per input at $0.042 per million input tokens; output tokens are free. Repeats come from the local cache.";

export const JEV_ERRORS = [
  "bad_input",
  "no_api_key",
  "invalid_api_key",
  "auth_failed",
  "rate_limited",
  "timeout",
  "service_unavailable",
  "bad_request",
  "credential_in_state",
  "pack_not_found",
  "bad_pack",
  "bad_project",
  "too_large",
] as const;

export const JEV_EFFECTS =
  "Sends the redacted input to the TypeSafe API unless --dry-run; writes a receipt and cache entries to the data directory. Without --dry-run, an error once the input is read also writes a receipt with its error code.";

export function str(context: Context, key: string): string | undefined {
  const value = context.values[key];
  return typeof value === "string" ? value : undefined;
}

export function list(context: Context, key: string): string[] {
  const value = context.values[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}

export async function readSource(context: Context, source: string | undefined, what: string): Promise<string> {
  if (source === undefined || source === "-") {
    const text = await context.io.readStdin();
    if (!text.trim()) throw new RefereeError("bad_input", `No ${what} on stdin.`, { next_step: `Pipe the ${what} in, or pass a file path.` });
    return text;
  }
  const path = resolve(context.io.cwd, source);
  try {
    if (statSync(path).size > 5_000_000) throw new RefereeError("too_large", `The ${what} file is larger than 5 MB.`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isRefereeError(error)) throw error;
    throw new RefereeError("bad_input", `Cannot read the ${what} file: ${source}`);
  }
}

export { stripAnsi } from "../engine/runners/util.ts";

export function clip(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters omitted …]\n${text.slice(-tail)}`;
}

export function openPack(context: Context): { pack: Pack; project: ProjectConfig | null } {
  const project = loadProject(context.io.cwd, context.io.env);
  const name = context.flags.pack?.trim() || context.io.env["REFEREE_PACK"]?.trim() || project?.pack || "generic";
  return { pack: loadPack(name, packDirs(context.io.env)), project };
}

export function question(pack: Pack, id: string): Pack["questions"][string] {
  const q = pack.questions[id];
  if (!q) throw new RefereeError("bad_pack", `Pack ${pack.name} has no question ${id}.`);
  return q;
}

export function withData<T extends object>(instructions: unknown, data: Record<string, unknown>): T {
  const base = typeof instructions === "object" && instructions !== null && !Array.isArray(instructions) ? instructions : { question: instructions };
  return { ...base, ...data } as T;
}

export function printVerbose(context: Context, receipt: Receipt): void {
  if (context.flags.verbose) context.io.warn(JSON.stringify({ requests: receipt.requests, cached: receipt.cached, input_tokens: receipt.input_tokens, cost_usd: receipt.cost_usd, model: receipt.model, ms: receipt.ms }) + "\n");
}

export async function jevCommand(
  context: Context,
  command: string,
  pack: Pack,
  planned: readonly Planned[],
  finish: (outcomes: Outcome[], session: Session) => Result,
  options: { batch?: boolean; partial?: boolean; followUp?: (outcomes: Outcome[]) => readonly Planned[] } = {},
): Promise<Result> {
  const { io, flags } = context;
  const session = new Session({
    command,
    env: io.env,
    cwd: io.cwd,
    home: io.home,
    platform: io.platform,
    now: io.now,
    pack: { name: pack.name, version: `${pack.version}+${pack.hash}`, redact: pack.redact },
    dataDir: flags.dataDir,
    fresh: flags.fresh,
  });
  if (flags.dryRun) {
    const result = session.dryRun(planned);
    return flags.pretty ? result : fitLine(result);
  }
  try {
    const first = await session.run(planned, options);
    const more = options.followUp?.(first) ?? [];
    const outcomes = more.length > 0 ? [...first, ...(await session.run(more, options))] : first;
    const result = finish(outcomes, session);
    const reason = reasonCode(result["reason"]);
    const receipt = session.record({
      ...(typeof result["verdict"] === "string" ? { verdict: result["verdict"] } : {}),
      ...(reason !== undefined ? { reason } : {}),
      outcome: outcomeOf(result),
    });
    if (!session.saved()) io.warn("[claude-referee] Could not write to the data directory; this run was not cached or logged.\n");
    printVerbose(context, receipt);
    return reorder({ ...result, ...session.stats(), receipt: receipt.id });
  } catch (error) {
    session.record({ error: isRefereeError(error) ? error : new RefereeError("internal", "Unexpected error.") });
    markReceipted(error);
    throw error;
  }
}

function shorten(value: unknown, max: number): unknown {
  if (typeof value === "string") return value.length > max ? clip(value, Math.floor(max / 2), Math.floor(max / 2)) : value;
  if (Array.isArray(value)) return value.map((item) => shorten(item, max));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, max)]));
  return value;
}

export function fitLine(result: Result): Result {
  const fits = (candidate: Result) => JSON.stringify(roundDeep(candidate)).length <= DETAIL_LIMIT;
  if (fits(result)) return result;
  const sent = Array.isArray(result["sent"]) ? (result["sent"] as unknown[]) : [];
  for (const max of [1000, 400, 160, 60]) {
    const candidate = { ...result, sent: shorten(sent, max) };
    if (fits(candidate)) return candidate;
  }
  const short = shorten(sent, 60) as unknown[];
  let low = 0;
  let high = short.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits({ ...result, sent: short.slice(0, mid), sent_shown: mid })) low = mid;
    else high = mid - 1;
  }
  return { ...result, sent: short.slice(0, low), sent_shown: low };
}

export function reorder(result: Result): Result {
  const { ok, verdict, next_step, receipt, ...rest } = result;
  return { ok, verdict, ...rest, next_step, receipt };
}
