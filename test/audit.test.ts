// audit: the Stop gate replayed over whole transcripts (turn classes, next prompt, weak cue), the per-folder tally and the local-only command.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commands } from "../src/cli/commands/index.ts";
import { run } from "../src/cli/run.ts";
import { auditDir, tallySession } from "../src/engine/audit/report.ts";
import { auditTurns } from "../src/engine/audit/turns.ts";
import { analyzeTranscript, promptOffsets } from "../src/engine/stopgate/transcript.ts";
import { memoryIo, tempDir } from "./helpers.ts";

const JEST_PASS = "Tests:       5 passed, 5 total\nTest Suites: 1 passed, 1 total\n";

class T {
  lines: string[] = [];
  private n = 0;
  push(entry: unknown): this {
    this.lines.push(JSON.stringify(entry));
    return this;
  }
  user(text: string, timestamp = ""): this {
    return this.push({ type: "user", isSidechain: false, ...(timestamp ? { timestamp } : {}), message: { role: "user", content: text } });
  }
  say(text: string): this {
    return this.push({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text }] } });
  }
  tool(name: string, input: Record<string, unknown>, content: string): this {
    const id = `toolu_${++this.n}`;
    this.push({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    return this.push({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
  }
  edit(path: string): this {
    return this.tool("Edit", { file_path: path, old_string: "a", new_string: "b" }, "ok");
  }
  test(command: string, output: string): this {
    return this.tool("Bash", { command }, output);
  }
  text(): string {
    return this.lines.join("\n") + "\n";
  }
}

const SESSION = () =>
  new T()
    .user("fix the parser bug", "2026-10-01T10:00:00Z")
    .edit("/a.ts")
    .test("npm test", JEST_PASS)
    .say("fixed, tests pass")
    .user("now rename the helper", "2026-10-01T11:00:00Z")
    .edit("/b.ts")
    .say("renamed it")
    .user("I get the same error", "2026-10-01T12:00:00Z")
    .say("let me look")
    .user("thanks, what does this function do?", "2026-10-01T13:00:00Z")
    .say("it parses")
    .text();

test("each prompt is one turn, classified with the gate's skip rule, and carries the next prompt and the weak cue", () => {
  const turns = auditTurns(SESSION());
  assert.deepEqual(turns.map((t) => t.klass), ["verified", "unverified_no_check", "no_edit", "no_edit"]);
  assert.deepEqual(turns.map((t) => t.ts), ["2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z", "2026-10-01T12:00:00Z", "2026-10-01T13:00:00Z"]);
  assert.equal(turns[0]?.nextPrompt, "now rename the helper");
  assert.equal(turns[1]?.nextPrompt, "I get the same error");
  assert.equal(turns[1]?.cue, "reported_broken");
  assert.equal(turns[0]?.cue, null);
  assert.equal(turns[3]?.nextPrompt, null);
});

test("a turn's facts equal what analyzeTranscript reads from the text up to the next prompt, so audit counts match Stop records", () => {
  const text = SESSION();
  const offsets = promptOffsets(text);
  assert.equal(offsets.length, 4);
  const turns = auditTurns(text, "s1");
  for (const [i, turn] of turns.entries()) assert.deepEqual(turn.facts, analyzeTranscript(text.slice(0, offsets[i + 1]?.lineStart ?? text.length), "s1"));
  assert.deepEqual(turns[1]?.facts.edits, ["/b.ts"]);
});

test("failed or unrecognised checks make an unverified turn that ran checks; tool results and notices are not prompts", () => {
  const text = new T().user("go").edit("/a.ts").test("npm test", "Tests: 1 failed, 4 passed, 5 total\nexit code: 1\n").say("hmm").text();
  assert.deepEqual(auditTurns(text).map((t) => t.klass), ["unverified_ran_checks"]);
  assert.equal(promptOffsets(text).length, 1);
  assert.deepEqual(auditTurns(""), []);
  assert.deepEqual(auditTurns("not json\n{\n"), []);
});

test("tallySession counts classes, the cue per class, subagent calls and the time range, and honours --since", () => {
  const t = tallySession(SESSION());
  assert.deepEqual(t.classes, { no_edit: 2, verified: 1, unverified_ran_checks: 0, unverified_no_check: 1 });
  assert.deepEqual(t.next_prompt.unverified_no_check, { n: 1, cue: 1 });
  assert.deepEqual(t.next_prompt.verified, { n: 1, cue: 0 });
  assert.equal(t.sessions_with_edits, 1);
  assert.equal([t.first, t.last].join(" "), "2026-10-01T10:00:00Z 2026-10-01T13:00:00Z");
  const later = tallySession(SESSION(), "2026-10-01T12:00:00Z");
  assert.equal(later.turns, 2);
  assert.equal(later.classes.verified, 0);
  assert.equal(tallySession(SESSION(), "2027-01-01").sessions, 0);
});

function fixtureRoot(): string {
  const root = tempDir("audit-root-");
  for (const [folder, file, text] of [["-work-alpha", "s1.jsonl", SESSION()], ["-work-alpha", "s2.jsonl", new T().user("go", "2026-10-02T09:00:00Z").edit("/x.ts").test("npm test", JEST_PASS).text()], ["-work-beta", "s3.jsonl", new T().user("hi", "2026-10-03T09:00:00Z").say("hello").text()]] as const) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, file), text);
  }
  mkdirSync(join(root, "-work-alpha", "s1", "subagents"), { recursive: true });
  writeFileSync(join(root, "-work-alpha", "s1", "subagents", "agent-1.jsonl"), new T().user("sub task").edit("/z.ts").text());
  return root;
}

