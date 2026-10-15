// Doc statements checked against code and data: supported versions, the release header, what done sends for parsed output (docs and the dashboard Privacy tab), the generic pack's questions and threshold keys.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commands } from "../src/cli/commands/index.ts";
import { run } from "../src/cli/run.ts";
import { loadPack, packDirs } from "../src/engine/pack.ts";
import { memoryIo, tempDir } from "./helpers.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("SECURITY.md supports the current minor line and calls no shipped feature unreleased", () => {
  const version = (JSON.parse(read("package.json")) as { version: string }).version;
  const line = `${version.split(".").slice(0, 2).join(".")}.x`;
  const doc = read("SECURITY.md");
  assert.match(doc, new RegExp(`^\\| ${line.replace(/\./g, "\\.")} \\| Yes \\|$`, "m"));
  assert.doesNotMatch(doc, /unreleased/i);
  assert.doesNotMatch(read("docs/measurements.md"), /v2 \(unreleased\)/);
});

test("the version files, the changelog and the ROADMAP release header and row all name the current version", () => {
  const version = (JSON.parse(read("package.json")) as { version: string }).version;
  for (const path of ["plugins/claude-referee/.claude-plugin/plugin.json", "npm/package.json"]) assert.equal((JSON.parse(read(path)) as { version: string }).version, version, path);
  assert.equal(/^## \[(\d+\.\d+\.\d+)\]/m.exec(read("CHANGELOG.md"))?.[1], version, "first versioned CHANGELOG section");
  const roadmap = read("ROADMAP.md");
  assert.ok(roadmap.includes(`Latest release: v${version} (`), "ROADMAP header names the latest release");
  assert.match(roadmap, new RegExp(`^\\| Release ${version.replace(/\./g, "\\.")} \\|`, "m"));
});

test("configuration.md lists every question of the generic pack and every threshold group and key it ships", () => {
  const pack = loadPack("generic", packDirs({}).filter((d) => d.source === "bundled"));
  const doc = read("docs/configuration.md");
  const sentence = doc.split("\n").find((l) => l.startsWith("The `generic` pack has these")) ?? "";
  const listed = new Set([...sentence.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  const ids = Object.keys(pack.questions);
  assert.equal(ids.length, 13);
  for (const id of ids) assert.ok(listed.has(id), `question ${id} missing from the generic pack sentence`);
  assert.match(sentence, new RegExp(`these ${ids.length} questions`));
  const table = doc.split("\n").filter((l) => l.startsWith("| ") && l.includes("`"));
  for (const [group, keys] of Object.entries(pack.thresholds)) {
    const row = table.find((l) => l.split("|")[1]?.includes(`\`${group}\``));
    assert.ok(row, `threshold group ${group} missing from the keys table`);
    for (const [key, value] of Object.entries(keys)) assert.ok(row.includes(`\`${key}\` (${value})`), `${group}.${key} (${value}) missing from its row`);
  }
});

test("the docs on what done sends for parsed output name the summary and exit-code lines, which carry text", async () => {
  const io = memoryIo({ env: { REFEREE_DATA_DIR: tempDir() }, stdin: "Tests: 12 passed, 12 total NOTE A\nNOTE B on a line of its own\nNOTE C; exit code: 0\n" });
  assert.equal(await run(["done", "--criteria", "all tests pass", "--evidence", "-", "--dry-run", "--pretty"], io, commands), 0);
  const sent = JSON.stringify((io.json() as { sent: unknown }).sent);
  assert.ok(sent.includes("NOTE A") && sent.includes("NOTE C"), "a note on the summary or exit-code line is sent");
  assert.ok(!sent.includes("NOTE B"), "a note on a line of its own is not sent");
  for (const path of ["SECURITY.md", "docs/privacy.md", "docs/recipes/github-action.md", "docs/measurements.md"]) {
    const doc = read(path);
    assert.doesNotMatch(doc, /only (?:the )?counts, (?:the )?exit code and (?:the )?failing test names/, path);
    assert.doesNotMatch(doc, /a note like this never reaches the judge/, path);
    assert.match(doc, /summary (?:line )?and exit-code lines/, path);
  }
  const tab = read("src/ui/api.ts").split("\n").find((l) => l.includes('{ when: "done", what:')) ?? "";
  assert.match(tab, /summary and exit-code lines/, "the dashboard Privacy tab");
});
