// --describe drift: every top-level key a command prints is named in its describe.outputs or the shared outputs_common,
// and the calls below print every key of each command's own outputs at least once, so a path the test stops reaching fails it.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { posixTest as test } from "./posix-test.ts";
import { commands } from "../src/cli/commands/index.ts";
import { GLOBAL_OPTIONS, run } from "../src/cli/run.ts";
import { projectId } from "../src/engine/datadir.ts";
import { appendStop } from "../src/engine/stopgate/stops.ts";
import { defaultAnswer, fakeJev, type FakeRequest } from "./fake-jev.ts";
import { FAKE, memoryIo, tempDir } from "./helpers.ts";

const REPO = new URL("..", import.meta.url).pathname;
const EVALS = join(REPO, "jev-evals");
const GENERIC = join(REPO, "plugins", "claude-referee", "packs", "generic");

async function contract(name: string): Promise<{ all: Set<string>; own: string[] }> {
  const io = memoryIo();
  assert.equal(await run([name, "--describe"], io, commands), 0);
  const d = io.json() as { outputs: object; outputs_common: object };
  return { all: new Set([...Object.keys(d.outputs), ...Object.keys(d.outputs_common)]), own: Object.keys(d.outputs) };
}

const answer = (request: FakeRequest): Record<string, unknown> => {
  const state = JSON.stringify(request.state);
  if (state.includes("REVIEW-ME")) return Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.5 }]));
  const out = defaultAnswer(request);
  for (const id of Object.keys(request.questions)) {
    const choice = (p: Record<string, number>) => ({ type: "choice", choice: "x", confidence: 0.9, probabilities: p });
    if (/^claim:c:/.test(id)) out[id] = choice({ supports: 0.05, contradicts: 0.9, says_nothing: 0.05 });
    if (/^claim:s:/.test(id)) out[id] = choice({ supports: 0.05, contradicts: 0.05, says_nothing: 0.9 });
    if (/^claim:none:/.test(id)) delete out[id];
  }
  return out;
};