test("auditDir tallies per folder, hashes folder names unless asked, reads no subagent files and skips what it cannot read", () => {
  const root = fixtureRoot();
  const report = auditDir(root);
  assert.equal(report.total.sessions, 3);
  assert.equal(report.total.turns, 6);
  assert.equal(report.folders.length, 2);
  assert.match(report.folders[0]?.folder ?? "", /^[0-9a-f]{12}$/);
  assert.ok(report.folders.every((f) => f.name === undefined));
  assert.equal(report.folders[0]?.classes.verified, 2);
  assert.equal(auditDir(root, { names: true }).folders.map((f) => f.name).sort().join(","), "-work-alpha,-work-beta");
  assert.equal(auditDir(root, { project: "beta" }).total.turns, 1);
  assert.equal(auditDir(root, {}, () => { throw new Error("denied"); }).unreadable, 3);
  assert.equal(auditDir(join(root, "missing")).total.turns, 0);
});

test("audit prints a summary and writes the full table to the data directory, with no message text and without a key", async () => {
  const root = fixtureRoot();
  const data = tempDir("audit-data-");
  const io = memoryIo({ env: { TYPESAFE_API_KEY: undefined } });
  assert.equal(await run(["audit", "--dir", root, "--data-dir", data], io, commands), 0);
  const out = io.json();
  assert.equal(out["verdict"], "report");
  assert.deepEqual([out["turns"], out["edit_turns"], out["verified"], out["unverified_no_check"]], [6, 3, 2, 1]);
  assert.equal(out["unverified_share"], 0.33);
  const file = out["report"] as string;
  assert.ok(existsSync(file) && file.startsWith(data));
  const everything = io.out.join("") + readFileSync(file, "utf8");
  for (const text of ["fix the parser bug", "same error", "renamed it", "alpha", "beta"]) assert.ok(!everything.includes(text), `${text} leaked`);
  assert.deepEqual(out["next_prompt_after_unverified"], { n: 1, weak_cue: 1 });
});

test("audit rejects a bad --since and an empty directory with a next step", async () => {
  const bad = memoryIo();
  assert.equal(await run(["audit", "--dir", fixtureRoot(), "--since", "last week"], bad, commands), 1);
  assert.equal(bad.json()["error"], "bad_input");
  const empty = memoryIo();
  assert.equal(await run(["audit", "--dir", tempDir("audit-empty-"), "--data-dir", tempDir()], empty, commands), 1);
  assert.match(String(empty.json()["next_step"]), /--dir|--project/);
});
