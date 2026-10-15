// Stop done-gate, shadow mode (off unless .claude/referee.json sets hooks.stopGate): after a turn with edits and no passing check, asks Jev whether Claude claimed success it didn't verify.
// It records the decision (stops.jsonl) and never blocks; "soft" also returns a systemMessage JSON line (a user-visible warning), "shadow" prints nothing; "active" is not built and runs as shadow, marked configured.
// Fails open: a failure is recorded with its error code (and a receipt once a Session exists). While background tasks run it asks nothing but records counts, turn, bg_pending and would_ask; an unreadable transcript or a scan past BG_SCAN_MAX keeps edits 0, checks 0, no would_ask.

import { readFileSync } from "node:fs";
import { checkoutClass, projectId, resolveDataDir } from "../engine/datadir.ts";
import { RefereeError, isRefereeError, type ErrorCode } from "../engine/errors.ts";
import { loadPack, packDirs } from "../engine/pack.ts";
import { loadProject } from "../engine/project.ts";
import { Session, type Outcome } from "../engine/session.ts";
import { decideStop, stopQuestions, stopSkipReason, stopState } from "../engine/stopgate/decide.ts";
import { appendStop, newStopId } from "../engine/stopgate/stops.ts";
import { analyzeTranscript, currentTurn, scanLength } from "../engine/stopgate/transcript.ts";
import type { StopFacts, StopRecord, StopSkip } from "../engine/stopgate/types.ts";
import type { HookIo } from "./session-start.ts";

interface StopInput {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  background_tasks?: unknown;
}

const EXCERPT = 200;
const BG_SCAN_MAX = 8_000_000;
const LOCAL_SKIP: Partial<Record<ErrorCode, StopSkip>> = { credential_in_state: "credential", no_api_key: "no_key", invalid_api_key: "no_key", pack_not_found: "config_error", bad_pack: "config_error" };

export { decideStop };

function readTranscript(path: unknown): string | null {
  if (typeof path !== "string") return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function recordFacts(facts: StopFacts) {
  const { marks } = facts;
  return {
    edits: facts.edits.length,
    checks: facts.checks.length,
    ...(marks.truncatedChecks > 0 ? { truncated_checks: marks.truncatedChecks } : {}),
    ...(marks.subagentCalls > 0 ? { subagent_calls: marks.subagentCalls } : {}),
    ...(marks.subagentReports > 0 ? { subagent_reports: marks.subagentReports } : {}),
    ...(marks.stalePass ? { stale_pass: true as const } : {}),
    ...(facts.turn ? { turn: facts.turn } : {}),
  };
}

function backgroundFacts(text: string | null, pending: number, session: string): Partial<StopRecord> {
  if (text === null) return { bg_pending: pending };
  try {
    if (scanLength(text) > BG_SCAN_MAX) {
      const turn = currentTurn(text, session);
      return { ...(turn ? { turn } : {}), bg_pending: pending };
    }
    const facts = analyzeTranscript(text, session);
    return { ...recordFacts(facts), bg_pending: pending, would_ask: stopSkipReason(facts) === null };
  } catch {
    return { bg_pending: pending };
  }
}

export const SOFT_NOTE = "claude-referee: this turn edited files and claimed it was done, but no passing check ran after the last edit. Run the project's tests or build before trusting it.";

export async function stopGate(io: HookIo, _pluginRoot: string): Promise<string | undefined> {
  const started = io.now();
  const { env } = io;
  if (env["REFEREE_HOOKS"] === "off" || /^(?:false|0|no|off)$/i.test(env["CLAUDE_PLUGIN_OPTION_HOOKS_ENABLED"]?.trim() ?? "")) return;
  let input: StopInput;
  try {
    input = JSON.parse(await io.readStdin()) as StopInput;
  } catch {
    return;
  }
  if (typeof input?.cwd !== "string") return;
  const cwd = input.cwd;
  const project = loadProject(cwd, env);
  if (!project || project.hooks.stopGate === "off") return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "unknown";
  const dataDir = resolveDataDir(env, io.home, cwd);
  const base = { id: newStopId(started), ts: new Date(started).toISOString(), session_id: sessionId, project: projectId(cwd), worktree: checkoutClass(cwd), mode: project.hooks.stopGate === "soft" ? ("soft" as const) : ("shadow" as const), ...(project.hooks.stopGate === "active" ? { configured: "active" as const } : {}) };
  const finish = (skipped: StopSkip | undefined, rest: Partial<StopRecord> = {}): undefined => {
    appendStop(dataDir, { ...base, ...(skipped ? { skipped } : {}), edits: 0, checks: 0, ms: Math.max(0, io.now() - started), ...rest } as StopRecord);
    return undefined;
  };

  if (input.stop_hook_active === true) {
    const text = readTranscript(input.transcript_path);
    const turn = text === null ? undefined : currentTurn(text, sessionId);
    return finish("stop_hook_active", turn ? { turn } : {});
  }
  const pending = Array.isArray(input.background_tasks) ? input.background_tasks.length : 0;
  const text = readTranscript(input.transcript_path);
  if (pending > 0) return finish("background_tasks", backgroundFacts(text, pending, sessionId));
  if (text === null) return finish("no_transcript");
  const facts = analyzeTranscript(text, sessionId);
  const counts = recordFacts(facts);
  const skip = stopSkipReason(facts);
  if (skip) return finish(skip, counts);
  const finalMessage = typeof input.last_assistant_message === "string" && input.last_assistant_message.trim() ? input.last_assistant_message.slice(-2_000) : facts.finalMessage;

  let session: Session | undefined;
  try {
    const pack = loadPack(project.pack, packDirs(env));
    const questions = stopQuestions(pack);
    session = new Session({
      command: "stop-gate",
      env,
      cwd,
      home: io.home,
      platform: process.platform,
      now: io.now,
      pack: { name: pack.name, version: `${pack.version}+${pack.hash}`, redact: pack.redact },
      profile: "hook",
      sessionId,
    });
    const [outcome] = (await session.run([{ id: "stop", state: stopState(facts, finalMessage), questions }])) as Outcome[];
    session.record({ verdict: base.mode });
    const decision = decideStop(outcome?.answers ?? null, pack, project.thresholds);
    if (!decision) return finish("jev_error", counts);
    finish(undefined, { ...counts, decision, task_excerpt: facts.task.slice(0, EXCERPT), final_excerpt: finalMessage.slice(0, EXCERPT) });
    if (project.hooks.stopGate === "soft" && decision.would_block) return JSON.stringify({ systemMessage: SOFT_NOTE }) + "\n";
  } catch (error) {
    const known = isRefereeError(error) ? error : new RefereeError("internal", "Unexpected error in the Stop hook.");
    if (known.code === "breaker_open") return finish("breaker_open", counts);
    session?.record({ error: known });
    return finish(LOCAL_SKIP[known.code] ?? "jev_error", { ...counts, error: known.code });
  }
  return undefined;
}
