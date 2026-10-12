// Replays the Stop gate over a whole transcript: for each real user prompt, the facts the hook would have read when that turn ended, and the next prompt.
// A turn is classified with the gate's own skip rule, so audit counts and Stop records agree. The next prompt is the label source: text stays in memory only.

import { stopSkipReason } from "../stopgate/decide.ts";
import { analyzeTranscript, promptOffsets } from "../stopgate/transcript.ts";
import type { StopFacts } from "../stopgate/types.ts";
import { classifyNext, type WeakReason } from "../stopgate/weak.ts";

export type TurnClass = "no_edit" | "verified" | "unverified_ran_checks" | "unverified_no_check";

export interface AuditTurn {
  readonly index: number;
  readonly ts: string;
  readonly facts: StopFacts;
  readonly klass: TurnClass;
  readonly prompt: string;
  readonly nextPrompt: string | null;
  readonly cue: WeakReason | null;
}

export function turnClass(facts: StopFacts): TurnClass {
  const skip = stopSkipReason(facts);
  if (skip === "no_edits") return "no_edit";
  if (skip === "check_passed_after_edit") return "verified";
  return facts.checks.length > 0 ? "unverified_ran_checks" : "unverified_no_check";
}

export function auditTurns(text: string, session = ""): AuditTurn[] {
  const prompts = promptOffsets(text);
  return prompts.map((p, index) => {
    const end = prompts[index + 1]?.lineStart ?? text.length;
    const facts = analyzeTranscript(text.slice(0, end), session);
    const nextPrompt = prompts[index + 1]?.text ?? null;
    return { index, ts: p.ts, facts, klass: turnClass(facts), prompt: p.text, nextPrompt, cue: nextPrompt && nextPrompt.trim() ? classifyNext(nextPrompt, p.text) : null };
  });
}