test("every key a command prints is named in its --describe contract", async () => {
  const server = await fakeJev(answer, {
    behave: (r) => {
      const state = JSON.stringify(r.state);
      return state.includes("FAIL-ME") ? { status: 400 } : state.includes("RATE-ME") ? { status: 429, retryAfter: "600" } : undefined;
    },
  });
  const dataDir = tempDir();
  const cwd = tempDir();
  const home = tempDir();
  const keyed = { TYPESAFE_API_KEY: "ts_test", REFEREE_BASE_URL_KEY: "ts_test", TYPESAFE_BASE_URL: server.url, REFEREE_DATA_DIR: dataDir };
  const seen = new Map<string, Set<string>>();
  const problems: string[] = [];
  const allowed = new Map<string, Set<string>>();
  const own = new Map<string, string[]>();
  for (const c of commands) {
    const { all, own: keys } = await contract(c.name);
    allowed.set(c.name, all);
    own.set(c.name, keys);
  }

  const check = (name: string, label: string, lines: string[]) => {
    const ok = allowed.get(name) ?? new Set<string>();
    const got = seen.get(name) ?? new Set<string>();
    seen.set(name, got);
    for (const line of lines.join("").split("\n").filter((l) => l.trim())) {
      for (const key of Object.keys(JSON.parse(line) as object)) {
        got.add(key);
        if (!ok.has(key)) problems.push(`${label}: ${key}`);
      }
    }
  };
  const call = async (argv: string[], options: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}) => {
    const io = memoryIo({ env: options.env ?? keyed, stdin: options.stdin ?? "", cwd: options.cwd ?? cwd, home });
    await run(argv, io, commands);
    check(argv[0] ?? "", argv.join(" ").slice(0, 80), io.out);
  };

  try {
    const done = ["done", "--criteria", "all tests pass", "--evidence", "-"];
    await call(done, { stdin: "Tests: 12 passed, 12 total\n" });
    await call([...done, "--criteria", "lint is clean"], { stdin: "Tests: 12 passed, 12 total\nexit code: 0\n" });
    await call(done, { stdin: "=== 11 passed, 2 skipped in 1.00s ===\nexit code: 0\n" });
    await call(done, { stdin: "npm test\nexit code: 1\n" });
    await call([...done, "--dry-run"], { stdin: "npm test\nexit code: 1\n" });
    await call([...done, "--dry-run"], { stdin: "Tests: 12 passed, 12 total\n" });
    await call(done, { stdin: "Tests: 12 passed, 12 total\n", env: { REFEREE_DATA_DIR: dataDir } });
    await call(done, { stdin: "RATE-ME, no runner summary\n" });

    writeFileSync(join(cwd, "ctx.md"), "Redis is already deployed.\n");
    const decision = JSON.stringify({ decision: "Where do counters live?", options: [{ name: "redis", text: "Redis" }, { name: "memory", text: "In-process LRU" }], context_files: ["ctx.md"], micro: [{ id: "risky", question: "Is it risky?", bad: true }] });
    await call(["decide"], { stdin: decision });
    await call(["decide", "--dry-run"], { stdin: decision });
    const wide = JSON.stringify({ decision: "Pick one", options: [{ name: "a", text: `A ${"lorem ipsum ".repeat(5_000)}` }, { name: "b", text: `B ${"lorem ipsum ".repeat(5_000)}` }] });
    await call(["decide"], { stdin: wide });

    const items = ["const a = 1", "rm -rf / REVIEW-ME", `token ${FAKE.github}`, "FAIL-ME now"].join("\n");
    await call(["judge", "--question", "line.risky", "--items", "-"], { stdin: items });
    const baseline = join(cwd, "baseline.json");
    await call(["judge", "--question", "line.risky", "--items", "-", "--baseline", baseline, "--baseline-write"], { stdin: "const a = 1\n" });
    await call(["judge", "--question", "line.risky", "--items", "-", "--baseline", baseline, "--baseline-write"], { stdin: "const b = 2\n" });
    await call(["judge", "--question", "line.risky", "--items", "-", "--baseline", baseline], { stdin: "const c = 3\n" });
    const long = Array.from({ length: 25 }, (_, i) => JSON.stringify({ id: `item-${String(i).padStart(2, "0")}-${"x".repeat(80)}`, text: `line ${i}` })).join("\n");
    await call(["judge", "--question", "line.risky", "--items", "-"], { stdin: long });

    const src = join(cwd, "src");
    mkdirSync(src);
    writeFileSync(join(src, "App.tsx"), "export const App = () => <button>Save changes</button>;\n");
    writeFileSync(join(src, "Huge.tsx"), `export const x = "${"x".repeat(1_100_000)}";\n`);
    await call(["extract", "src", "nope"]);
    await call(["extract", "src", "--out", "items.jsonl"]);

    const claims = ["claims", "--source", "-", "--claims", join(cwd, "claims.jsonl")];
    writeFileSync(
      join(cwd, "claims.jsonl"),
      [
        { id: "q", text: 'The README says "never writes files"' },
        { id: "n", text: "The CLI prints 7 lines." },
        { id: "c", text: "The CLI prints two lines." },
        { id: "s", text: "The CLI is fast." },
        { id: "none", text: "The CLI is free." },
        { id: "ok", text: "The CLI prints one JSON line." },
      ]
        .map((c) => JSON.stringify(c))
        .join("\n"),
    );
    await call(claims, { stdin: "The CLI prints one JSON line.\n" });
    await call(["verify", "--source", "-", "--claim", "The CLI prints one JSON line."], { stdin: "The CLI prints one JSON line.\n" });
    await call(["verify", ...claims.slice(1)], { stdin: "The CLI prints one JSON line.\n" });

    const project = projectId(cwd);
    const stop = { ts: "2026-09-30T10:00:00.000Z", session_id: "s", project, mode: "shadow" as const, edits: 1, checks: 0, ms: 5 };
    appendStop(dataDir, { ...stop, id: "s1", skipped: "jev_error", error: "service_unavailable" });
    appendStop(dataDir, { ...stop, id: "s2", configured: "active", decision: { claims_done: 0.9, claims_verified: 0.1, verification_applies: 1, outcome: {}, would_block: true } });
    const local = { REFEREE_DATA_DIR: dataDir };
    await call(done, { stdin: "Tests: 12 passed, 12 total\n", env: { ...keyed, CLAUDE_CODE_SESSION_ID: "s" } });
    mkdirSync(join(home, ".claude", "projects", "-elsewhere"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-elsewhere", "s.jsonl"), "{}\n");
    const transcripts = join(cwd, "transcripts", "-fixture");
    mkdirSync(join(transcripts, "bad.jsonl"), { recursive: true });
    const turn = (message: unknown, extra: object = {}) => JSON.stringify({ isSidechain: false, ...extra, message });
    writeFileSync(
      join(transcripts, "s.jsonl"),
      [
        turn({ role: "user", content: "go" }, { type: "user", timestamp: "2026-10-01T10:00:00Z" }),
        turn({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a.ts" } }] }, { type: "assistant" }),
        turn({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, { type: "user" }),
        turn({ role: "user", content: "ok" }, { type: "user", timestamp: "2026-10-01T11:00:00Z" }),
      ].join("\n") + "\n",
    );
    await call(["audit", "--dir", join(cwd, "transcripts"), "--data-dir", join(dataDir, "audit")], { env: local });
    await call(["audit", "--since", "never"], { env: local });
    await call(["audit", "--compare", "2026-10-02", "--dir", join(cwd, "transcripts"), "--data-dir", join(dataDir, "audit")], { env: local });
    await call(["audit", "--ask", "--project", "fixture", "--dir", join(cwd, "transcripts"), "--data-dir", join(dataDir, "audit")]);
    await call(["audit", "--ask", "--project", "fixture", "--dir", join(cwd, "transcripts"), "--dry-run"]);
    await call(["audit", "--ask", "--dir", join(cwd, "transcripts")]);
    writeFileSync(join(cwd, "terms.txt"), "# nothing here matches\nzzz-no-match\n");
    await call(["audit", "--ask", "--project", "fixture", "--dir", join(cwd, "transcripts"), "--skip", join(cwd, "terms.txt"), "--data-dir", join(dataDir, "audit")]);
    await call(["receipts"], { env: local });
    await call(["receipts", "--tokens"], { env: local });
    await call(["receipts", "--usage"], { env: local });
    await call(["receipts", "--stops"], { env: local });
    await call(["receipts", "--session", "s"], { env: local });
    await call(["receipts", "--session", "current"], { env: local });
    await call(["receipts", "--label", "s2", "--right"], { env: local });
    await call(["receipts", "export", "--out", join(cwd, "r.jsonl")], { env: local });
    await call(["receipts", "verify"], { env: local });
    const listed = memoryIo({ env: local, cwd, home });
    await run(["receipts", "export", "--out", join(cwd, "r2.jsonl")], listed, commands);
    const firstId = (JSON.parse(readFileSync(join(cwd, "r2.jsonl"), "utf8").split("\n")[0] ?? "{}") as { id: string }).id;
    await call(["receipts", "overrule", firstId], { env: local });

    await call(["doctor"], { env: local });
    await call(["doctor", "--online"]);
    const gated = tempDir();
    mkdirSync(join(gated, ".claude"));
    writeFileSync(join(gated, ".claude", "referee.json"), JSON.stringify({ pack: "generic", hooks: { stopGate: "active" } }));
    await call(["doctor"], { env: local, cwd: gated });
    const broken = tempDir();
    mkdirSync(join(broken, ".claude"));
    writeFileSync(join(broken, ".claude", "referee.json"), JSON.stringify({ pack: "no-such-pack" }));
    await call(["doctor"], { env: local, cwd: broken });

    await call(["eval", "score", "--suite", "all", "--evals-dir", EVALS], { env: local });
    await call(["eval", "score", "--suite", "done-v2", "--evals-dir", EVALS, "--split", "holdout", "--sweep", "0.5:0.9:0.1"], { env: local });
    await call(["eval", "score", "--suite", "decide-best", "--evals-dir", EVALS, "--ablation", "reversed"], { env: local });
    const evals = tempDir();
    mkdirSync(join(evals, "s1"));
    writeFileSync(join(evals, "s1", "suite.json"), JSON.stringify({ command: "done", criteria: "all tests pass", max_wrong_negative: 5 }));
    const cases = [
      { id: "pass", split: "holdout", expected: "met", evidence: "Tests: 12 passed, 12 total\n" },
      { id: "fail", split: "holdout", expected: "missing", evidence: "FAIL-ME: no runner summary\n" },
    ];
    writeFileSync(join(evals, "s1", "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
    mkdirSync(join(evals, "d1"));
    writeFileSync(join(evals, "d1", "suite.json"), JSON.stringify({ command: "decide" }));
    writeFileSync(join(evals, "d1", "cases.jsonl"), JSON.stringify({ id: "d", split: "dev", expected: "a", decision: "Pick one", options: [{ name: "a", text: "A" }, { name: "b", text: "B" }, { name: "c", text: "C" }] }) + "\n");
    await call(["eval", "record", "--suite", "d1", "--evals-dir", evals, "--dry-run"]);
    await call(["eval", "record", "--suite", "d1", "--evals-dir", evals]);
    const d1 = join(evals, "d1", "recorded.jsonl");
    const older = readFileSync(d1, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { also?: unknown[] }).map((l) => ({ ...l, also: l.also?.slice(0, 1) }));
    writeFileSync(d1, older.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await call(["eval", "record", "--suite", "d1", "--evals-dir", evals]);
    await call(["eval", "record", "--suite", "s1", "--evals-dir", evals, "--dry-run"]);
    await call(["eval", "record", "--suite", "s1", "--evals-dir", evals]);
    writeFileSync(join(evals, "s1", "cases.jsonl"), cases.slice(0, 1).map((c) => JSON.stringify(c)).join("\n") + "\n");
    await call(["eval", "score", "--suite", "s1", "--evals-dir", evals], { env: local });
    await call(["eval", "score", "--suite", "s1", "--evals-dir", evals, "--sweep", "0.5:0.9:0.1"], { env: local });

    await call(["lint-pack", GENERIC], { env: local });
    await call(["lint-pack", GENERIC, "--recorded", EVALS], { env: local });

    const ui = memoryIo({ env: local, cwd, home });
    const running = run(["ui", "--no-open", "--port", "0"], ui, commands);
    for (let i = 0; i < 200 && ui.out.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    process.emit("SIGTERM");
    assert.equal(await running, 0);
    check("ui", "ui", ui.out);
  } finally {
    await server.close();
  }

  assert.deepEqual(problems, [], "keys printed but missing from --describe outputs and outputs_common");
  for (const [name, keys] of own) {
    const unseen = keys.filter((key) => !seen.get(name)?.has(key));
    assert.deepEqual(unseen, [], `${name} never printed these keys of its own outputs; the drift test no longer covers those paths`);
  }
  const sharedSeen: Record<string, string[]> = {
    done: ["dry_run", "sent", "est_tokens", "replaced", "error", "message", "status", "retry_after_ms", "next_step", "receipt", "requests", "cached"],
    judge: ["details"],
  };
  for (const [name, keys] of Object.entries(sharedSeen)) {
    for (const key of keys) assert.ok(seen.get(name)?.has(key), `${name} never printed the shared key ${key}; the drift test no longer covers that path`);
  }
});

test("--verbose and every other global flag are in the shared contract and in --help", async () => {
  const io = memoryIo();
  await run(["done", "--describe"], io, commands);
  const flags = Object.keys((io.json() as { flags: object }).flags);
  for (const key of Object.keys(GLOBAL_OPTIONS).filter((k) => k !== "describe")) {
    assert.ok(flags.some((f) => f === `--${key}` || f.startsWith(`--${key} `)), `--${key} missing from SHARED_CONTRACT.flags`);
  }
  const help = memoryIo();
  await run(["--help"], help, commands);
  for (const key of Object.keys(GLOBAL_OPTIONS)) assert.match(help.out.join(""), new RegExp(`--${key}\\b`), `--${key} missing from --help`);
});
