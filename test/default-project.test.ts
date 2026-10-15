// docs/decisions/default-project.md: REFEREE_DEFAULT_PROJECT=shadow|soft gives every git repository the generic pack, the briefing and a stop-gate mode when it has no project file; a file always wins; anything else is off.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { commands } from "../src/cli/commands/index.ts";
import { run } from "../src/cli/run.ts";
import { loadProject } from "../src/engine/project.ts";
import { sessionStart } from "../src/hooks/session-start.ts";
import { memoryIo, tempDir } from "./helpers.ts";

const pluginRoot = fileURLToPath(new URL("../plugins/claude-referee", import.meta.url));

function repo(): string {
  const root = tempDir();
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "app", "src"), { recursive: true });
  return root;
}

test("the default applies only in a git repository, with a valid mode, and only without a file", () => {
  const root = repo();
  const inside = join(root, "app", "src");
  assert.equal(loadProject(inside), null, "off by default");
  const shadow = loadProject(inside, { REFEREE_DEFAULT_PROJECT: "shadow" });
  assert.deepEqual([shadow?.root, shadow?.pack, shadow?.hooks.stopGate, shadow?.hooks.sessionStart, shadow?.hooks.preModelSwitch], [root, "generic", "shadow", true, false]);
  assert.equal(loadProject(inside, { REFEREE_DEFAULT_PROJECT: " Soft " })?.hooks.stopGate, "soft");
  for (const value of ["", "active", "on", "off", "1"]) assert.equal(loadProject(inside, { REFEREE_DEFAULT_PROJECT: value }), null, value);
  assert.equal(loadProject(tempDir(), { REFEREE_DEFAULT_PROJECT: "shadow" }), null, "no .git above: nothing is turned on");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "referee.json"), JSON.stringify({ pack: "generic", hooks: { stopGate: "off" } }));
  assert.equal(loadProject(inside, { REFEREE_DEFAULT_PROJECT: "shadow" })?.hooks.stopGate, "off", "a project file wins over the default");
});

test("the session briefing runs in a default project and nowhere else", async () => {
  const root = repo();
  const io = (cwd: string, env: Record<string, string>) => ({ env: { REFEREE_DATA_DIR: join(tempDir(), "data"), ...env }, home: tempDir(), now: () => Date.parse("2026-09-30T12:00:00Z"), readStdin: async () => JSON.stringify({ hook_event_name: "SessionStart", cwd, session_id: "t" }) });
  assert.equal(await sessionStart(io(root, {}), pluginRoot), null);
  assert.ok(await sessionStart(io(root, { REFEREE_DEFAULT_PROJECT: "shadow" }), pluginRoot));
  assert.equal(await sessionStart(io(tempDir(), { REFEREE_DEFAULT_PROJECT: "shadow" }), pluginRoot), null);
});

test("doctor names the default", async () => {
  const root = repo();
  const home = tempDir();
  const io = memoryIo({ cwd: root, home, env: { HOME: home, REFEREE_DEFAULT_PROJECT: "shadow", TYPESAFE_API_KEY: "tsk-test" } });
  await run(["doctor"], io, commands);
  const out = io.json();
  assert.deepEqual([out["project"], out["stop_gate"]], ["(default: shadow)", "shadow"]);
});
