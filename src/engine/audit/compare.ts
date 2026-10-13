// The registered before/after reading (docs/decisions/audit-command.md, step 3): the verified share of edit turns in two windows, pooled and over folders that have enough edit turns in both.
// Bars C1 and C2 are the constants below; the verdict is an association after a date, never an effect.

import { editTurns, type Report } from "./report.ts";
import { fisherOneSided } from "./stats.ts";

export const MIN_WINDOW = 30;
export const MIN_FOLDER = 3;
export const MIN_PAIRED_FOLDERS = 2;
export const MIN_DIFFERENCE = 0.1;
export const ALPHA = 0.05;

export interface Arm {
  edit_turns: number;
  verified: number;
  share: number | null;
}

const arm = (edit_turns: number, verified: number): Arm => ({ edit_turns, verified, share: edit_turns === 0 ? null : verified / edit_turns });
const armOf = (r: Report): Arm => arm(editTurns(r.total), r.total.classes.verified);
const gap = (after: Arm, before: Arm): number | null => (after.share === null || before.share === null ? null : after.share - before.share);

export function compareWindows(before: Report, after: Report) {
  const b = armOf(before);
  const a = armOf(after);
  const earlier = new Map(before.folders.map((f) => [f.folder, f]));
  const pairs = after.folders.flatMap((f) => {
    const e = earlier.get(f.folder);
    return e && editTurns(e) >= MIN_FOLDER && editTurns(f) >= MIN_FOLDER ? [{ e, f }] : [];
  });
  const sum = (pick: (p: (typeof pairs)[number]) => Report["folders"][number]) => arm(pairs.reduce((s, p) => s + editTurns(pick(p)), 0), pairs.reduce((s, p) => s + pick(p).classes.verified, 0));
  const paired = pairs.length >= MIN_PAIRED_FOLDERS ? { folders: pairs.length, before: sum((p) => p.e), after: sum((p) => p.f) } : null;
  const difference = gap(a, b);
  const pairedDifference = paired ? gap(paired.after, paired.before) : null;
  const pHigher = fisherOneSided(a.verified, a.edit_turns - a.verified, b.verified, b.edit_turns - b.verified);
  const pLower = fisherOneSided(b.verified, b.edit_turns - b.verified, a.verified, a.edit_turns - a.verified);
  const enough = b.edit_turns >= MIN_WINDOW && a.edit_turns >= MIN_WINDOW;
  const higher = difference !== null && difference >= MIN_DIFFERENCE && pHigher < ALPHA && pairedDifference !== null && pairedDifference > 0;
  const lower = difference !== null && difference <= -MIN_DIFFERENCE && pLower < ALPHA && pairedDifference !== null && pairedDifference < 0;
  return { verdict: !enough ? "not_evaluable" : higher ? "higher" : lower ? "lower" : "no_signal", before: b, after: a, difference, p_higher: pHigher, p_lower: pLower, paired, paired_difference: pairedDifference };
}
