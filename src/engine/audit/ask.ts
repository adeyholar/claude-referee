// The Jev reading of audit turns (docs/decisions/audit-command.md, step 2): the Stop gate's own questions on every unverified edit turn, and a pushback question on the next prompt of every edit turn that has one.
// The study then compares the gate's would_block and the verified/unverified split with the user's pushback. Rows keep no text: folder hash, session id, turn index, scores.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { RefereeError } from "../errors.ts";
import { threshold, type Pack } from "../pack.ts";
import type { Outcome, Planned } from "../session.ts";
import { decideStop, stopQuestions, stopState } from "../stopgate/decide.ts";
import { folderHash, sessionFolders } from "./report.ts";
import { auroc, fisherOneSided, rate } from "./stats.ts";
import { auditTurns, type AuditTurn } from "./turns.ts";

export const MIN_GROUP = 15;
export const MAX_ASK = 300;
const PREVIOUS_MAX = 1000;
const NEXT_MAX = 600;

export interface AskTurn {
  readonly folder: string;
  readonly session: string;
  readonly turn: AuditTurn;
}

type Thresholds = Parameters<typeof threshold>[1];
type Label = "yes" | "no" | "review" | "none";

export interface Row {
  folder: string;
  session: string;
  turn: number;
  klass: AuditTurn["klass"];
  would_block: boolean | null;
  claims_done: number | null;
  claims_verified: number | null;
  pushback_p: number | null;
  label: Label;
}

interface Split {
  group_yes: number;
  group_no: number;
  rest_yes: number;
  rest_no: number;
  rate_group: number | null;
  rate_rest: number | null;
  ratio: number | null;
  fisher_p: number | null;
}

export function collectAskTurns(root: string, options: { project: string; since?: string }, read: (path: string) => string = (p) => readFileSync(p, "utf8")): AskTurn[] {
  const out: AskTurn[] = [];
  for (const { name, files } of sessionFolders(root, options.project).folders) {
    for (const file of files) {
      let text: string;
      try {
        text = read(join(root, name, file));
      } catch {
        continue;
      }
      const session = file.replace(/\.jsonl$/, "");
      for (const turn of auditTurns(text, session)) {
        if (turn.klass === "no_edit" || !turn.nextPrompt?.trim() || (options.since && turn.ts < options.since)) continue;
        out.push({ folder: folderHash(name), session, turn });
      }
    }
  }
  return out;
}

// One regex per line like .private-terms: blank lines and lines starting with # are ignored, matching is case-insensitive. Errors name the line, never its text.
export function parseTerms(text: string): RegExp[] {
  return text.split(/\r?\n/).flatMap((line, i) => {
    const term = line.trim();
    if (!term || term.startsWith("#")) return [];
    try {
      return [new RegExp(term, "i")];
    } catch {
      throw new RefereeError("bad_input", `Line ${i + 1} of the skip file is not a valid regular expression.`);
    }
  });
}

// Everything a turn would send, tested against the terms; a turn that matches is dropped whole, so a session whose first prompt matches sends none of its turns.
export function withoutTerms(turns: readonly AskTurn[], terms: readonly RegExp[]): { kept: AskTurn[]; skipped: number } {
  if (terms.length === 0) return { kept: [...turns], skipped: 0 };
  const sent = ({ turn }: AskTurn): string => [turn.facts.task, turn.facts.finalMessage, turn.nextPrompt ?? "", ...turn.facts.edits, ...turn.facts.checks.map((c) => c.cmd)].join("\n");
  const kept = turns.filter((t) => !terms.some((re) => re.test(sent(t))));
  return { kept, skipped: turns.length - kept.length };
}

function pick(pack: Pack, id: string): Questions[string] {
  const q = pack.questions[id];
  if (!q) throw new RefereeError("bad_pack", `Pack ${pack.name} has no question ${id}.`, { next_step: "Use the generic pack, or extend it with \"extends\": \"generic\"." });
  return q as unknown as Questions[string];
}

