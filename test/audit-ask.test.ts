// audit --ask: the registered study's statistics, its request plan, its evaluation bars and the command against a fake Jev.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commands } from "../src/cli/commands/index.ts";
import { run } from "../src/cli/run.ts";
import { evaluateAsk, parseTerms, planAsk, withoutTerms, type AskTurn } from "../src/engine/audit/ask.ts";
import { auroc, fisherOneSided } from "../src/engine/audit/stats.ts";
import { loadPack, packDirs } from "../src/engine/pack.ts";
import type { Outcome } from "../src/engine/session.ts";
import { fakeJev, defaultAnswer, type FakeRequest } from "./fake-jev.ts";
import { FAKE, memoryIo, tempDir } from "./helpers.ts";

const pack = loadPack("generic", packDirs({}).filter((d) => d.source === "bundled"));

test("fisherOneSided matches a hand-computed table and degrades to 1 on empty margins; auroc counts ties half", () => {
  assert.ok(Math.abs(fisherOneSided(3, 1, 1, 3) - 17 / 70) < 1e-12);
  assert.ok(Math.abs(fisherOneSided(4, 0, 0, 4) - 1 / 70) < 1e-12);
  assert.ok(Math.abs(fisherOneSided(0, 5, 5, 0) - 1) < 1e-9);
  assert.equal(fisherOneSided(0, 0, 3, 3), 1);
  assert.equal(auroc([0.9, 0.8], [0.1, 0.2]), 1);
  assert.equal(auroc([0.1], [0.9]), 0);
  assert.equal(auroc([0.5], [0.5]), 0.5);
  assert.equal(auroc([], [0.5]), null);
});

const turn = (i: number, klass: "verified" | "unverified_no_check", next = "ok"): AskTurn => ({
  folder: "abc123abc123",
  session: `s${i}`,
  turn: {
    index: i,
    ts: "2026-10-01T10:00:00Z",
    klass,
    prompt: "do it",
    nextPrompt: next,
    cue: null,
    facts: { task: "the task", finalMessage: "all done", edits: ["/a.ts"], checks: [], passedCheckAfterLastEdit: klass === "verified", marks: { truncatedChecks: 0, subagentCalls: 0, subagentReports: 0, stalePass: false } },
  },
});

test("planAsk sends the gate's questions for unverified turns only, as the hook would, and the pushback question for every turn, with caps", () => {
  const turns = [turn(0, "verified"), turn(1, "unverified_no_check", "x".repeat(2000))];
  const planned = planAsk(turns, pack);
  assert.deepEqual(planned.map((p) => p.id), ["p0", "s1", "p1"]);
  assert.deepEqual(Object.keys(planned[1]?.questions ?? {}), ["claims_done", "claims_verified", "verification_applies", "outcome"]);
  assert.deepEqual(Object.keys(planned[0]?.questions ?? {}), ["pushback"]);
  assert.equal((planned[2]?.state as { next_prompt: string }).next_prompt.length, 600);
  assert.deepEqual(Object.keys(planned[0]?.state as object), ["previous_message", "next_prompt"]);
});

const stopAnswers = (done: number, verified: number) => ({
  claims_done: { type: "noul", noul: done },
  claims_verified: { type: "noul", noul: verified },
  verification_applies: { type: "noul", noul: 0.9 },
  outcome: { type: "choice", choice: "complete", confidence: 0.9, probabilities: { complete: 0.9, partial: 0.05, blocked: 0.02, other: 0.03 } },
});
const outcome = (id: string, answers: Record<string, unknown> | null, error?: "timeout"): Outcome => ({ id, answers: answers as Outcome["answers"], stopped: [], cached: false, ...(error ? { error } : {}) });

// n turns flagged by the gate with `flaggedPush` pushbacks, n turns not flagged with `restPush` pushbacks
function study(n: number, flaggedPush: number, restPush: number) {
  const turns: AskTurn[] = [];
  const outcomes: Outcome[] = [];
  for (let i = 0; i < 2 * n; i++) {
    const flagged = i < n;
    turns.push(turn(i, "unverified_no_check"));
    outcomes.push(outcome(`s${i}`, stopAnswers(flagged ? 0.95 : 0.2, 0.1)));
    const push = flagged ? i < flaggedPush : i - n < restPush;
    outcomes.push(outcome(`p${i}`, { pushback: { type: "noul", noul: push ? 0.97 : 0.02 } }));
  }
  return evaluateAsk(turns, outcomes, pack, undefined);
}

