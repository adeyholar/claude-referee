// docs/decisions/done-run.md: `done --run` runs only a detected check, judges all of its output like piped evidence, exits 3 unless met, and the Stop gate reads the call as a check.
// Projects are invented temp folders with package.json scripts; the fake Jev answers 0.9.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { posixTest } from "./posix-test.ts";
import { commands } from "../src/cli/commands/index.ts";
import { run } from "../src/cli/run.ts";
import { detectCheckSet } from "../src/engine/detect-checks.ts";
import { pickCheck, runCheck } from "../src/engine/run-check.ts";
import { analyzeTranscript } from "../src/engine/stopgate/transcript.ts";
import { fakeJev } from "./fake-jev.ts";
import { memoryIo, tempDir } from "./helpers.ts";

function project(scripts: Record<string, string>): string {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", scripts }));
  return dir;
}

async function doneRun(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: Record<string, unknown> }> {
  const fake = await fakeJev();
  try {
    const home = tempDir();
    const io = memoryIo({ cwd, home, platform: "linux", env: { HOME: home, PATH: process.env["PATH"], TYPESAFE_BASE_URL: fake.url, REFEREE_BASE_URL_KEY: "test-key", ...env } });
    const code = await run(["done", ...args], io, commands);
    return { code, out: JSON.parse(io.out.join("").trim().split("\n").at(-1) ?? "{}") as Record<string, unknown> };
  } finally {
    await fake.close();
  }
}

