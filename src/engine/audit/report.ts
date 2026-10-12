// Walks Claude Code's projects directory (one folder per project, one .jsonl per session; subagent files are not read) and tallies replayed Stop-gate turns per folder.
// Read-only and local: no prompt, message or path text is kept; a folder is named by a 12-hex hash unless the caller asks for names.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditTurns, type TurnClass } from "./turns.ts";

export const CLASSES: readonly TurnClass[] = ["no_edit", "verified", "unverified_ran_checks", "unverified_no_check"];

export interface Rate {
  n: number;
  cue: number;
}

export interface Tally {
  sessions: number;
  sessions_with_edits: number;
  turns: number;
  classes: Record<TurnClass, number>;
  next_prompt: Record<TurnClass, Rate>;
  subagent_calls: number;
  subagent_reports: number;
  first: string;
  last: string;
}

export interface FolderTally extends Tally {
  folder: string;
  name?: string;
}

export interface Report {
  total: Tally;
  folders: FolderTally[];
  unreadable: number;
}

export interface AuditOptions {
  readonly project?: string;
  readonly since?: string;
  readonly names?: boolean;
}

const zeroClasses = (): Record<TurnClass, number> => ({ no_edit: 0, verified: 0, unverified_ran_checks: 0, unverified_no_check: 0 });
const zeroRates = (): Record<TurnClass, Rate> => ({ no_edit: { n: 0, cue: 0 }, verified: { n: 0, cue: 0 }, unverified_ran_checks: { n: 0, cue: 0 }, unverified_no_check: { n: 0, cue: 0 } });
export const emptyTally = (): Tally => ({ sessions: 0, sessions_with_edits: 0, turns: 0, classes: zeroClasses(), next_prompt: zeroRates(), subagent_calls: 0, subagent_reports: 0, first: "", last: "" });

export function addTally(into: Tally, from: Tally): void {
  into.sessions += from.sessions;
  into.sessions_with_edits += from.sessions_with_edits;
  into.turns += from.turns;
  into.subagent_calls += from.subagent_calls;
  into.subagent_reports += from.subagent_reports;
  for (const c of CLASSES) {
    into.classes[c] += from.classes[c];
    into.next_prompt[c].n += from.next_prompt[c].n;
    into.next_prompt[c].cue += from.next_prompt[c].cue;
  }
  if (from.first && (!into.first || from.first < into.first)) into.first = from.first;
  if (from.last > into.last) into.last = from.last;
}

export function tallySession(text: string, since = ""): Tally {
  const t = emptyTally();
  const turns = auditTurns(text).filter((turn) => !since || turn.ts >= since);
  if (turns.length === 0) return t;
  t.sessions = 1;
  t.turns = turns.length;
  for (const turn of turns) {
    t.classes[turn.klass] += 1;
    t.subagent_calls += turn.facts.marks.subagentCalls;
    t.subagent_reports += turn.facts.marks.subagentReports;
    if (turn.nextPrompt !== null && turn.nextPrompt.trim()) {
      t.next_prompt[turn.klass].n += 1;
      if (turn.cue !== null) t.next_prompt[turn.klass].cue += 1;
    }
    if (turn.ts && (!t.first || turn.ts < t.first)) t.first = turn.ts;
    if (turn.ts > t.last) t.last = turn.ts;
  }
  if (t.classes.no_edit < t.turns) t.sessions_with_edits = 1;
  return t;
}

export function auditDir(root: string, options: AuditOptions = {}, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Report {
  const total = emptyTally();
  const folders: FolderTally[] = [];
  let unreadable = 0;
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && (!options.project || e.name.includes(options.project))).map((e) => e.name);
  } catch {
    return { total, folders, unreadable };
  }
  for (const name of names.sort()) {
    const tally = emptyTally();
    let files: string[] = [];
    try {
      files = readdirSync(join(root, name)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      unreadable += 1;
      continue;
    }
    for (const file of files.sort()) {
      try {
        addTally(tally, tallySession(read(join(root, name, file)), options.since));
      } catch {
        unreadable += 1;
      }
    }
    if (tally.turns === 0) continue;
    addTally(total, tally);
    folders.push({ folder: createHash("sha256").update(name).digest("hex").slice(0, 12), ...(options.names ? { name } : {}), ...tally });
  }
  folders.sort((a, b) => b.classes.verified + b.classes.unverified_ran_checks + b.classes.unverified_no_check - (a.classes.verified + a.classes.unverified_ran_checks + a.classes.unverified_no_check));
  return { total, folders, unreadable };
}

export const editTurns = (t: Tally): number => t.classes.verified + t.classes.unverified_ran_checks + t.classes.unverified_no_check;