test("evaluateAsk applies the registered bars: power first, then ratio and Fisher p", () => {
  const strong = study(20, 12, 3);
  assert.equal(strong.would_block, 20);
  assert.equal(strong.pushback.yes, 15);
  assert.equal(strong.enough_data, true);
  assert.equal(strong.gate.ratio, 4);
  assert.ok((strong.gate.fisher_p ?? 1) < 0.01);
  assert.equal(strong.verdict, "signal");
  assert.ok((strong.auroc ?? 0) > 0.5);
  assert.equal(study(20, 8, 7).verdict, "no_signal");
  const small = study(5, 4, 0);
  assert.equal(small.enough_data, false);
  assert.equal(small.verdict, "not_evaluable");
});

test("evaluateAsk reads the bands, skips unanswered requests and never calls a verified turn blocked", () => {
  const turns = [turn(0, "verified"), turn(1, "unverified_no_check"), turn(2, "unverified_no_check"), turn(3, "unverified_no_check")];
  const outcomes = [
    outcome("p0", { pushback: { type: "noul", noul: 0.5 } }),
    outcome("s1", stopAnswers(0.95, 0.1)),
    outcome("p1", { pushback: { type: "noul", noul: 0.95 } }),
    outcome("s2", null, "timeout"),
    outcome("p2", { pushback: { type: "noul", noul: 0.04 } }),
    outcome("s3", stopAnswers(0.95, 0.1)),
  ];
  const r = evaluateAsk(turns, outcomes, pack, undefined);
  assert.deepEqual(r.rows.map((x) => x.label), ["review", "yes", "no", "none"]);
  assert.deepEqual(r.rows.map((x) => x.would_block), [false, true, null, true]);
  assert.equal(r.unanswered, 1);
  assert.deepEqual(r.pushback, { yes: 1, no: 1, review: 1 });
  assert.equal(r.verdict, "not_evaluable");
});

