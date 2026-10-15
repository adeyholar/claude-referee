// receipts: totals of the local receipts for this project (or all with --all), per day and command with --tokens,
// Claude-side CLI calls from session transcripts with --usage, "receipts export --out <file>" to copy every receipt,
// --stops / --label to list and mark the Stop done-gate's shadow stops, and --session to join one Claude Code session across projects.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { projectId, resolveDataDir, tildify } from "../../engine/datadir.ts";
import { RefereeError } from "../../engine/errors.ts";
import { REASON_CODE, SESSION_ID, canonicalCommand, overruleReceipt, readReceipts, verifyChain, type Receipt } from "../../engine/receipts.ts";
import { loadPack, packDirs, threshold } from "../../engine/pack.ts";
import { loadProject } from "../../engine/project.ts";
import { suggestThreshold } from "../../engine/stopgate/interval.ts";
import { labelStop, readStops, stopStats } from "../../engine/stopgate/stops.ts";
import { labelReceipt, listEvidenceIds, readEvidence, readReceiptLabels } from "../../engine/evidence.ts";
import type { StopRecord } from "../../engine/stopgate/types.ts";
import { suggestForStops, transcriptLocator, type TranscriptLocator } from "../../engine/stopgate/weak.ts";
import { claudeProjectsDir, projectTranscriptDirs, scanUsage } from "../../engine/usage.ts";
import type { Command, Context } from "../types.ts";
import { str } from "../shared.ts";

const STOPS_SHOWN = 20;

function sum(receipts: readonly Receipt[], key: "requests" | "cached" | "input_tokens" | "cost_usd"): number {
  return receipts.reduce((total, r) => total + (r[key] ?? 0), 0);
}

