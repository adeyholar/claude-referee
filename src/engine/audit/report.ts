// Walks Claude Code's projects directory (one folder per project, one .jsonl per session; subagent files are not read) and tallies replayed Stop-gate turns per folder.
// Read-only and local: no prompt, message or path text is kept; a folder is named by a 12-hex hash unless the caller asks for names.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditTurns, type AuditTurn, type TurnClass } from "./turns.ts";

export const CLASSES: readonly TurnClass[] = ["no_edit", "verified", "unverified_ran_checks", "unverified_no_check"];

export interface Rate {
  n: number;
  cue: number;
}

export interface Week {
  edit_turns: number;
  verified: number;
}

export interface Tally {
  weeks: Record<string, Week>;
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

export interface Window {
  readonly since?: string;
  readonly until?: string;
}

export interface AuditOptions extends Window {
  readonly project?: string;
  readonly exclude?: string;
  readonly names?: boolean;
}

const zeroClasses = (): Record<TurnClass, number> => ({ no_edit: 0, verified: 0, unverified_ran_checks: 0, unverified_no_check: 0 });
const zeroRates = (): Record<TurnClass, Rate> => ({ no_edit: { n: 0, cue: 0 }, verified: { n: 0, cue: 0 }, unverified_ran_checks: { n: 0, cue: 0 }, unverified_no_check: { n: 0, cue: 0 } });
export const emptyTally = (): Tally => ({ weeks: {}, sessions: 0, sessions_with_edits: 0, turns: 0, classes: zeroClasses(), next_prompt: zeroRates(), subagent_calls: 0, subagent_reports: 0, first: "", last: "" });

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
  for (const [week, w] of Object.entries(from.weeks)) {
    const to = (into.weeks[week] ??= { edit_turns: 0, verified: 0 });
    to.edit_turns += w.edit_turns;
    to.verified += w.verified;
  }
  if (from.first && (!into.first || from.first < into.first)) into.first = from.first;
  if (from.last > into.last) into.last = from.last;
}

// ISO 8601 week of an ISO timestamp, "" when it does not parse.
export function isoWeek(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  return `${year}-W${String(Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

const inWindow = (ts: string, w: Window): boolean => !(w.since || w.until) || (ts !== "" && (!w.since || ts >= w.since) && (!w.until || ts < w.until));

export const tallySession = (text: string, since = ""): Tally => tallyTurns(auditTurns(text), { since });

export function tallyTurns(all: readonly AuditTurn[], window: Window): Tally {
  const t = emptyTally();
  const turns = all.filter((turn) => inWindow(turn.ts, window));
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
    const week = turn.klass === "no_edit" ? "" : isoWeek(turn.ts);
    if (week) {
      const w = (t.weeks[week] ??= { edit_turns: 0, verified: 0 });
      w.edit_turns += 1;
      if (turn.klass === "verified") w.verified += 1;
    }
    if (turn.ts && (!t.first || turn.ts < t.first)) t.first = turn.ts;
    if (turn.ts > t.last) t.last = turn.ts;
  }
  if (t.classes.no_edit < t.turns) t.sessions_with_edits = 1;
  return t;
}

export function sessionFolders(root: string, project?: string, exclude?: string): { folders: { name: string; files: string[] }[]; unreadable: number } {
  const folders: { name: string; files: string[] }[] = [];
  let unreadable = 0;
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && (!project || e.name.includes(project)) && !(exclude && e.name.includes(exclude))).map((e) => e.name);
  } catch {
    return { folders, unreadable };
  }
  for (const name of names.sort()) {
    try {
      folders.push({ name, files: readdirSync(join(root, name)).filter((f) => f.endsWith(".jsonl")).sort() });
    } catch {
      unreadable += 1;
    }
  }
  return { folders, unreadable };
}

// One pass over the transcripts for several windows: each file is replayed once and its turns are tallied into every window, so a before/after split costs the same scan as one report.
export function auditWindows(root: string, windows: readonly Window[], options: Omit<AuditOptions, keyof Window> = {}, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Report[] {
  const found = sessionFolders(root, options.project, options.exclude);
  const reports: Report[] = windows.map(() => ({ total: emptyTally(), folders: [], unreadable: found.unreadable }));
  for (const { name, files } of found.folders) {
    const tallies = windows.map(() => emptyTally());
    for (const file of files) {
      try {
        const turns = auditTurns(read(join(root, name, file)));
        windows.forEach((w, i) => addTally(tallies[i] as Tally, tallyTurns(turns, w)));
      } catch {
        for (const r of reports) r.unreadable += 1;
      }
    }
    tallies.forEach((tally, i) => {
      const report = reports[i] as Report;
      if (tally.turns === 0) return;
      addTally(report.total, tally);
      report.folders.push({ folder: folderHash(name), ...(options.names ? { name } : {}), ...tally });
    });
  }
  for (const r of reports) r.folders.sort((a, b) => editTurns(b) - editTurns(a));
  return reports;
}

export const auditDir = (root: string, options: AuditOptions = {}, read?: (path: string) => string): Report => auditWindows(root, [{ ...(options.since ? { since: options.since } : {}), ...(options.until ? { until: options.until } : {}) }], options, read)[0] as Report;

export const folderHash = (name: string): string => createHash("sha256").update(name).digest("hex").slice(0, 12);

export const editTurns = (t: Tally): number => t.classes.verified + t.classes.unverified_ran_checks + t.classes.unverified_no_check;