export function planAsk(turns: readonly AskTurn[], pack: Pack): Planned[] {
  const stop = stopQuestions(pack);
  const pushback: Questions = { pushback: pick(pack, "audit.pushback") };
  return turns.flatMap(({ turn }, i): Planned[] => [
    ...(turn.klass === "verified" ? [] : [{ id: `s${i}`, state: stopState(turn.facts, turn.facts.finalMessage), questions: stop }]),
    { id: `p${i}`, state: { previous_message: turn.facts.finalMessage.slice(-PREVIOUS_MAX), next_prompt: (turn.nextPrompt ?? "").slice(0, NEXT_MAX) }, questions: pushback },
  ]);
}

const noul = (outcome: Outcome | undefined, id: string): number | null => {
  const a = outcome?.answers?.[id] as { type?: string; noul?: number } | undefined;
  return a?.type === "noul" && typeof a.noul === "number" ? a.noul : null;
};

function split(rows: readonly Row[], inGroup: (r: Row) => boolean): Split {
  const labelled = rows.filter((r) => r.label === "yes" || r.label === "no");
  const count = (g: boolean, l: Label) => labelled.filter((r) => inGroup(r) === g && r.label === l).length;
  const [a, b, c, d] = [count(true, "yes"), count(true, "no"), count(false, "yes"), count(false, "no")];
  const rateGroup = rate(a, a + b);
  const rateRest = rate(c, c + d);
  return { group_yes: a, group_no: b, rest_yes: c, rest_no: d, rate_group: rateGroup, rate_rest: rateRest, ratio: rateGroup !== null && rateRest !== null && rateRest > 0 ? rateGroup / rateRest : null, fisher_p: a + b > 0 && c + d > 0 ? fisherOneSided(a, b, c, d) : null };
}

export function evaluateAsk(turns: readonly AskTurn[], outcomes: readonly Outcome[], pack: Pack, thresholds: Thresholds) {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const band = threshold(pack, thresholds, "audit.pushback", "auto", 0.9);
  let unanswered = 0;
  let stopped = 0;
  const rows: Row[] = turns.map(({ folder, session, turn }, i) => {
    const gate = byId.get(`s${i}`);
    const push = byId.get(`p${i}`);
    for (const o of [gate, push]) {
      if (o?.error) unanswered += 1;
      else if (o && !o.answers) stopped += 1;
    }
    const decision = gate ? decideStop(gate.answers, pack, thresholds) : null;
    const p = noul(push, "pushback");
    return {
      folder,
      session,
      turn: turn.index,
      klass: turn.klass,
      would_block: turn.klass === "verified" ? false : decision ? decision.would_block : null,
      claims_done: decision?.claims_done ?? null,
      claims_verified: decision?.claims_verified ?? null,
      pushback_p: p,
      label: p === null ? "none" : p >= band ? "yes" : p <= 1 - band ? "no" : "review",
    };
  });
  const asked = rows.filter((r) => r.would_block !== null);
  const gate = split(asked, (r) => r.would_block === true);
  const klass = split(rows, (r) => r.klass !== "verified");
  const scored = asked.filter((r) => r.claims_done !== null && r.claims_verified !== null && (r.label === "yes" || r.label === "no"));
  const score = (r: Row) => (r.claims_done ?? 0) * (1 - (r.claims_verified ?? 0));
  const wouldBlock = rows.filter((r) => r.would_block === true).length;
  const pushbackYes = rows.filter((r) => r.label === "yes").length;
  const enough = wouldBlock >= MIN_GROUP && pushbackYes >= MIN_GROUP;
  const signal = (s: Split) => s.ratio !== null && s.ratio >= 2 && s.fisher_p !== null && s.fisher_p < 0.05;
  const verdict = !enough ? "not_evaluable" : signal(gate) ? "signal" : "no_signal";
  return {
    verdict,
    rows,
    population: rows.length,
    asked: { stop: rows.filter((r) => r.klass !== "verified").length, pushback: rows.filter((r) => r.label !== "none").length },
    would_block: wouldBlock,
    pushback: { yes: pushbackYes, no: rows.filter((r) => r.label === "no").length, review: rows.filter((r) => r.label === "review").length },
    gate,
    unverified: klass,
    auroc: auroc(scored.filter((r) => r.label === "yes").map(score), scored.filter((r) => r.label === "no").map(score)),
    enough_data: enough,
    unanswered,
    stopped,
  };
}