function newestFirst<T extends { readonly ts: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

function stopRows(picked: readonly StopRecord[], locator: TranscriptLocator, withProject = false) {
  const weak = suggestForStops(locator, picked.filter((r) => r.decision?.would_block === true && !r.label));
  return picked.map((r) => ({
    id: r.id,
    ts: r.ts,
    ...(withProject ? { project: r.project } : {}),
    skipped: r.skipped,
    error: r.error,
    configured: r.configured,
    edits: r.edits,
    checks: r.checks,
    turn: r.turn,
    bg_pending: r.bg_pending,
    bg_types: r.bg_types,
    would_ask: r.would_ask,
    would_block: r.decision?.would_block,
    claims_done: r.decision?.claims_done,
    claims_verified: r.decision?.claims_verified,
    task_excerpt: r.task_excerpt?.slice(0, 300),
    final_excerpt: r.final_excerpt?.slice(0, 300),
    label: r.label,
    ...(r.label === undefined && weak.has(r.id) ? { suggestion: weak.get(r.id) } : {}),
  }));
}

function tally<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function lineCount(path: string): number | null {
  try {
    const bytes = readFileSync(path);
    let lines = 0;
    for (const byte of bytes) if (byte === 10) lines++;
    return bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? lines + 1 : lines;
  } catch {
    return null;
  }
}

function sessionJoin(context: Context, dataDir: string, since: string | null) {
  const { io } = context;
  const raw = str(context, "session") ?? "";
  const id = raw === "current" ? io.env["CLAUDE_CODE_SESSION_ID"] : raw;
  if (raw === "current" && !id) {
    throw new RefereeError("bad_input", "--session current reads CLAUDE_CODE_SESSION_ID, which is not set here; Claude Code sets it only for the commands it runs.", {
      next_step: "Run receipts --session current from Claude Code's Bash tool, or pass the id: receipts --session <id>.",
    });
  }
  if (id === undefined || !SESSION_ID.test(id)) {
    throw new RefereeError("bad_input", "--session takes current or a session id of 1 to 64 letters, digits, '.', '_' or '-'.", { next_step: "Run receipts --session current from Claude Code's Bash tool." });
  }
  for (const flag of ["stops", "unlabelled", "tokens", "usage", "all"]) {
    if (context.values[flag] === true) throw new RefereeError("bad_input", `--session cannot be combined with --${flag}.`, { next_step: "Run receipts --session <id> on its own." });
  }
  const inWindow = (ts: unknown) => typeof ts === "string" && (since === null || ts >= since);
  const receipts = readReceipts(dataDir).filter((r) => r.session_id === id && inWindow(r.ts));
  const stops = readStops(dataDir).filter((r) => r.session_id === id && inWindow(r.ts));
  const byCommand = tally<number>();
  const byVerdict = tally<Record<string, number>>();
  const byProject = tally<{ receipts: number; stops: number }>();
  const project = (p: unknown) => (byProject[typeof p === "string" ? p : "unknown"] ??= { receipts: 0, stops: 0 });
  for (const r of receipts) {
    const command = typeof r.command === "string" ? canonicalCommand(r.command) : "unknown";
    byCommand[command] = (byCommand[command] ?? 0) + 1;
    const outcome = [r.verdict, r.error].find((v): v is string => typeof v === "string" && REASON_CODE.test(v)) ?? "other";
    const verdicts = (byVerdict[command] ??= tally<number>());
    verdicts[outcome] = (verdicts[outcome] ?? 0) + 1;
    project(r.project).receipts += 1;
  }
  for (const s of stops) project(s.project).stops += 1;
  const locator = transcriptLocator(projectTranscriptDirs(io.env, io.home, io.cwd), claudeProjectsDir(io.env, io.home));
  const transcript = locator.find(id);
  return {
    ok: true,
    verdict: "session",
    session_id: id,
    ...(since === null ? {} : { days: Number(str(context, "days")) }),
    runs: receipts.length,
    requests: sum(receipts, "requests"),
    cached: sum(receipts, "cached"),
    input_tokens: sum(receipts, "input_tokens"),
    cost_usd: sum(receipts, "cost_usd"),
    by_command: byCommand,
    by_verdict: byVerdict,
    by_project: byProject,
    transcript_found: transcript !== null,
    transcript_lines: transcript === null ? null : lineCount(transcript),
    stats: stopStats(stops),
    stops: stopRows(newestFirst(stops).slice(0, STOPS_SHOWN), locator, true),
    receipt: `session-${io.now().toString(36)}`,
  };
}

export const receipts: Command = {
  name: "receipts",
  describe: {
    summary: "Show totals from the local receipts, per day with --tokens, Claude-side calls with --usage, one Claude Code session with --session, or export them.",
    inputs: {
      export: "Positional: write every receipt, all projects, to --out as JSON lines. A receipt holds id, ts, command, project (a hash of the repository path), pack, model, verdict, reason (a fixed code), outcome, error (the code), requests, cached, input_tokens, cost_usd, request_ids, qhash, cache_keys, prev, fresh, stopped, replaced, chars, ms, run_id and session_id (the hook's session, or for the CLI Claude Code's CLAUDE_CODE_SESSION_ID when it is 1 to 64 letters, digits, '.', '_' or '-'), each only when it applies; never request text, criteria, claim text or ids, option names, items, file paths or user names.",
      verify: "Positional: check the hash chain of every project's receipts (add --project-only for the current one). Receipts written before chaining existed are counted as unchained.",
      overrule: "Positional: \"overrule <id>\" voids one decision: it is recorded in overruled.jsonl and the cached answers it used are deleted, so the next run asks again. The receipt itself is not rewritten.",
      "--out <file>": "Target file for export.",
      "--tokens": "Rows per day and command: runs, requests, cache hits, input tokens and the share of --fresh runs. verify (the old name of claims) counts as claims.",
      "--usage": "Claude-side: claude-referee CLI calls per day and command (verify counted as claims), counted from this project's Claude Code transcripts (subagents included, each tool call once, also behind env, timeout, nohup or xargs), with the size of what each call returned. Nothing from the transcripts is printed.",
      "--stops": "List the Stop done-gate's shadow stops of this project, newest first, at most 20, with stats (precision and false block rate over labelled would_block stops, p95 ms, skips per reason). Excerpts only; nothing else from the store is printed.",
      "--session <id|current>": "One Claude Code session across every project id it wrote under: its receipts, its done-gate stops and whether its transcript was found. current reads CLAUDE_CODE_SESSION_ID, which Claude Code sets for the commands it runs. A CLI receipt carries the session only when the command ran inside Claude Code; CLI receipts written before they carried it have none and are not backfilled. Claude Code's env-vars reference says Bash commands get the same id as the hooks, also after /clear and --resume <id>; it says an MCP server subprocess may keep its startup id after --continue or --resume without an id, and claude-referee runs as a command, not as an MCP server. Every record of the session unless --days is given. Cannot be combined with --stops, --unlabelled, --tokens, --usage or --all.",
      "--unlabelled": "With --stops: only would_block stops without a label.",
      "--label <id>": "Mark one stop with --right (the block would have been correct) or --wrong (a false block).",
      "--right": "With --label: the would-be block was correct. With --label-receipt: the verdict was correct.",
      "--wrong": "With --label: the would-be block was a false block. With --label-receipt: the verdict was wrong.",
      "--show-evidence <id>": "Print the stored, redacted criteria and evidence of one done receipt to this terminal only. Only runs made with REFEREE_KEEP_EVIDENCE=1 have it; records older than 14 days are removed.",
      "--label-receipt <id>": "Label one done receipt with --right or --wrong. Labels are the owner judgment and are kept in receipt-labels.jsonl.",
      "--evidence-stats": "Counts of labelled done receipts by verdict, with right and wrong.",
      "--evidence-queue": "Up to 20 done receipts that have stored evidence and no label, newest first, with id, time, verdict, p, trust and runner names only; --verdict <v> keeps one verdict. Then --show-evidence and --label-receipt.",
      "--verdict <v>": "With --evidence-queue: only receipts with this verdict, for example met.",
      "--project-only": "With verify: only this project's chain.",
      "--all": "Every project instead of the current one.",
      "--days <n>": "How many days back to include; default 30, or 14 with --tokens or --usage. With --stops it limits the listed stops and their stats. With --session it applies only when given.",
    },
    outputs: {
      verdict: "summary, tokens, usage, exported, stops, session, labelled, evidence_queue, chain_ok, chain_broken or overruled",
      chain: "With verify: receipts, chained, unchained and breaks (project, id, kind mismatch, fork or unreadable)",
      dropped: "With overrule: how many cached answers were deleted",
      id: "With overrule or --label: the receipt or stop id",
      receipts: "With export: receipts written. outcome holds numbers and fixed codes only: done's trust, p, exit_code and runner names; decide's lean_p, margin (to the second option) and orders, never the option name; claims' claims, supported, unsupported, contradicted, says_nothing, unsure and unanswered counts and reasons (claims per reason code); judge's items, yes, no and review. A Jev command that failed before its session started (a bad input, a pack or project that does not load, an input that is too large) has no pack, model or outcome; it carries its error code, requests 0 and ms (and fresh with --fresh); a failure after that (a missing or invalid key, a Jev error) has pack and model too",
      out: "With export: the file written, with ~ for home",
      days: "The window in days; with --session only when --days was given",
      project: "With --usage: this project's id",
      calls: "With --usage: CLI calls in the window",
      runs: "Command runs in the window, including runs that failed with an error receipt. With --session: that session's receipts, from every project",
      requests: "Jev requests made",
      cached: "Answers served from the cache or merged with an identical request",
      input_tokens: "Input tokens billed",
      cost_usd: "Estimated cost at list price; a run on a model with no known price records null and adds nothing here",
      by_command: "Runs per command; verify runs (the old name) count as claims",
      by_verdict: "With --session: runs per command and verdict; a run that failed counts under its error code, anything else under other",
      by_project: "With --session: receipts and stops per project id; a session that changed directory, or ran commands in a worktree or scratch folder, writes under several",
      session_id: "With --session: the session id that was read",
      transcript_found: "With --session: whether the session's transcript was found, by its id, in this project's transcript folders or in any other folder of Claude Code's projects directory (the 1,000 most recently changed). Its path is never printed",
      transcript_lines: "With --session: the transcript's line count, or null when it was not found; nothing else from it is printed",
      rows: "With --tokens: one row per day and command. With --usage: day, command, calls, subagent_calls and result_chars",
      transcripts: "With --usage: how many transcript files were read",
      stats: "With --stops or --session: stops, skipped_by_reason, asked, would_block, labelled, right, wrong, precision, false_block_rate, p95_ms (answered calls only), errors, error_rate (Jev errors and breaker skips over asked plus errors), p95_all_ms (answered and failed calls), unlabelled_would_block",
      stops: "With --stops, and with --session for the session's 20 newest stops plus their project: id, ts, skipped, error (the error code when the stop got no answer: a Jev error, a redaction stop, a missing or bad key, a pack that does not load, or internal), configured (active when the project sets a mode that is not built and the stop ran as shadow), edits, checks, turn (a short key shared by the stops of one turn, absent on older records), bg_pending (on every background_tasks skip: how many background tasks were running), bg_types (on such a skip: the count per task type, such as shell or subagent, never a command or description), would_ask (on such a skip: whether the code-side rule would have asked Jev; absent when the transcript could not be read or the turn was too long to analyse), would_block, claims_done, claims_verified, task_excerpt, final_excerpt, label, and for an unlabelled would_block stop whose next prompt in the session transcript (found by the session id, also in another project's transcript folder) reports breakage or repeats the request, suggestion: {label: \"right\", reason: reported_broken or repeated_request, source: next_message}. It is a hint only: computed on read, never stored, never counted in stats or in the threshold suggestion, and the message text is never printed or kept",
      threshold_suggestion: "With --stops: only available (true) with at least 10 human labels of each class on would_block stops (have and need are always shown). Then claims_done is checked with exact Clopper-Pearson 95% intervals: suggested is the smallest value at or above the current one at which the kept labelled stops (at least 10) have a precision lower bound of 0.8 or more, or null if none does; it never suggests lowering the threshold. overall holds the precision and false block rate intervals. Nothing is written; set it in .claude/referee.json yourself",
      label: "With --label: the id and the label that was stored",
      receipt: "With --stops or --session: always a stops-<time> or session-<time> name, used as the details file name when the line passes 1,500 characters; no receipt is written",
    },
    errors: ["bad_input"],
    effects: "Reads the data directory, with --usage this project's Claude Code transcripts, and with --stops or --session the listed sessions' transcripts, looked up by session id (one listing of Claude Code's projects directory per call); export writes one file; --label appends to labels.jsonl.",
    cost: "Free.",
  },
  options: {
    out: { type: "string" },
    tokens: { type: "boolean" },
    usage: { type: "boolean" },
    all: { type: "boolean" },
    "project-only": { type: "boolean" },
    days: { type: "string" },
    stops: { type: "boolean" },
    session: { type: "string" },
    unlabelled: { type: "boolean" },
    label: { type: "string" },
    right: { type: "boolean" },
    wrong: { type: "boolean" },
    "show-evidence": { type: "string" },
    "label-receipt": { type: "string" },
    "evidence-stats": { type: "boolean" },
    "evidence-queue": { type: "boolean" },
    verdict: { type: "string" },
  },
  async run(context) {
    const { io, flags, values, positionals } = context;
    const dataDir = resolveDataDir(io.env, io.home, io.cwd, flags.dataDir);
    const evidenceId = str(context, "show-evidence");
    if (evidenceId !== undefined) {
      const record = readEvidence(dataDir, evidenceId);
      if (!record) throw new RefereeError("bad_input", "No stored evidence for that receipt.", { next_step: "Store it with REFEREE_KEEP_EVIDENCE=1 on the done run; records older than 14 days are removed." });
      return { ok: true, verdict: "evidence", id: record.id, ts: record.ts, criteria: record.criteria, evidence: record.evidence };
    }
    const receiptLabelId = str(context, "label-receipt");
    if (receiptLabelId !== undefined) {
      const label = values["right"] === true ? "right" : values["wrong"] === true ? "wrong" : undefined;
      if (!label) throw new RefereeError("bad_input", "--label-receipt needs --right or --wrong.");
      const done = readReceipts(dataDir).find((r) => r.id === receiptLabelId && r.command === "done");
      if (!done) throw new RefereeError("bad_input", "No done receipt with that id in this data directory.", { next_step: "Use the receipt id printed by done (receipt field)." });
      if (!labelReceipt(dataDir, receiptLabelId, label, new Date(io.now()).toISOString())) throw new RefereeError("internal", "Could not write the label.");
      return { ok: true, verdict: "labelled", id: receiptLabelId, label };
    }
    if (values["evidence-queue"] === true) {
      const wanted = str(context, "verdict");
      const labelled = new Set(readReceiptLabels(dataDir).map((l) => l.id));
      const stored = new Set(listEvidenceIds(dataDir));
      const queue = readReceipts(dataDir)
        .filter((r) => r.command === "done" && stored.has(r.id) && !labelled.has(r.id) && (wanted === undefined || r.verdict === wanted))
        .reverse()
        .slice(0, 20)
        .map((r) => ({ id: r.id, ts: r.ts, verdict: r.verdict, ...(r.outcome?.p !== undefined ? { p: r.outcome.p } : {}), ...(r.outcome?.trust !== undefined ? { trust: r.outcome.trust } : {}), ...(r.outcome?.runners ? { runners: r.outcome.runners } : {}) }));
      return { ok: true, verdict: "evidence_queue", count: queue.length, queue, ...(queue.length === 0 ? { next_step: "Nothing waits for a label. Evidence is stored only for done runs made with REFEREE_KEEP_EVIDENCE=1, for 14 days." } : { next_step: "receipts --show-evidence <id>, then receipts --label-receipt <id> --right or --wrong." }) };
    }
    if (values["evidence-stats"] === true) {
      const verdicts = new Map(readReceipts(dataDir).filter((r) => r.command === "done").map((r) => [r.id, r.verdict ?? "none"]));
      const byVerdict: Record<string, { right: number; wrong: number }> = {};
      for (const l of readReceiptLabels(dataDir)) {
        const v = verdicts.get(l.id);
        if (v === undefined) continue;
        byVerdict[v] ??= { right: 0, wrong: 0 };
        byVerdict[v][l.label] += 1;
      }
      const labelled = Object.values(byVerdict).reduce((n, c) => n + c.right + c.wrong, 0);
      return { ok: true, verdict: "evidence_stats", labelled, by_verdict: byVerdict };
    }
    if (positionals[0] === "export") {
      const out = str(context, "out");
      if (!out) throw new RefereeError("bad_input", "export needs --out <file>.");
      const all = readReceipts(dataDir);
      const path = resolve(io.cwd, out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : ""));
      return { ok: true, verdict: "exported", receipts: all.length, out: tildify(path, io.home) };
    }
    if (positionals[0] === "verify") {
      const chain = verifyChain(dataDir, values["project-only"] === true ? projectId(io.cwd) : undefined);
      return { ok: true, verdict: chain.breaks.length === 0 ? "chain_ok" : "chain_broken", chain };
    }
    if (positionals[0] === "overrule") {
      const id = positionals[1];
      if (!id) throw new RefereeError("bad_input", "overrule needs a receipt id.", { next_step: "Run receipts overrule <id>." });
      const result = overruleReceipt(dataDir, id, new Date(io.now()).toISOString());
      if (!result) throw new RefereeError("bad_input", "No receipt with that id.");
      return { ok: true, verdict: "overruled", id, dropped: result.dropped };
    }
    if (positionals.length > 0) throw new RefereeError("bad_input", `Unknown receipts action: ${positionals[0]}`);
    const labelId = str(context, "label");
    if (labelId !== undefined) {
      const right = values["right"] === true;
      const wrong = values["wrong"] === true;
      if (right === wrong) throw new RefereeError("bad_input", "--label needs exactly one of --right or --wrong.", { next_step: "Run receipts --label <id> --right, or --wrong." });
      const label = right ? "right" : "wrong";
      if (!labelStop(dataDir, labelId, label, new Date(io.now()).toISOString())) {
        throw new RefereeError("bad_input", "No stop with that id.", { next_step: "Run receipts --stops to list the ids." });
      }
      return { ok: true, verdict: "labelled", id: labelId, label };
    }
    const tokens = values["tokens"] === true;
    const usage = values["usage"] === true;
    const days = Number(str(context, "days") ?? (tokens || usage ? 14 : 30));
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new RefereeError("bad_input", "--days must be a whole number from 1 to 366.");
    const since = new Date(io.now() - days * 86_400_000).toISOString();
    if (str(context, "session") !== undefined) return sessionJoin(context, dataDir, str(context, "days") === undefined ? null : since);
    if (values["stops"] === true) {
      const project = projectId(io.cwd);
      const scopedStops = readStops(dataDir).filter((r) => r.project === project && r.ts >= since);
      const picked = newestFirst(values["unlabelled"] === true ? scopedStops.filter((r) => r.decision?.would_block === true && !r.label) : scopedStops).slice(0, STOPS_SHOWN);
      const shown = stopRows(picked, transcriptLocator(projectTranscriptDirs(io.env, io.home, io.cwd), claudeProjectsDir(io.env, io.home)));
      let current = 0.7;
      try {
        const project = loadProject(io.cwd, io.env);
        if (project) current = threshold(loadPack(project.pack, packDirs(io.env)), project.thresholds, "stop.gate", "claims_done", 0.7);
      } catch {
        void 0;
      }
      return { ok: true, verdict: "stops", days, stats: stopStats(scopedStops), threshold_suggestion: suggestThreshold(scopedStops, current), stops: shown, receipt: `stops-${io.now().toString(36)}` };
    }
    if (usage) {
      const { transcripts, rows } = scanUsage(projectTranscriptDirs(io.env, io.home, io.cwd), since);
      return { ok: true, verdict: "usage", days, project: projectId(io.cwd), transcripts, calls: rows.reduce((n, r) => n + r.calls, 0), rows };
    }
    const scoped = readReceipts(dataDir, values["all"] === true ? undefined : projectId(io.cwd)).filter((r) => r.ts >= since);

    if (tokens) {
      const groups = new Map<string, Receipt[]>();
      for (const r of scoped) {
        const key = `${r.ts.slice(0, 10)}|${canonicalCommand(r.command)}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      const rows = [...groups.entries()].sort().map(([key, rs]) => {
        const [day, command] = key.split("|");
        return {
          day,
          command,
          runs: rs.length,
          requests: sum(rs, "requests"),
          cached: sum(rs, "cached"),
          input_tokens: sum(rs, "input_tokens"),
          fresh_share: rs.filter((r) => r.fresh).length / rs.length,
        };
      });
      return { ok: true, verdict: "tokens", days, rows };
    }

    const byCommand: Record<string, number> = {};
    for (const r of scoped) {
      const command = canonicalCommand(r.command);
      byCommand[command] = (byCommand[command] ?? 0) + 1;
    }
    return {
      ok: true,
      verdict: "summary",
      days,
      runs: scoped.length,
      requests: sum(scoped, "requests"),
      cached: sum(scoped, "cached"),
      input_tokens: sum(scoped, "input_tokens"),
      cost_usd: sum(scoped, "cost_usd"),
      by_command: byCommand,
    };
  },
};
