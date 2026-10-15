// The four usage measures of scripts/usage-report.mjs (docs/decisions/usage-report.md), on invented receipts, stops and labels.

import assert from "node:assert/strict";
import { test } from "node:test";
import { measures } from "../scripts/usage-report.mjs";

const T = (min: number): string => new Date(Date.parse("2026-10-09T12:00:00Z") + min * 60_000).toISOString();
const since = Date.parse("2026-10-09T11:00:00Z");

test("edit turns with a counted check count turns, not stops, and respect the window", () => {
  const stops = [
    { ts: T(0), turn: "a", edits: 2, checks: 0 },
    { ts: T(1), turn: "a", edits: 2, checks: 1 },
    { ts: T(2), turn: "b", edits: 1, checks: 0 },
    { ts: T(3), turn: "c", edits: 0, checks: 3 },
    { ts: T(4) },
    { ts: "2026-10-01T00:00:00Z", turn: "old", edits: 4, checks: 0 },
  ];
  assert.deepEqual(measures({ receipts: [], stops, labels: [], since }).edit_turns_with_check, { k: 1, n: 2, share: 0.5 });
  assert.deepEqual(measures({ receipts: [], stops: [], labels: [], since }).edit_turns_with_check, { k: 0, n: 0, share: null });
});

test("a re-ask is the next decide of the session within 10 minutes of a non-clear one", () => {
  const d = (id: string, min: number, verdict: string, session = "s1") => ({ id, ts: T(min), command: "decide", verdict, session_id: session });
  const receipts = [d("1", 0, "weak"), d("2", 5, "clear"), d("3", 30, "tie"), d("4", 50, "weak"), d("5", 55, "weak"), d("6", 56, "clear"), d("7", 0, "weak", "s2"), d("8", 1, "clear", "s3")];
  assert.deepEqual(measures({ receipts, stops: [], labels: [], since }).reask_cleared, { k: 2, n: 3, share: 0.667 });
});

test("exit-code-only missing counts by evidence size, and labels join the receipt's verdict", () => {
  const done = (id: string, verdict: string, outcome: { trust?: string; evidence_lines?: number }) => ({ id, ts: T(1), command: "done", verdict, outcome });
  const receipts = [
    done("a", "missing", { trust: "exit_code", evidence_lines: 2 }),
    done("b", "missing", { trust: "exit_code", evidence_lines: 40 }),
    done("c", "missing", { trust: "exit_code" }),
    done("d", "missing", { trust: "parsed" }),
    done("e", "met", { trust: "parsed" }),
    done("f", "met", { trust: "exit_code" }),
  ];
  const labels = [{ id: "e", label: "right" as const }, { id: "f", label: "wrong" as const }, { id: "zzz", label: "right" as const }];
  const m = measures({ receipts, stops: [], labels, since });
  assert.deepEqual(m.exit_only_missing, { k: 3, n: 4, share: 0.75, evidence_lines_under_5: 1, evidence_lines_5_or_more: 1, evidence_lines_unknown: 1 });
  assert.deepEqual(m.labels, { met: { right: 1, wrong: 1 } });
});

test("the output holds counts only: ids, criteria and session ids never appear", () => {
  const receipts = [{ id: "secret-id", ts: T(0), command: "decide", verdict: "weak", session_id: "secret-session" }];
  const text = JSON.stringify(measures({ receipts, stops: [{ ts: T(0), turn: "secret-turn", edits: 1, checks: 0 }], labels: [{ id: "secret-id", label: "right" }], since }));
  assert.doesNotMatch(text, /secret/);
});

test("excluded sessions drop their receipts and stops from every measure; receipts without a session id stay in the ones that need no session", () => {
  const d = (id: string, min: number, verdict: string, session?: string) => ({ id, ts: T(min), command: "decide", verdict, ...(session ? { session_id: session } : {}) });
  const done = (id: string, session?: string) => ({ id, ts: T(2), command: "done", verdict: "missing", outcome: { trust: "exit_code" }, ...(session ? { session_id: session } : {}) });
  const receipts = [d("1", 0, "weak", "mine"), d("2", 1, "clear", "mine"), d("3", 0, "weak", "other"), d("4", 1, "weak", "other"), done("5", "mine"), done("6", "other"), done("7")];
  const stops = [
    { ts: T(0), session_id: "mine", turn: "m1", edits: 1, checks: 1 },
    { ts: T(1), session_id: "other", turn: "o1", edits: 1, checks: 0 },
  ];
  const all = measures({ receipts, stops, labels: [], since });
  assert.deepEqual([all.reask_cleared, all.edit_turns_with_check, all.exit_only_missing.k], [{ k: 1, n: 2, share: 0.5 }, { k: 1, n: 2, share: 0.5 }, 3]);
  const clean = measures({ receipts, stops, labels: [], since, excludeSessions: ["mine"] });
  assert.deepEqual([clean.reask_cleared, clean.edit_turns_with_check, clean.exit_only_missing.k], [{ k: 0, n: 1, share: 0 }, { k: 0, n: 1, share: 0 }, 2]);
});

test("a pack exclusion drops every session that wrote a receipt under that pack, counted once, and --until closes the window", () => {
  const d = (id: string, min: number, verdict: string, session: string, pack = "generic") => ({ id, ts: T(min), command: "decide", verdict, session_id: session, pack });
  const receipts = [d("1", 0, "weak", "work"), d("2", 1, "clear", "work"), d("3", 0, "weak", "gate"), d("4", 1, "weak", "gate"), { id: "5", ts: T(2), command: "judge", session_id: "gate", pack: "voice" }, d("6", 3, "weak", "work"), d("7", 4, "clear", "work")];
  const stops = [{ ts: T(0), session_id: "gate", turn: "g1", edits: 1, checks: 0 }, { ts: T(0), session_id: "work", turn: "w1", edits: 1, checks: 1 }];
  const all = measures({ receipts, stops, labels: [], since });
  assert.deepEqual([all.reask_cleared, all.edit_turns_with_check, all.excluded_by_pack], [{ k: 2, n: 3, share: 0.667 }, { k: 1, n: 2, share: 0.5 }, 0]);
  const clean = measures({ receipts, stops, labels: [], since, excludePacks: ["voice"] });
  assert.deepEqual([clean.reask_cleared, clean.edit_turns_with_check, clean.excluded_by_pack], [{ k: 2, n: 2, share: 1 }, { k: 1, n: 1, share: 1 }, 1]);
  assert.deepEqual(measures({ receipts, stops, labels: [], since, until: Date.parse(T(2)), excludePacks: ["voice"] }).reask_cleared, { k: 1, n: 1, share: 1 });
});

test("done calls split by whether the CLI ran the check (outcome.run) or the evidence was piped, as met over all done receipts", () => {
  const done = (id: string, verdict: string, run?: boolean) => ({ id, ts: T(1), command: "done", verdict, outcome: { trust: "parsed", ...(run ? { run } : {}) } });
  const receipts = [done("1", "met", true), done("2", "missing", true), done("3", "met", true), done("4", "met"), done("5", "missing"), done("6", "unsure")];
  assert.deepEqual(measures({ receipts, stops: [], labels: [], since }).done_met_by_run, { run: { k: 2, n: 3, share: 0.667 }, piped: { k: 1, n: 3, share: 0.333 } });
});
