// Maintainer report of the four usage measures from the local data directory (docs/decisions/usage-report.md). Counts only, no text.
// Usage: node scripts/usage-report.mjs [--days 7] [--since 2026-10-09T12:00:00Z] [--until <ISO time>] [--data-dir <dir>] [--exclude-session <id|current>]... [--exclude-pack <name>]...
// --exclude-session leaves out the receipts and stops of a session (your own development session), `current` reads CLAUDE_CODE_SESSION_ID.
// --exclude-pack leaves out every session that wrote a receipt under that pack (a workflow such as a reply gate, not coding use); the output counts both exclusions.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REASK_MS = 10 * 60_000;
const share = (k, n) => ({ k, n, share: n === 0 ? null : Number((k / n).toFixed(3)) });

export function measures({ receipts, stops, labels, since, until = Infinity, excludeSessions = [], excludePacks = [] }) {
  const byPack = new Set(receipts.filter((r) => r.session_id && r.pack !== undefined && excludePacks.includes(r.pack)).map((r) => r.session_id));
  const out = new Set([...excludeSessions, ...byPack]);
  const at = (r) => Date.parse(r.ts) >= since && Date.parse(r.ts) < until && !(r.session_id !== undefined && out.has(r.session_id));
  const turns = new Map();
  for (const s of stops.filter((x) => x.turn && at(x))) {
    const t = turns.get(s.turn) ?? { edits: 0, checks: 0 };
    turns.set(s.turn, { edits: Math.max(t.edits, s.edits ?? 0), checks: Math.max(t.checks, s.checks ?? 0) });
  }
  const edited = [...turns.values()].filter((t) => t.edits > 0);
  const bySession = new Map();
  for (const r of receipts.filter((x) => x.command === "decide" && x.session_id && x.verdict && at(x))) bySession.set(r.session_id, [...(bySession.get(r.session_id) ?? []), r]);
  let reasks = 0;
  let cleared = 0;
  for (const list of bySession.values()) {
    list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    list.forEach((r, i) => {
      const next = list[i + 1];
      if (!next || r.verdict === "clear" || Date.parse(next.ts) - Date.parse(r.ts) > REASK_MS) return;
      reasks++;
      if (next.verdict === "clear") cleared++;
    });
  }
  const done = receipts.filter((r) => r.command === "done" && at(r));
  const exitOnly = done.filter((r) => r.verdict === "missing" && r.outcome?.trust === "exit_code");
  const lines = (r) => r.outcome?.evidence_lines;
  const metOf = (rs) => share(rs.filter((r) => r.verdict === "met").length, rs.length);
  const verdicts = new Map(receipts.filter((r) => r.command === "done").map((r) => [r.id, r.verdict ?? "none"]));
  const byVerdict = {};
  for (const l of labels) {
    const v = verdicts.get(l.id);
    if (v === undefined) continue;
    byVerdict[v] ??= { right: 0, wrong: 0 };
    byVerdict[v][l.label] += 1;
  }
  return {
    edit_turns_with_check: share(edited.filter((t) => t.checks > 0).length, edited.length),
    reask_cleared: share(cleared, reasks),
    exit_only_missing: {
      ...share(exitOnly.length, done.filter((r) => r.verdict === "missing").length),
      evidence_lines_under_5: exitOnly.filter((r) => lines(r) !== undefined && lines(r) < 5).length,
      evidence_lines_5_or_more: exitOnly.filter((r) => lines(r) !== undefined && lines(r) >= 5).length,
      evidence_lines_unknown: exitOnly.filter((r) => lines(r) === undefined).length,
    },
    labels: byVerdict,
    done_met_by_run: { run: metOf(done.filter((r) => r.verdict !== undefined && r.outcome?.run === true)), piped: metOf(done.filter((r) => r.verdict !== undefined && r.outcome?.run !== true)) },
    excluded_by_pack: byPack.size,
  };
}

const jsonl = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } }) : []);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const dir = arg("--data-dir", process.env.REFEREE_DATA_DIR ?? join(homedir(), ".claude/plugins/data/claude-referee-claude-referee"));
  const since = arg("--since") ? Date.parse(arg("--since")) : Date.now() - Number(arg("--days", 7)) * 86_400_000;
  if (!Number.isFinite(since)) throw new Error("--since is not a time");
  const until = arg("--until") ? Date.parse(arg("--until")) : Infinity;
  if (Number.isNaN(until)) throw new Error("--until is not a time");
  const flags = process.argv.flatMap((a, i, all) => (a === "--exclude-session" ? [all[i + 1]] : []));
  const excludePacks = process.argv.flatMap((a, i, all) => (a === "--exclude-pack" && all[i + 1] ? [all[i + 1]] : []));
  const excludeSessions = flags.flatMap((id) => (id === "current" ? [process.env.CLAUDE_CODE_SESSION_ID ?? ""] : id ? [id] : [])).filter(Boolean);
  const { readReceipts } = await import("../src/engine/receipts.ts");
  console.log(JSON.stringify({ data_dir: "(local)", since: new Date(since).toISOString(), ...(Number.isFinite(until) ? { until: new Date(until).toISOString() } : {}), ...measures({ receipts: readReceipts(dir), stops: jsonl(join(dir, "stops.jsonl")), labels: jsonl(join(dir, "receipt-labels.jsonl")), since, until, excludeSessions, excludePacks }), excluded_sessions: excludeSessions.length }));
}
