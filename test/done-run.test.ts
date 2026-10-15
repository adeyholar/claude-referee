// docs/decisions/done-run.md: `done --run` runs only a detected check, judges all of its output like piped evidence, exits 3 unless met, and the Stop gate reads the call as a check.
// Projects are invented temp folders with package.json scripts; the fake Jev answers 0.9.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { posixTest } from "./posix-test.ts";
import { commands } from "../src/cli/commands/index.ts";
import { run } from "../src/cli/run.ts";
import { detectCheckSet } from "../src/engine/detect-checks.ts";
import { KEY_VARIABLES, pickCheck, runCheck } from "../src/engine/run-check.ts";
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

test("review: every key-like variable is stripped from the check, including the plugin setting, and nothing else", () => {
  for (const name of ["TYPESAFE_API_KEY", "TYPESAFE_API_KEY_CMD", "EVAL_TYPESAFE_API_KEY", "REFEREE_BASE_URL_KEY", "CLAUDE_PLUGIN_OPTION_API_KEY", "CLAUDE_PLUGIN_OPTION_SOME_TOKEN"]) assert.equal(KEY_VARIABLES.test(name), true, name);
  for (const name of ["PATH", "HOME", "TYPESAFE_MODEL", "TYPESAFE_BASE_URL", "CLAUDE_PLUGIN_OPTION_MODEL", "CLAUDE_PLUGIN_OPTION_PACKS_DIR", "KEEP_ME"]) assert.equal(KEY_VARIABLES.test(name), false, name);
});

posixTest("review: the plugin API key reaches no check, and the others stay", async () => {
  const out = await runCheck("env | grep -E 'API_KEY|KEEP_ME' | sort", tempDir(), { PATH: process.env["PATH"], CLAUDE_PLUGIN_OPTION_API_KEY: "plugin-secret", TYPESAFE_API_KEY: "s1", KEEP_ME: "yes" }, 10_000);
  assert.equal(out.output, "KEEP_ME=yes\n");
});

posixTest("review: the exit code comes from the shell, so a check that leaves a background child behind returns at once with its own code", async () => {
  const started = Date.now();
  const result = await runCheck("sleep 6 & echo hi", tempDir(), { PATH: process.env["PATH"] }, 600_000);
  assert.ok(Date.now() - started < 4000, `returned in ${Date.now() - started} ms, not after the child`);
  assert.deepEqual([result.output, result.code, result.timedOut], ["hi\n", 0, false]);
});

posixTest("review: a timeout resolves even when a descendant escaped the process group", async () => {
  const started = Date.now();
  const result = await runCheck("perl -MPOSIX -e 'POSIX::setsid(); exec \"sleep\", \"7\"' & echo hi; sleep 30", tempDir(), { PATH: process.env["PATH"] }, 1000);
  assert.ok(Date.now() - started < 6000, `resolved in ${Date.now() - started} ms`);
  assert.deepEqual([result.timedOut, result.code], [true, 124]);
});

posixTest("review: stopping the CLI stops the check it started", async () => {
  const dir = tempDir();
  const script = join(dir, "go.ts");
  writeFileSync(script, `import { runCheck } from ${JSON.stringify(new URL("../src/engine/run-check.ts", import.meta.url).href)};\nawait runCheck("sleep 1234", ${JSON.stringify(dir)}, { PATH: process.env.PATH }, 600000);\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], { stdio: "ignore", env });
  const alive = (): boolean => { try { execFileSync("pgrep", ["-f", "sleep 1234"], { stdio: "ignore" }); return true; } catch { return false; } };
  for (let i = 0; i < 40 && !alive(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), true, "the check started");
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));
  for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), false, "the check died with the CLI");
});

posixTest("review: the criteria count is checked before the check runs", async () => {
  const dir = project({ test: "node -e \"require('fs').writeFileSync('ran.txt','x')\"" });
  const eleven = Array.from({ length: 11 }, (_, i) => ["--criteria", `claim ${i}`]).flat();
  const { out } = await doneRun(dir, ["--run", "test", ...eleven]);
  assert.equal(out["error"], "bad_input");
  assert.equal(existsSync(join(dir, "ran.txt")), false, "nothing ran");
});

posixTest("review: the check's own exit code outvotes a stray phrase in its output", async () => {
  const dir = project({ test: "node -e \"console.log('Tests: 3 passed, 3 total'); console.log('helper exited with exit code 1 (expected)')\"" });
  const { out } = await doneRun(dir, ["--run", "test"]);
  assert.deepEqual([out["verdict"], out["exit_code"], out["requests"]], ["met", 0, 1]);
});

test("review: a subfolder named like a cd option is not runnable, and without a project the subfolder fallback is off", () => {
  for (const name of ["-P", "--", "-L"]) {
    const root = tempDir();
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    assert.equal(detectCheckSet(root, root)?.checks[0]?.runnable, false, name);
  }
  const root = tempDir();
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app", "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  assert.equal(detectCheckSet(root, root)?.checks[0]?.command, "cd app && npm run test");
  assert.equal(detectCheckSet(root, root, { subdir: false }), null);
});

test("review: the Stop gate does not count a not-met run next to another call, or a look-alike command", () => {
  const met = '{"ok":true,"verdict":"met","run":true}';
  const missing = '{"ok":true,"verdict":"missing","run":true}';
  const passes = (command: string, out: string): boolean => turn(command, out).passedCheckAfterLastEdit;
  assert.equal(passes("claude-referee done --run lint; claude-referee done --run test || true", `${met}\n${missing}`), false);
  assert.equal(passes("claude-referee done --run lint; claude-referee done --run test", `${met}\n${met}`), true);
  assert.equal(passes("claude-referee done --run lint; claude-referee done --run test || true", met), false, "one verdict for two run segments is unknown, not a pass");
  assert.equal(passes("claude-referee done --run lint; npm test", `${missing}\nTests: 3 passed, 3 total`), false);
  assert.equal(passes("claude-referee claims --claim done --run x", met), false, "only the done subcommand counts");
  assert.equal(turn("claude-referee done --run lint --criteria 'secret client wording'", met).checks[0]?.cmd, "claude-referee done --run", "the criteria text never reaches the gate's check list");
});
