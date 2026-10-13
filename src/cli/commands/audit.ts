// audit: replays the Stop gate over your local Claude Code transcripts and counts, per project folder, how many edit turns ended with a passing check.
// By default local only: no Jev, nothing sent, no message text kept. With --ask (and a --project scope) it reads the turns with Jev to test whether unverified claims predict the user's pushback.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDataDir } from "../../engine/datadir.ts";
import { RefereeError } from "../../engine/errors.ts";
import { collectAskTurns, evaluateAsk, MAX_ASK, parseTerms, planAsk, withoutTerms } from "../../engine/audit/ask.ts";
import { compareWindows } from "../../engine/audit/compare.ts";
import { auditDir, auditWindows, editTurns, type Report, type Tally } from "../../engine/audit/report.ts";
import { claudeProjectsDir } from "../../engine/usage.ts";
import type { Command, Context } from "../types.ts";
import { JEV_COST, JEV_EFFECTS, JEV_ERRORS, jevCommand, openPack, str } from "../shared.ts";

const TOP = 10;
const WEEKS = 8;

const unverified = (t: Tally): number => t.classes.unverified_ran_checks + t.classes.unverified_no_check;
const rate = (t: Tally, classes: readonly (keyof Tally["classes"])[]) => ({ n: classes.reduce((s, c) => s + t.next_prompt[c].n, 0), weak_cue: classes.reduce((s, c) => s + t.next_prompt[c].cue, 0) });
const summary = (t: Tally) => ({
  sessions: t.sessions,
  sessions_with_edits: t.sessions_with_edits,
  turns: t.turns,
  edit_turns: editTurns(t),
  verified: t.classes.verified,
  unverified_ran_checks: t.classes.unverified_ran_checks,
  unverified_no_check: t.classes.unverified_no_check,
  subagent_calls: t.subagent_calls,
  subagent_reports: t.subagent_reports,
  next_prompt_after_verified: rate(t, ["verified"]),
  next_prompt_after_unverified: rate(t, ["unverified_ran_checks", "unverified_no_check"]),
  next_prompt_after_no_edit: rate(t, ["no_edit"]),
  first: t.first,
  last: t.last,
  weeks: Object.entries(t.weeks).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-WEEKS).map(([week, w]) => ({ week, edit_turns: w.edit_turns, verified: w.verified })),
});

