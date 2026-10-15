// detectChecks and the briefing: script names only, nearest manifest, at most 4, byte-stable, silent on bad files.

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectChecks } from "../src/engine/detect-checks.ts";
import { BRIEFING_LIMIT, sessionStart } from "../src/hooks/session-start.ts";
import { tempDir } from "./helpers.ts";

const pluginRoot = fileURLToPath(new URL("../plugins/claude-referee", import.meta.url));

function repo(files: Record<string, string | object>, config: object = { pack: "generic" }): string {
  const root = tempDir();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude/referee.json"), JSON.stringify(config));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

function detect(files: Record<string, string | object>): string[] {
  const root = repo(files);
  return detectChecks(root, root);
}

async function briefing(cwd: string, plugin = pluginRoot): Promise<string> {
  const io = { env: {}, home: tempDir("referee-home-"), now: () => Date.parse("2026-10-09T12:00:00Z"), readStdin: async () => JSON.stringify({ cwd, session_id: "t" }) };
  const out = await sessionStart({ ...io, env: { REFEREE_DATA_DIR: join(io.home, "data") } }, plugin);
  return (JSON.parse(out ?? "{}") as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

test("package.json scripts are listed in family order with the lockfile's runner", () => {
  const scripts = { build: "x", lint: "x", test: "x", dev: "x" };
  assert.deepEqual(detect({ "package.json": { scripts } }), ["npm run test", "npm run lint", "npm run build"]);
  const pnpm = repo({ "package.json": { scripts }, "pnpm-lock.yaml": "" });
  assert.deepEqual(detectChecks(pnpm, pnpm), ["pnpm run test", "pnpm run lint", "pnpm run build"]);
});

test("composer scripts and artisan give composer and php artisan test", () => {
  assert.deepEqual(detect({ "composer.json": { scripts: { test: "x", lint: "x" } } }), ["composer test", "composer lint"]);
  const laravel = repo({ artisan: "", "composer.json": { require: { "laravel/framework": "^12" } }, "package.json": { scripts: { build: "x" } } });
  assert.deepEqual(detectChecks(laravel, laravel), ["php artisan test", "npm run build"]);
});

test("cargo and go manifests give their test command", () => {
  assert.deepEqual(detect({ "Cargo.toml": "" }), ["cargo test"]);
  assert.deepEqual(detect({ "go.mod": "" }), ["go test ./..."]);
});

test("one command per family, at most 4, suffixed scripts only when the plain name is missing", () => {
  const scripts = { "test:unit": "x", "test:e2e": "x", typecheck: "x", lint: "x", check: "x", build: "x", ci: "x" };
  assert.deepEqual(detect({ "package.json": { scripts } }), ["npm run test:e2e", "npm run typecheck", "npm run lint", "npm run check"]);
});

test("no manifest, no matching scripts or an unparsable package.json give nothing and do not throw", () => {
  assert.deepEqual(detect({}), []);
  assert.deepEqual(detect({ "package.json": { scripts: { dev: "x" } } }), []);
  assert.deepEqual(detect({ "package.json": "{ not json" }), []);
  assert.deepEqual(detect({ "package.json": '{"scripts": ["test"]}' }), []);
});

test("the nearest manifest from the working directory wins", () => {
  const root = repo({ "package.json": { scripts: { test: "x" } }, "web/package.json": { scripts: { lint: "x" } } });
  assert.deepEqual(detectChecks(join(root, "web"), root), ["npm run lint"]);
  assert.deepEqual(detectChecks(join(root, "web/deeper"), root), ["npm run lint"]);
});

test("the briefing says detected, is byte-stable and keeps explicit area checks untouched", async () => {
  const root = repo({ "package.json": { scripts: { test: "x", build: "x" } } });
  const text = await briefing(root);
  assert.ok(text.includes("Checks here: npm run test; npm run build (detected)."));
  assert.equal(text, await briefing(root));
  const explicit = repo({ "package.json": { scripts: { test: "x" } } }, { pack: "generic", areas: [{ prefix: "", checks: ["make verify"] }] });
  const explicitText = await briefing(explicit);
  assert.ok(explicitText.includes("Checks here: make verify.") && !explicitText.includes("detected"));
  assert.ok((await briefing(repo({}))).includes("Checks here: none listed in .claude/referee.json."));
});

test("the briefing with long detected checks and a long plugin path stays within the 800 limit and keeps its last line", async () => {
  const installed = "/Users/averageusername/.claude/plugins/cache/claude-referee/claude-referee/0.1.1";
  const root = repo({ "package.json": { scripts: { "test:integration": "x", typecheck: "x", lint: "x", check: "x" } }, "pnpm-lock.yaml": "" });
  const text = await briefing(root, installed);
  assert.ok(text.length <= BRIEFING_LIMIT, String(text.length));
  assert.ok(text.includes("pnpm run test:integration; pnpm run typecheck; pnpm run lint; pnpm run check (detected)."));
  assert.ok(text.endsWith("narrow the question."));
});

test("with no manifest from the working directory to the root, exactly one subdirectory with checks is listed with a cd prefix", () => {
  const one = repo({ "server/composer.json": { scripts: { test: "x", lint: "x" } }, "docs/readme.md": "" });
  assert.deepEqual(detectChecks(one, one), ["cd server && composer test", "cd server && composer lint"]);
  const spaced = repo({ "my app/package.json": { scripts: { test: "x" } } });
  assert.deepEqual(detectChecks(spaced, spaced), ['cd "my app" && npm run test']);
});

test("several subdirectories with checks, none, skipped directories and a root that has a manifest give the old behaviour", () => {
  const two = repo({ "a/package.json": { scripts: { test: "x" } }, "b/package.json": { scripts: { test: "x" } } });
  assert.deepEqual(detectChecks(two, two), []);
  assert.deepEqual(detect({ "a/readme.md": "" }), []);
  const skipped = repo({ "node_modules/p/package.json": { scripts: { test: "x" } }, "vendor/v/composer.json": { scripts: { test: "x" } }, ".hidden/package.json": { scripts: { test: "x" } } });
  assert.deepEqual(detectChecks(skipped, skipped), []);
  const rooted = repo({ "package.json": { scripts: { build: "x" } }, "web/package.json": { scripts: { test: "x" } } });
  assert.deepEqual(detectChecks(rooted, rooted), ["npm run build"]);
});

test("the briefing lists the single subdirectory's checks", async () => {
  const root = repo({ "server/package.json": { scripts: { test: "x" } } });
  assert.ok((await briefing(root)).includes("Checks here: cd server && npm run test (detected)."));
});

test("the briefing asks for done --run after edits, once, then the pipe form, then the checks line, and stays within 700 characters", async () => {
  const installed = "/Users/averageusername/.claude/plugins/cache/claude-referee/claude-referee/0.1.1";
  const nudge = "After edits, before saying done: node";
  for (const files of [{}, { "package.json": { scripts: { "test:integration": "x", "typecheck:strict": "x", "lint:all": "x", "check:all": "x" } }, "pnpm-lock.yaml": "" }]) {
    const text = await briefing(repo(files), installed);
    assert.equal(text.split(nudge).length - 1, 1);
    assert.ok(text.indexOf(nudge) < text.indexOf(" done --criteria ") && text.indexOf(" done --run ") < text.indexOf(" done --criteria ") && text.indexOf(" done --criteria ") < text.indexOf("Checks here"));
    assert.ok(text.length <= 700 && text.endsWith("narrow the question."), String(text.length));
  }
});

test("a broken symlink next to the one subdirectory with checks does not hide it", () => {
  const root = repo({ "server/package.json": { scripts: { test: "x" } } });
  symlinkSync(join(root, "does-not-exist"), join(root, "dangling"));
  assert.deepEqual(detectChecks(root, root), ["cd server && npm run test"]);
});
