// audit: replays the Stop gate over your local Claude Code transcripts and counts, per project folder, how many edit turns ended with a passing check.
// Local only: it asks nothing from Jev, sends nothing, and keeps no message text; the full per-folder table goes to a file in the data directory.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../../engine/datadir.ts";
import { RefereeError } from "../../engine/errors.ts";
import { auditDir, editTurns, type Tally } from "../../engine/audit/report.ts";
import { claudeProjectsDir } from "../../engine/usage.ts";
import type { Command } from "../types.ts";
import { str } from "../shared.ts";

const TOP = 10;

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
});

export const audit: Command = {
  name: "audit",
  describe: {
    summary: "Count, per project folder, how many of your Claude Code edit turns ended with a passing check, from your local transcripts. Local only.",
    inputs: {
      "--dir <path>": "The transcripts root; default is the projects folder under the Claude config directory.",
      "--project <text>": "Only folders whose name contains this text.",
      "--since <ISO date>": "Only turns whose user prompt is at or after this time, e.g. 2026-10-01.",
      "--names": "Show each folder's name in the file report (default: a 12-hex hash). The summary line never shows names.",
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
      first: "Earliest turn time seen",
      last: "Latest turn time seen",
      top: `The ${TOP} folders with the most edit turns: folder (hash), edit_turns, verified, unverified, subagent_calls`,
      report: "Path of the file holding every folder's tally",
      unreadable: "Folders or files that could not be read",
    },
    errors: ["bad_input"],
    effects: "Reads transcript files; writes one JSON report to the results folder of the data directory. Nothing leaves the machine.",
    cost: "Free.",
  },
  options: { dir: { type: "string" }, project: { type: "string" }, since: { type: "string" }, names: { type: "boolean" } },
  asksJev: () => false,
  async run(context) {
    const { io } = context;
    const since = str(context, "since") ?? "";
    if (since && Number.isNaN(Date.parse(since))) throw new RefereeError("bad_input", `--since is not a date: ${since}`, { next_step: "Use an ISO date such as 2026-10-01." });
    const dir = str(context, "dir") ?? claudeProjectsDir(io.env, io.home);
    const project = str(context, "project");
    const report = auditDir(dir, { ...(project ? { project } : {}), ...(since ? { since } : {}), names: context.values["names"] === true });
    if (report.total.turns === 0) throw new RefereeError("bad_input", "No transcripts with turns found.", { next_step: `Looked in ${dir}; pass --dir or loosen --project and --since.` });
    const outDir = join(resolveDataDir(io.env, io.home, io.cwd, context.flags.dataDir), "results");
    const path = join(outDir, `audit-${new Date(io.now()).toISOString().replace(/[-:T]/g, "").slice(0, 14)}.json`);
    try {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path, JSON.stringify({ since: since || null, total: summary(report.total), folders: report.folders.map((f) => ({ folder: f.folder, ...(f.name ? { name: f.name } : {}), ...summary(f) })) }, null, 2) + "\n");
    } catch {
      void 0;
    }
    const edits = editTurns(report.total);
    return {
      ok: true,
      verdict: "report",
      ...summary(report.total),
      unverified_share: edits === 0 ? 0 : unverified(report.total) / edits,
      top: report.folders.slice(0, TOP).map((f) => ({ folder: f.folder, edit_turns: editTurns(f), verified: f.classes.verified, unverified: unverified(f), subagent_calls: f.subagent_calls })),
      report: path,
      ...(report.unreadable ? { unreadable: report.unreadable } : {}),
      next_step: "The next-prompt cue is the Stop gate's weak hint, not a label. Reading the turns with Jev (to test whether unverified claims predict pushback) is a separate, opt-in step.",
    };
  },
};
