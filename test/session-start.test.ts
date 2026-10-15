// SessionStart contract: one JSON object or nothing, at most 800 characters, byte-stable, silent on errors,
// no secrets in CLAUDE_ENV_FILE, and the pipe example in the briefing really runs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveModel } from "../src/engine/config.ts";
import { BRIEFING_LIMIT, sessionStart } from "../src/hooks/session-start.ts";
import { tempDir } from "./helpers.ts";

const pluginRoot = fileURLToPath(new URL("../plugins/claude-referee", import.meta.url));

function project(config: object = { pack: "generic", areas: [{ prefix: "", checks: ["npm test", "npx tsc --noEmit"] }] }): string {
  const root = tempDir();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude/referee.json"), JSON.stringify(config));
  return root;
}

function hookIo(stdin: string, env: Record<string, string> = {}) {
  const home = tempDir("referee-home-");
  return { env: { REFEREE_DATA_DIR: join(home, "data"), ...env }, home, now: () => Date.parse("2026-09-30T12:00:00Z"), readStdin: async () => stdin };
}

const event = (cwd: string) => JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd, session_id: "t" });

test("session-start prints one JSON object with a short briefing in a configured project", async () => {
  const out = await sessionStart(hookIo(event(project())), pluginRoot);
  assert.ok(out);
  const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  const text = parsed.hookSpecificOutput.additionalContext;
  assert.ok(text.length <= BRIEFING_LIMIT, String(text.length));
  assert.ok(text.includes(join(pluginRoot, "dist", "cli.mjs")));
  assert.ok(text.includes("npm test; npx tsc --noEmit"));
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text) && !text.includes("session"));
});

test("session-start is silent outside a project, on bad input and when switched off", async () => {
  assert.equal(await sessionStart(hookIo(event(tempDir())), pluginRoot), null);
  assert.equal(await sessionStart(hookIo("not json"), pluginRoot), null);
  assert.equal(await sessionStart(hookIo(JSON.stringify({})), pluginRoot), null);
  assert.equal(await sessionStart(hookIo(event(project()), { REFEREE_HOOKS: "off" }), pluginRoot), null);
  assert.equal(await sessionStart(hookIo(event(project()), { CLAUDE_PLUGIN_OPTION_HOOKS_ENABLED: "false" }), pluginRoot), null);
  assert.equal(await sessionStart(hookIo(event(project({ pack: "generic", hooks: { sessionStart: false } }))), pluginRoot), null);
});

test("session-start output is byte-identical for the same input", async () => {
  const root = project();
  const a = await sessionStart(hookIo(event(root)), pluginRoot);
  const b = await sessionStart(hookIo(event(root)), pluginRoot);
  assert.equal(a, b);
});

test("session-start exports settings to CLAUDE_ENV_FILE but never the key", async () => {
  const envFile = join(tempDir(), "env.sh");
  writeFileSync(envFile, "");
  await sessionStart(hookIo(event(project()), { CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_OPTION_API_KEY: "ts_secret_key_value" }), pluginRoot);
  const text = readFileSync(envFile, "utf8");
  assert.match(text, /^export REFEREE_DATA_DIR='.+'$/m);
  assert.match(text, /^export REFEREE_PACK='generic'$/m);
  assert.ok(!text.includes("ts_secret_key_value") && !text.includes("API_KEY"));
});

test("session-start briefing's pipe example runs as written", async () => {
  const root = project();
  const out = await sessionStart(hookIo(event(root)), pluginRoot);
  const text = (JSON.parse(out ?? "{}") as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  const line = text.split("\n").find((l) => l.includes(" done --criteria "));
  assert.ok(line);
  const cli = /node "[^"]+"/.exec(text)?.[0];
  assert.ok(cli, "the first line names the CLI once; the pipe line says <same CLI>");
  const command = line
    .slice(line.indexOf("<check>"), line.indexOf(" (whole output"))
    .replace("<check>", "echo 'Tests: 3 passed, 3 total'")
    .replace("<same CLI>", cli)
    .replace("<one claim>", "all tests pass");
  const result = execFileSync("bash", ["-c", `${command} --dry-run`], { cwd: root, encoding: "utf8", env: { ...process.env, REFEREE_DATA_DIR: tempDir() } });
  assert.equal((JSON.parse(result) as { verdict: string }).verdict, "would_send");
});

test("session-start exports the model setting as REFEREE_MODEL, which the CLI then uses", async () => {
  const envFile = join(tempDir(), "env.sh");
  writeFileSync(envFile, "");
  await sessionStart(hookIo(event(project()), { CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_OPTION_MODEL: "jev-9.9.9" }), pluginRoot);
  assert.match(readFileSync(envFile, "utf8"), /^export REFEREE_MODEL='jev-9\.9\.9'$/m);
  const plain = join(tempDir(), "env.sh");
  writeFileSync(plain, "");
  await sessionStart(hookIo(event(project()), { CLAUDE_ENV_FILE: plain }), pluginRoot);
  assert.ok(!readFileSync(plain, "utf8").includes("REFEREE_MODEL"));
  assert.equal(resolveModel({ REFEREE_MODEL: "jev-9.9.9" }), "jev-9.9.9");
  assert.equal(resolveModel({ REFEREE_MODEL: "jev-9.9.9", TYPESAFE_MODEL: "jev-1.0.0" }), "jev-1.0.0");
});

test("session-start treats false, 0, no and off in hooks_enabled as off", async () => {
  for (const value of ["false", "0", "no", "off", "OFF", "False", " off "]) {
    assert.equal(await sessionStart(hookIo(event(project()), { CLAUDE_PLUGIN_OPTION_HOOKS_ENABLED: value }), pluginRoot), null, value);
  }
  assert.ok(await sessionStart(hookIo(event(project()), { CLAUDE_PLUGIN_OPTION_HOOKS_ENABLED: "true" }), pluginRoot));
});

test("session-start still prints the briefing when it can't write the env file or its receipt", async () => {
  const blocker = join(tempDir(), "not-a-dir");
  writeFileSync(blocker, "");
  const out = await sessionStart(hookIo(event(project()), { CLAUDE_ENV_FILE: tempDir(), REFEREE_DATA_DIR: join(blocker, "data") }), pluginRoot);
  assert.ok(out && JSON.parse(out).hookSpecificOutput.additionalContext.length > 0);
});

test("session-start briefing fits in 700 characters with a long installed plugin path", async () => {
  const installed = "/Users/averageusername/.claude/plugins/cache/claude-referee/claude-referee/0.1.1";
  const fourChecks = ["npm run typecheck", "npm test", "npm run lint", "npm run build"];
  for (const config of [undefined, { pack: "generic" }, { pack: "generic", areas: [{ prefix: "", checks: fourChecks }] }]) {
    const out = await sessionStart(hookIo(event(project(config))), installed);
    const text = (JSON.parse(out ?? "{}") as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.ok(text.includes(join(installed, "dist", "cli.mjs")));
    assert.ok(text.endsWith("narrow the question."), "the last line of the cheat sheet is kept");
    assert.ok(text.length <= 700, `${text.length} characters with ${JSON.stringify(config)}`);
  }
});
