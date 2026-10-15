// Shared types of the Stop done-gate (shadow mode): facts read from a transcript, Jev's decision and the stored stop record.
// Skips credential, no_key and config_error never reached Jev (redaction stop, no usable key, pack that does not load); only jev_error and breaker_open are Jev errors.
// turn: a short hash keying the turn (its prompt's uuid, else that line's position and the session); bg_pending, bg_types (counts per task type) and would_ask appear only on background_tasks skips.

import type { ErrorCode } from "../errors.ts";
import type { CheckoutClass } from "../datadir.ts";

export type CheckStatus = "passed" | "failed" | "unknown" | "denied";
// denied: Claude Code refused the command before running it (permission or hook denial); never a pass, never a fail.

export interface CheckRun {
  readonly cmd: string;
  readonly status: CheckStatus;
  readonly truncated?: true;
}

export interface StopMarks {
  readonly truncatedChecks: number;
  readonly subagentCalls: number;
  readonly subagentReports: number;
  readonly stalePass: boolean;
}

export interface StopFacts {
  readonly task: string;
  readonly finalMessage: string;
  readonly edits: readonly string[];
  readonly checks: readonly CheckRun[];
  readonly passedCheckAfterLastEdit: boolean;
  readonly marks: StopMarks;
  readonly turn?: string;
}

export interface StopDecision {
  readonly claims_done: number;
  readonly claims_verified: number;
  readonly verification_applies: number;
  readonly outcome: Readonly<Record<string, number>>;
  readonly would_block: boolean;
}

export type StopSkip = "stop_hook_active" | "background_tasks" | "no_edits" | "check_passed_after_edit" | "breaker_open" | "no_transcript" | "jev_error" | "credential" | "no_key" | "config_error";

export interface StopRecord {
  readonly id: string;
  readonly ts: string;
  readonly session_id: string;
  readonly project: string;
  readonly worktree?: CheckoutClass;
  readonly mode: "shadow" | "soft";
  readonly configured?: "active";
  readonly skipped?: StopSkip;
  readonly error?: ErrorCode;
  readonly edits: number;
  readonly checks: number;
  readonly truncated_checks?: number;
  readonly subagent_calls?: number;
  readonly subagent_reports?: number;
  readonly stale_pass?: true;
  readonly turn?: string;
  readonly bg_pending?: number;
  readonly bg_types?: Readonly<Record<string, number>>;
  readonly would_ask?: boolean;
  readonly decision?: StopDecision;
  readonly ms: number;
  readonly task_excerpt?: string;
  readonly final_excerpt?: string;
  readonly label?: "right" | "wrong";
  readonly labelled_at?: string;
}