function writeReport(context: Context, kind: string, body: unknown): string | undefined {
  const { io } = context;
  const dir = join(resolveDataDir(io.env, io.home, io.cwd, context.flags.dataDir), "results");
  const path = join(dir, `${kind}-${new Date(io.now()).toISOString().replace(/[-:T]/g, "").slice(0, 14)}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
    return path;
  } catch {
    return undefined;
  }
}

async function ask(context: Context, dir: string, project: string | undefined, since: string) {
  if (!project) throw new RefereeError("bad_input", "--ask needs --project <text> so that the scope of what is sent is explicit.", { next_step: "Pass part of a transcript folder name, e.g. --project my-repo; run --dry-run first." });
  const skipFile = str(context, "skip");
  let terms: RegExp[] = [];
  if (skipFile) {
    try {
      terms = parseTerms(readFileSync(resolve(context.io.cwd, skipFile), "utf8"));
    } catch (error) {
      if (error instanceof RefereeError) throw error;
      throw new RefereeError("bad_input", `Cannot read the skip file: ${skipFile}`);
    }
  }
  const { kept: turns, skipped } = withoutTerms(collectAskTurns(dir, { project, ...(since ? { since } : {}) }), terms);
  if (turns.length === 0) throw new RefereeError("bad_input", "No edit turns with a next prompt found for this scope.", { next_step: `Looked in ${dir} for folders containing ${project}.` });
  if (turns.length > MAX_ASK) throw new RefereeError("too_large", `${turns.length} turns; at most ${MAX_ASK} per run.`, { next_step: "Narrow with --since or a more specific --project." });
  const { pack, project: config } = openPack(context);
  const planned = planAsk(turns, pack);
  return jevCommand(
    context,
    "audit",
    pack,
    planned,
    (outcomes) => {
      const { rows, verdict, ...rest } = evaluateAsk(turns, outcomes, pack, config?.thresholds);
      const written = writeReport(context, "audit-ask", { since: since || null, ...rest, rows });
      return {
        ok: true,
        verdict,
        ...rest,
        skipped,
        ...(written ? { rows: written } : {}),
        next_step: rest.enough_data ? "Read the pushback-labelled turns against their next prompts (bar B1) before using this result." : "Not enough would_block or pushback turns for a signal claim; this run adds to the record, it does not decide anything.",
      };
    },
    { batch: true },
  );
}

export const audit: Command = {
  name: "audit",
  describe: {
    summary: "Count, per project folder, how many of your Claude Code edit turns ended with a passing check, from your local transcripts. Local only.",
    inputs: {
      "--dir <path>": "The transcripts root; default is the projects folder under the Claude config directory.",
      "--project <text>": "Only folders whose name contains this text.",
      "--since <ISO date>": "Only turns whose user prompt is at or after this time, e.g. 2026-10-01.",
      "--until <ISO date>": "Only turns whose user prompt is before this time.",
      "--exclude <text>": "Leave out folders whose name contains this text (e.g. this repository's own development, which checks by habit).",
      "--compare <ISO date>": "Split the turns at this time and compare the verified share of edit turns before and after it, pooled and over folders with at least 3 edit turns in each window, with a one-sided Fisher exact test. Verdict: not_evaluable (under 30 edit turns in a window), higher, lower or no_signal; an association after a date, not an effect. Local only.",
      "--names": "Show each folder's name in the file report (default: a 12-hex hash). The summary line never shows names.",
      "--skip <file>": "With --ask: a file of regular expressions, one per line (the format of a .private-terms file). A turn whose session task, final message, check commands, edited paths or next prompt matches any of them is not sent.",
      "--ask": `Read the edit turns that have a next prompt with Jev (the Stop gate's questions and a pushback question) and compare the gate with the user's pushback. Needs --project; at most ${MAX_ASK} turns. Sends redacted excerpts of those turns (the session's first prompt, the final message, the check commands and the next prompt) to the TypeSafe API: run it with --dry-run first to see exactly what would be sent.`,
    },
    outputs: {
      verdict: "report",
      sessions: "Main session transcripts with at least one turn in range (subagent transcripts are not read)",
      sessions_with_edits: "Sessions with at least one accepted edit",
      turns: "Real user prompts, each one turn",
      edit_turns: "Turns with at least one accepted edit",
      verified: "Edit turns with a passing check after the last edit (the Stop gate would skip them)",
      unverified_ran_checks: "Edit turns where checks ran but none passed after the last edit",
      unverified_no_check: "Edit turns with no check at all",
      unverified_share: "(unverified_ran_checks + unverified_no_check) / edit_turns",
      subagent_calls: "Agent or Task tool calls in these turns",
      subagent_reports: "Subagent completion notices in these turns",
      next_prompt_after_verified: "{n, weak_cue}: of the verified turns that have a next prompt, how many next prompts report breakage or repeat the request (the Stop gate's weak hint; it is built to avoid false positives and misses most pushback, so it is a floor, not a label)",
      next_prompt_after_unverified: "The same for unverified edit turns",
      next_prompt_after_no_edit: "The same for turns without edits",
      weeks: `The last ${WEEKS} ISO weeks with edit turns: week, edit_turns, verified (the verified share per week, to see whether a change such as the session briefing moved it)`,
      first: "Earliest turn time seen",
      last: "Latest turn time seen",
      top: `The ${TOP} folders with the most edit turns: folder (hash), edit_turns, verified, unverified, subagent_calls`,
      report: "Path of the file holding every folder's tally",
      cut: "With --compare: the split time",
      before: "With --compare: {edit_turns, verified, share} for turns before the cut",
      after: "With --compare: the same for turns at or after the cut",
      difference: "With --compare: share after minus share before, or null",
      p_higher: "With --compare: one-sided Fisher exact p that the share after is higher (read as: below 0.05 and a difference of at least 0.10 for higher)",
      p_lower: "With --compare: the same for lower",
      paired: "With --compare: {folders, before, after}, the same counts over folders with at least 3 edit turns in both windows, or null when fewer than 2 folders qualify",
      paired_difference: "With --compare: the difference over those folders; higher and lower need it to point the same way",
      unreadable: "Folders or files that could not be read",
      population: "With --ask: edit turns that have a next prompt",
      asked: "With --ask: {stop, pushback}, the number of turns sent to the Stop gate's questions (unverified turns only, as the hook would) and to the pushback question",
      would_block: "With --ask: turns the Stop gate would have flagged (claims done, not verified, a check applies, not blocked)",
      funnel: "With --ask: where unverified turns drop out of the gate: unverified (edit turns without a passing check), answered (Jev answered the gate), claimed_done (claims_done at the gate band), not_verified (and claims_verified below its band), check_applies (and a check applies), would_block (and not blocked or waiting for input; equals would_block)",
      pushback: "With --ask: {yes, no, review}, the user's next prompt read by Jev at the audit.pushback band (0.9 by default)",
      gate: "With --ask: would_block against pushback: group_yes, group_no (would_block turns with and without pushback), rest_yes, rest_no, rate_group, rate_rest, ratio and the one-sided Fisher exact p",
      unverified: "With --ask: the same split for unverified against verified turns",
      auroc: "With --ask: how well claims_done * (1 - claims_verified) ranks pushback turns above the others, or null",
      enough_data: `With --ask: at least 15 would_block turns and 15 pushback turns; below that the verdict is not_evaluable`,
      skipped: "With --ask: turns dropped before sending because they matched a --skip pattern",
      unanswered: "With --ask: requests with no answer because of an API error or the deadline",
      stopped: "With --ask: requests not sent because they held something shaped like a credential",
      rows: "With --ask: path of the per-turn file (folder hash, session id, turn index, scores; no text)",
    },
    errors: ["bad_input", "too_large", ...JEV_ERRORS],
    effects: `Reads transcript files and writes a JSON report to the results folder of the data directory. Without --ask nothing leaves the machine. ${JEV_EFFECTS}`,
    cost: `Free without --ask. With --ask: ${JEV_COST} One request for each unverified turn and one for each next prompt.`,
  },
  options: { dir: { type: "string" }, project: { type: "string" }, since: { type: "string" }, until: { type: "string" }, exclude: { type: "string" }, compare: { type: "string" }, names: { type: "boolean" }, ask: { type: "boolean" }, skip: { type: "string" } },
  asksJev: (context) => context.values["ask"] === true,
  async run(context) {
    const { io } = context;
    const [since, until, cut, exclude] = ["since", "until", "compare", "exclude"].map((name) => str(context, name) ?? "") as [string, string, string, string];
    for (const [name, value] of [["since", since], ["until", until], ["compare", cut]] as const) {
      if (value && Number.isNaN(Date.parse(value))) throw new RefereeError("bad_input", `--${name} is not a date: ${value}`, { next_step: "Use an ISO date such as 2026-10-01." });
    }
    const dir = str(context, "dir") ?? claudeProjectsDir(io.env, io.home);
    const project = str(context, "project");
    if (context.values["ask"] === true) {
      if (until || cut || exclude) throw new RefereeError("bad_input", "--ask cannot be combined with --until, --exclude or --compare.", { next_step: "Narrow an --ask run with --project and --since." });
      return ask(context, dir, project, since);
    }
    const names = context.values["names"] === true;
    const scope = { ...(project ? { project } : {}), ...(exclude ? { exclude } : {}), names };
    const empty = new RefereeError("bad_input", "No transcripts with turns found.", { next_step: `Looked in ${dir}; pass --dir or loosen --project, --since and --until.` });
    if (cut) {
      const [before, after] = auditWindows(dir, [{ ...(since ? { since } : {}), until: cut }, { since: cut, ...(until ? { until } : {}) }], scope) as [Report, Report];
      if (before.total.turns + after.total.turns === 0) throw empty;
      const compare = compareWindows(before, after);
      const window = (r: Report) => ({ total: summary(r.total), folders: r.folders.map((f) => ({ folder: f.folder, ...(f.name ? { name: f.name } : {}), ...summary(f) })) });
      const file = writeReport(context, "audit-compare", { since: since || null, until: until || null, cut, compare, before: window(before), after: window(after) });
      const { verdict, ...rest } = compare;
      return {
        ok: true,
        verdict,
        cut,
        ...rest,
        ...(file ? { report: file } : {}),
        ...(before.unreadable ? { unreadable: before.unreadable } : {}),
        next_step: verdict === "not_evaluable" ? "Under 30 edit turns in a window; this run decides nothing. Run it again when more turns exist." : "An association after a date, not an effect: nothing is randomised and habits drift. Read the paired line before citing it.",
      };
    }
    const report = auditDir(dir, { ...scope, ...(since ? { since } : {}), ...(until ? { until } : {}) });
    if (report.total.turns === 0) throw empty;
    const path = writeReport(context, "audit", { since: since || null, total: summary(report.total), folders: report.folders.map((f) => ({ folder: f.folder, ...(f.name ? { name: f.name } : {}), ...summary(f) })) });
    const edits = editTurns(report.total);
    return {
      ok: true,
      verdict: "report",
      ...summary(report.total),
      unverified_share: edits === 0 ? 0 : unverified(report.total) / edits,
      top: report.folders.slice(0, TOP).map((f) => ({ folder: f.folder, edit_turns: editTurns(f), verified: f.classes.verified, unverified: unverified(f), subagent_calls: f.subagent_calls })),
      ...(path ? { report: path } : {}),
      ...(report.unreadable ? { unreadable: report.unreadable } : {}),
      next_step: "The next-prompt cue is the Stop gate's weak hint, not a label. Reading the turns with Jev (to test whether unverified claims predict pushback) is a separate, opt-in step.",
    };
  },
};