function fixtureRoot(next: string): string {
  const root = tempDir("audit-ask-");
  const dir = join(root, "-work-alpha");
  mkdirSync(dir, { recursive: true });
  const line = (message: unknown, extra: object) => JSON.stringify({ isSidechain: false, ...extra, message });
  writeFileSync(
    join(dir, "s1.jsonl"),
    [
      line({ role: "user", content: "fix the parser" }, { type: "user", timestamp: "2026-10-01T10:00:00Z" }),
      line({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a.ts" } }] }, { type: "assistant" }),
      line({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, { type: "user" }),
      line({ role: "assistant", content: [{ type: "text", text: "Fixed the parser." }] }, { type: "assistant" }),
      line({ role: "user", content: next }, { type: "user", timestamp: "2026-10-01T11:00:00Z" }),
    ].join("\n") + "\n",
  );
  return root;
}

test("audit --ask sends redacted excerpts of the scoped turns, writes rows without text, and --dry-run sends nothing", async () => {
  const server = await fakeJev((request: FakeRequest) => {
    const out = defaultAnswer(request);
    if ("claims_verified" in request.questions) out["claims_verified"] = { type: "noul", noul: 0.1 };
    if ("pushback" in request.questions) out["pushback"] = { type: "noul", noul: JSON.stringify(request.state).includes("same error") ? 0.97 : 0.02 };
    return out;
  });
  try {
    const root = fixtureRoot("I get the same error");
    const data = tempDir("audit-ask-data-");
    const env = { TYPESAFE_API_KEY: "ts_test", REFEREE_BASE_URL_KEY: "ts_test", TYPESAFE_BASE_URL: server.url, REFEREE_DATA_DIR: data };
    const dry = memoryIo({ env });
    assert.equal(await run(["audit", "--ask", "--project", "alpha", "--dir", root, "--dry-run"], dry, commands), 0);
    assert.equal(server.requests.length, 0);
    assert.equal(dry.json()["dry_run"], true);
    const io = memoryIo({ env });
    assert.equal(await run(["audit", "--ask", "--project", "alpha", "--dir", root, "--data-dir", data], io, commands), 0);
    const out = io.json();
    assert.equal(out["verdict"], "not_evaluable");
    assert.deepEqual([out["population"], out["would_block"]], [1, 1]);
    assert.deepEqual(out["pushback"], { yes: 1, no: 0, review: 0 });
    assert.equal(server.requests.length, 2);
    const rows = JSON.parse(readFileSync(out["rows"] as string, "utf8")) as { rows: Record<string, unknown>[] };
    assert.equal(rows.rows.length, 1);
    assert.deepEqual([rows.rows[0]?.["klass"], rows.rows[0]?.["label"], rows.rows[0]?.["would_block"]], ["unverified_no_check", "yes", true]);
    const text = readFileSync(out["rows"] as string, "utf8");
    for (const secret of ["fix the parser", "same error", "Fixed the parser"]) assert.ok(!text.includes(secret), `${secret} leaked into rows`);
  } finally {
    await server.close();
  }
});

test("audit --ask needs a --project scope, and a credential in a prompt is stopped before sending", async () => {
  const noScope = memoryIo();
  assert.equal(await run(["audit", "--ask", "--dir", fixtureRoot("ok")], noScope, commands), 1);
  assert.equal(noScope.json()["error"], "bad_input");
  const server = await fakeJev();
  try {
    const data = tempDir("audit-ask-data-");
    const env = { TYPESAFE_API_KEY: "ts_test", REFEREE_BASE_URL_KEY: "ts_test", TYPESAFE_BASE_URL: server.url, REFEREE_DATA_DIR: data };
    const io = memoryIo({ env });
    await run(["audit", "--ask", "--project", "alpha", "--dir", fixtureRoot(`it broke, token ${FAKE.github}`), "--data-dir", data], io, commands);
    const sent = JSON.stringify(server.requests);
    assert.ok(!sent.includes(FAKE.github), "the credential reached the API");
    assert.ok(!sent.includes("it broke"), "the stopped prompt reached the API");
  } finally {
    await server.close();
  }
});

test("a skip file drops every turn whose sent text matches, names only the line of a bad pattern, and the command sends nothing for dropped turns", async () => {
  const terms = parseTerms("# private terms\n\nsecret-project\n  parser  \n");
  assert.equal(terms.length, 2);
  const turns = [turn(0, "unverified_no_check"), turn(1, "unverified_no_check", "see the Secret-Project notes")];
  assert.deepEqual(withoutTerms(turns, terms), { kept: [turns[0]], skipped: 1 });
  assert.equal(withoutTerms(turns, []).skipped, 0);
  assert.throws(() => parseTerms("fine\n(broken"), (e: Error) => /Line 2/.test(e.message) && !e.message.includes("broken"));

  const server = await fakeJev();
  try {
    const data = tempDir("audit-ask-data-");
    const env = { TYPESAFE_API_KEY: "ts_test", REFEREE_BASE_URL_KEY: "ts_test", TYPESAFE_BASE_URL: server.url, REFEREE_DATA_DIR: data };
    const skip = join(tempDir(), "terms.txt");
    writeFileSync(skip, "# one term\nparser\n");
    const io = memoryIo({ env });
    assert.equal(await run(["audit", "--ask", "--project", "alpha", "--dir", fixtureRoot("ok"), "--skip", skip, "--data-dir", data], io, commands), 1);
    assert.equal(io.json()["error"], "bad_input");
    assert.equal(server.requests.length, 0);
    writeFileSync(skip, "nothing-matches-this\n");
    const kept = memoryIo({ env });
    assert.equal(await run(["audit", "--ask", "--project", "alpha", "--dir", fixtureRoot("ok"), "--skip", skip, "--data-dir", data], kept, commands), 0);
    assert.equal(kept.json()["skipped"], 0);
    const missing = memoryIo({ env });
    assert.equal(await run(["audit", "--ask", "--project", "alpha", "--dir", fixtureRoot("ok"), "--skip", join(data, "absent.txt")], missing, commands), 1);
  } finally {
    await server.close();
  }
});
