// Every command answers --describe with valid JSON and a complete contract, without a key or network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { commands } from "../src/cli/commands/index.ts";
import { run } from "../src/cli/run.ts";
import { memoryIo } from "./helpers.ts";

test("describe works for every command without a key", async () => {
  assert.deepEqual(commands.map((c) => c.name), ["done", "decide", "judge", "extract", "claims", "verify", "receipts", "doctor", "eval", "lint-pack", "ui"]);
  for (const command of commands) {
    const io = memoryIo();
    assert.equal(await run([command.name, "--describe"], io, commands), 0, command.name);
    const out = io.json();
    assert.equal(out["command"], command.name);
    for (const key of ["summary", "inputs", "outputs", "errors", "effects", "cost"]) assert.ok(key in out, `${command.name}.${key}`);
    assert.ok(JSON.stringify(out["flags"]).includes("--fail-on"), `${command.name} flags`);
    assert.deepEqual(Object.keys(out["exit_codes"] as object), ["0", "1", "3"]);
  }
});

test("help lists every command and --version prints the version", async () => {
  const help = memoryIo();
  await run(["--help"], help, commands);
  for (const command of commands) assert.match(help.out.join(""), new RegExp(`\\b${command.name}\\b`));
  const version = memoryIo();
  await run(["--version"], version, commands);
  assert.equal(version.out.join("").trim(), "0.2.8");
});