test("B1: a family and an exact command resolve; anything else, an unlisted family and an unsafe script name do not", () => {
  const dir = project({ test: "x", lint: "x", "typecheck:ci": "x", "deploy:prod": "x", "test:$(touch pwned)": "x", "build;rm": "x" });
  const set = detectCheckSet(dir, dir);
  assert.deepEqual(set?.checks.map((c) => c.family), ["test", "typecheck", "lint"]);
  assert.equal(pickCheck("test", set).command, "npm run test");
  assert.equal(pickCheck("npm run typecheck:ci", set).family, "typecheck");
  for (const spec of ["deploy", "npm run deploy:prod", "rm -rf /", "test; touch pwned", "build", ""]) assert.throws(() => pickCheck(spec, set), (e: Error & { code?: string }) => e.code === "bad_input", spec);
  assert.throws(() => pickCheck("test", null), /No check was detected/);
  const quoted = tempDir();
  mkdirSync(join(quoted, "my app"));
  writeFileSync(join(quoted, "my app", "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  assert.throws(() => pickCheck("test", detectCheckSet(quoted, quoted)), /not "test"|--run takes/);
});

posixTest("B1: a refused command runs nothing", async () => {
  const dir = project({ test: "node -e \"require('fs').writeFileSync('ran.txt','x')\"" });
  const { code, out } = await doneRun(dir, ["--run", "touch pwned.txt"]);
  assert.deepEqual([code, out["error"]], [1, "bad_input"]);
  assert.equal(existsSync(join(dir, "pwned.txt")) || existsSync(join(dir, "ran.txt")), false);
});

posixTest("B2/B3: a passing check is judged, can be met, and exits 0; the receipt has run true and no command", async () => {
  const dir = project({ test: "node -e \"console.log('Tests: 3 passed, 3 total')\"" });
  const { code, out } = await doneRun(dir, ["--run", "test"]);
  assert.deepEqual([code, out["verdict"], out["run"], out["ran"], out["trust"]], [0, "met", true, "npm run test", "parsed"]);
  assert.equal(out["requests"], 1);
});

posixTest("B2/B3: a failing check is missing without asking Jev and exits 3; an explicit --fail-on wins", async () => {
  const dir = project({ test: "node -e \"console.log('Tests: 1 failed, 2 passed, 3 total'); process.exit(1)\"" });
  const failed = await doneRun(dir, ["--run", "test"]);
  assert.deepEqual([failed.code, failed.out["verdict"], failed.out["reason"], failed.out["requests"], failed.out["exit_code"]], [3, "missing", "exit_code_nonzero", 0, 1]);
  const explicit = await doneRun(dir, ["--run", "test", "--fail-on", "unsure"]);
  assert.equal(explicit.code, 0);
});

posixTest("B2: a timeout reports exit code 124 and nothing is met", async () => {
  const dir = project({ test: "node -e \"setTimeout(() => {}, 20000)\"" });
  const started = Date.now();
  const { code, out } = await doneRun(dir, ["--run", "test", "--timeout", "1"]);
  assert.ok(Date.now() - started < 10_000, "the check was killed, not waited for");
  assert.deepEqual([code, out["verdict"], out["exit_code"]], [3, "missing", 124]);
});

posixTest("B2: stderr and stdout keep their order, and the TypeSafe key variables stay out of the check", async () => {
  const ordered = await runCheck("node -e \"console.log('one'); console.error('two'); console.log('three'); console.error('four')\"", tempDir(), { PATH: process.env["PATH"] }, 10_000);
  assert.deepEqual([ordered.output, ordered.code, ordered.timedOut], ["one\ntwo\nthree\nfour\n", 0, false]);
  const dir = project({ lint: "node -e \"require('fs').writeFileSync('env.txt', String(process.env.TYPESAFE_API_KEY) + '|' + String(process.env.REFEREE_BASE_URL_KEY) + '|' + String(process.env.KEEP_ME))\"" });
  await doneRun(dir, ["--run", "lint"], { TYPESAFE_API_KEY: "tsk-secret", REFEREE_BASE_URL_KEY: "test-key", KEEP_ME: "yes" });
  assert.equal(readFileSync(join(dir, "env.txt"), "utf8"), "undefined|undefined|yes");
});

posixTest("the criteria default by family and an explicit --criteria is used as given", async () => {
  const dir = project({ lint: "node -e \"console.log('ok')\"" });
  const dry = async (args: string[]) => JSON.stringify((await doneRun(dir, [...args, "--dry-run"])).out);
  assert.match(await dry(["--run", "lint"]), /lint is clean/);
  assert.match(await dry(["--run", "lint", "--criteria", "the linter prints ok"]), /the linter prints ok/);
});

test("B2: --run with --evidence, a bad --timeout and Windows are refused", async () => {
  const dir = project({ test: "x" });
  assert.equal((await doneRun(dir, ["--run", "test", "--evidence", "-"])).out["error"], "bad_input");
  assert.equal((await doneRun(dir, ["--run", "test", "--timeout", "0"])).out["error"], "bad_input");
  assert.equal((await doneRun(dir, ["--run", "test", "--timeout", "9999"])).out["error"], "bad_input");
  const home = tempDir();
  const io = memoryIo({ cwd: dir, home, platform: "win32", env: { HOME: home } });
  assert.equal(await run(["done", "--run", "test"], io, commands), 1);
  assert.match(io.out.join(""), /not available on Windows/);
});

function turn(command: string, out: string, error = false) {
  const lines: unknown[] = [
    { type: "user", message: { role: "user", content: "fix it" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "e0", name: "Edit", input: { file_path: "/p/a.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e0", content: "ok" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b0", name: "Bash", input: { command } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b0", content: out, is_error: error }] } },
  ];
  return analyzeTranscript(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("B4: the Stop gate reads a done --run call as a check: met passes, a failed call does not, and a plain done call is not one", () => {
  const met = '{"ok":true,"verdict":"met","p":0.97,"trust":"parsed","run":true,"ran":"npm run test","requests":1}';
  const missing = '{"ok":true,"verdict":"missing","p":0.1,"run":true,"ran":"npm run test","requests":1}';
  for (const command of ['claude-referee done --run test', 'node "/x/dist/cli.mjs" done --run test', 'cd app && claude-referee done --run lint --timeout 60']) {
    assert.equal(turn(command, met).passedCheckAfterLastEdit, true, command);
    assert.equal(turn(command, missing, true).passedCheckAfterLastEdit, false, `${command} (exit 3)`);
  }
  assert.equal(turn("claude-referee done --run test", missing).passedCheckAfterLastEdit, false, "a not-met verdict with exit 0 (explicit --fail-on) is not a pass");
  assert.equal(turn('npm test 2>&1 | claude-referee done --criteria "all tests pass" --evidence -', met).checks.length, 1, "the piped check is the check, as before");
  assert.equal(turn('claude-referee done --criteria "x" --evidence -', met).checks.length, 0);
  assert.equal(turn("node --test test/cli.mjs", "ℹ pass 1\nℹ fail 0\n").checks.length, 1, "node --test stays a test run");
});
