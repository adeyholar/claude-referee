// docs/decisions/lint-cap-tool-names.md: a criterion naming a linter is under the warning cap, the oxlint parser (shapes from real oxlint 1.87 runs), and criterion_not_covered.
// Every line below is invented to mirror the real shapes (oxlint default, terminal, github, agent, unix and stylish formats; stylelint, markdownlint, vite, flutter); no real log text is committed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { doneEvidence, doneRequest } from "../src/cli/commands/done.ts";
import { loadPack, packDirs } from "../src/engine/pack.ts";
import { parsers as builds } from "../src/engine/runners/builds.ts";
import { parsers as bun } from "../src/engine/runners/bun.ts";
import { parsers as compiled } from "../src/engine/runners/compiled.ts";
import { parseEvidence } from "../src/engine/runners/index.ts";
import { parsers as js } from "../src/engine/runners/js.ts";
import { LINTERS, RUNNER_KINDS, uncoveredKinds } from "../src/engine/runners/kinds.ts";
import { parsers as more } from "../src/engine/runners/more.ts";
import { parsers as moreTools } from "../src/engine/runners/more-tools.ts";
import { parsers as native } from "../src/engine/runners/native.ts";
import { parsers as oxlintParsers } from "../src/engine/runners/oxlint.ts";
import { parsers as phpAgent } from "../src/engine/runners/php-agent.ts";
import { parsers as phpRuby } from "../src/engine/runners/php-ruby.ts";
import { parsers as python } from "../src/engine/runners/python.ts";
import { parsers as scenarios } from "../src/engine/runners/scenarios.ts";
import { parsers as suites } from "../src/engine/runners/suites.ts";

const pack = loadPack("generic", packDirs(process.env));
const resultOf = (evidence: string, criteria: readonly string[], p: number | readonly number[] = 0.98) => {
  const { planned, finish } = doneRequest(pack, undefined, criteria, evidence);
  const answers = Object.fromEntries(criteria.map((_, i) => [`c${i + 1}`, { type: "noul" as const, noul: typeof p === "number" ? p : (p[i] ?? 0) }]));
  return finish(planned.length === 0 ? [] : [{ id: "done", answers, stopped: [], cached: true }]);
};
const verdictOf = (evidence: string, criterion = "all tests pass", p = 0.98) => {
  const result = resultOf(evidence, [criterion], p);
  return { verdict: result.verdict, reason: result["reason"] };
};
const lines = (...l: string[]) => `${l.join("\n")}\n`;
const oxlintOf = (evidence: string) => parseEvidence(evidence).runners.find((r) => r.runner === "oxlint");

const OX_AGENT = lines(
  "web/cart.ts:12:9: warning eslint(no-unused-vars): Variable 'total' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.",
  "web/cart.ts:30:5: warning eslint(no-debugger): `debugger` statement is not allowed help: Remove the debugger statement",
);
const OX_WARN = lines(
  "",
  "  ! eslint(no-unused-vars): Variable 'total' is declared but never used. Unused variables should start with a '_'.",
  "   ,-[web/cart.ts:12:9]",
  " 12 | const total = 0;",
  "    :       ^^|^^",
  "    :         `-- 'total' is declared here",
  "    `----",
  "  help: Consider removing this declaration.",
  "",
  "  ! eslint(no-debugger): `debugger` statement is not allowed",
  "   ,-[web/cart.ts:30:5]",
  " 30 |     debugger;",
  "    :     ^^^^^^^^^",
  "    `----",
  "  help: Remove the debugger statement",
  "",
  "Found 2 warnings and 0 errors.",
  "Finished in 7ms on 14 files with 96 rules using 8 threads.",
);
const OX_MIXED = lines(
  "",
  "  ! eslint(use-isnan): Checking equality with NaN will always return false",
  "   ,-[web/price.js:4:11]",
  "    `----",
  "",
  "  x eslint(no-debugger): `debugger` statement is not allowed",
  "   ,-[web/cart.ts:30:5]",
  "    `----",
  "",
  "Found 1 warning and 1 error.",
  "Finished in 6ms on 14 files with 96 rules using 8 threads.",
);
const OX_CLEAN = lines("Found 0 warnings and 0 errors.", "Finished in 4ms on 14 files with 96 rules using 8 threads.");

test("R1: a criterion naming a linter is a lint criterion for the warning cap", () => {
  const warned = "web/cart.ts:12:9: warning unused variable 'total'\nexit code: 0\n";
  assert.equal(parseEvidence(warned).trust, "exit_code");
  for (const name of LINTERS) {
    const criterion = `${name} exits with code 0`;
    assert.deepEqual(verdictOf(warned, criterion), { verdict: "unsure", reason: "warning_in_log" }, name);
    assert.deepEqual(verdictOf(warned, criterion, 0.2), { verdict: "missing", reason: undefined }, name);
    assert.deepEqual(verdictOf("exit code: 0\n", criterion), { verdict: "met", reason: undefined }, name);
    assert.deepEqual(verdictOf(warned, `${name.toUpperCase()} reports nothing`), { verdict: "unsure", reason: "warning_in_log" }, name);
  }
});

test("R1: oxlint's agent format (no summary) under Claude Code with exit code 0 is capped for an oxlint criterion", () => {
  const log = `${OX_AGENT}exit code: 0\n`;
  assert.equal(parseEvidence(log).trust, "exit_code");
  assert.deepEqual(verdictOf(log, "oxlint exits with code 0"), { verdict: "unsure", reason: "warning_in_log" });
  assert.deepEqual(verdictOf(log, "npx eslint . passes"), { verdict: "unsure", reason: "warning_in_log" });
  assert.deepEqual(verdictOf(log, "oxlint exits with code 0", 0.2), { verdict: "missing", reason: undefined });
  assert.deepEqual(verdictOf("$ npx oxlint web\nexit code: 0\n", "oxlint exits with code 0"), { verdict: "met", reason: undefined });
});

test("R1 does not widen: other tools, words inside words and build criteria keep met", () => {
  const log = "[warn] web/cart.ts\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.\nexit code: 0\n";
  assert.deepEqual(verdictOf(log, "prettier --check exits with code 0"), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(log, "the endpoint test passes"), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(log, "the biomes page renders"), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(log, "the build succeeds"), { verdict: "met", reason: undefined });
});

test("R2: oxlint default output: warnings, errors and the files linted", () => {
  assert.deepEqual(oxlintOf(OX_WARN), { runner: "oxlint", passed: 14, failed: 0, errors: 0, skipped: 0, warnings: 2, build_only: true, failing: [], summary_line: "Found 2 warnings and 0 errors." });
  const mixed = oxlintOf(OX_MIXED);
  assert.equal(mixed?.errors, 1);
  assert.equal(mixed?.warnings, 1);
  assert.deepEqual(mixed?.failing, ["web/cart.ts:30:5 eslint(no-debugger)"]);
});

test("R2: a clean oxlint log is not claimed and keeps its exit-code reading", () => {
  assert.equal(oxlintOf(OX_CLEAN), undefined);
  assert.equal(oxlintOf(lines("Found 0 warnings and 0 errors.", "Found 0 warnings and 0 errors.", "Finished in 4ms on 3 files with 96 rules using 8 threads.")), undefined);
  assert.equal(parseEvidence(`${OX_CLEAN}exit code: 0\n`).trust, "exit_code");
  assert.equal(parseEvidence(OX_CLEAN).trust, "unparsed");
  assert.equal(oxlintOf(lines("Found 0 warnings and 0 errors.", "Found 1 warning and 0 errors.", "Finished in 4ms on 3 files with 96 rules using 8 threads."))?.warnings, 1);
});

test("R2: terminal, github, quiet, parse-error and two-run shapes", () => {
  const tty = "\u001b[1G\u001b[0K\r\n  \u001b[38;2;244;191;117;1m⚠\u001b[0m \u001b]8;;https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html\u001b\\eslint(no-unused-vars)\u001b]8;;\u001b\\: Variable 'total' is declared but never used.\r\n   ╭─[web/cart.ts:12:9]\r\n   ╰────\r\n\r\n  × eslint(no-debugger): `debugger` statement is not allowed\r\n   ╭─[web/cart.ts:30:5]\r\n   ╰────\r\n\r\nFound 1 warning and 1 error.\r\nFinished in 3ms on 14 files with 96 rules using 8 threads.\r\n";
  assert.deepEqual([oxlintOf(tty)?.warnings, oxlintOf(tty)?.errors, oxlintOf(tty)?.failing], [1, 1, ["web/cart.ts:30:5 eslint(no-debugger)"]]);
  const github = lines("::warning file=web/cart.ts,line=12,endLine=12,col=9,endColumn=14,title=eslint(no-unused-vars)::web/cart.ts:12:9: Variable 'total' is declared but never used.", "", "Found 1 warning and 0 errors.", "Finished in 5ms on 14 files with 96 rules using 8 threads.");
  assert.equal(oxlintOf(github)?.warnings, 1);
  assert.equal(oxlintOf(lines("", "Found 4 warnings and 0 errors.", "Finished in 5ms on 3 files with 96 rules using 8 threads."))?.warnings, 4);
  const parseError = lines("", "  x Unexpected token", "   ,-[web/broken.ts:1:19]", "    `----", "", "Found 0 warnings and 1 error.", "Finished in 17ms on 1 file with 96 rules using 8 threads.");
  assert.deepEqual([oxlintOf(parseError)?.errors, oxlintOf(parseError)?.failing], [1, ["web/broken.ts:1:19 error"]]);
  const maxWarnings = lines("Found 4 warnings and 0 errors.", "Exceeded maximum number of warnings. Found 4.", "Finished in 4ms on 3 files with 96 rules using 8 threads.");
  assert.equal(oxlintOf(maxWarnings)?.warnings, 4);
  const twoRuns = lines("Found 1 warning and 0 errors.", "Finished in 4ms on 3 files with 96 rules using 8 threads.", "Found 0 warnings and 2 errors.", "Finished in 5ms on 9 files with 96 rules using 8 threads.");
  assert.deepEqual([oxlintOf(twoRuns)?.warnings, oxlintOf(twoRuns)?.errors, oxlintOf(twoRuns)?.passed], [1, 2, 12]);
});

test("R2: done verdicts on parsed oxlint logs", () => {
  assert.deepEqual(verdictOf(`${OX_CLEAN}exit code: 0\n`, "oxlint passes"), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(`${OX_CLEAN}exit code: 0\n`, "lint is clean"), { verdict: "met", reason: undefined });
  assert.equal(resultOf(`${OX_CLEAN}exit code: 0\n`, ["oxlint passes"]).trust, "exit_code");
  assert.deepEqual(verdictOf(`${OX_CLEAN}exit code: 0\n`, "oxlint passes", 0.2), { verdict: "missing", reason: undefined });
  assert.deepEqual(verdictOf(`${OX_WARN}exit code: 0\n`, "oxlint exits with code 0"), { verdict: "unsure", reason: "warning_in_log" });
  assert.deepEqual(verdictOf(`${OX_WARN}exit code: 0\n`, "oxlint exits with code 0", 0.2), { verdict: "missing", reason: undefined });
  assert.deepEqual(verdictOf(`${OX_MIXED}exit code: 1\n`, "oxlint passes"), { verdict: "missing", reason: "exit_code_nonzero" });
  assert.deepEqual(verdictOf(`${OX_MIXED}exit code: 0\n`, "oxlint passes"), { verdict: "unsure", reason: undefined });
});

test("R2: a log cut to the Finished line, or with no files, is incomplete", () => {
  const tail = "Finished in 5ms on 3 files with 96 rules using 8 threads.\nexit code: 0\n";
  assert.equal(oxlintOf(tail)?.incomplete, true);
  assert.deepEqual(verdictOf(tail, "oxlint passes"), { verdict: "unsure", reason: "incomplete_run" });
  assert.equal(oxlintOf("No files found to lint. Please check your paths and ignore patterns.\nFinished in 2ms on 0 files with 96 rules using 8 threads.\n")?.incomplete, true);
});

test("R2: a clean oxlint summary next to another linter's warnings or errors leaves them to the cap", () => {
  const stylelint = lines("css/site.css", "  4:9  ⚠  Expected \"#AABBCC\" to be \"#ABC\"  color-hex-length", "", "⚠ 1 problem (0 errors, 1 warning)", "  1 warning potentially fixable with the \"--fix\" option.", "");
  const markdownlint = lines("markdownlint-cli2 v0.20.0 (markdownlint v0.38.0)", "Summary: 2 issues in 1 file", "docs/guide.md:1 error MD022/blanks-around-headings Headings should be surrounded by blank lines [Expected: 1; Actual: 0; Below]", "docs/guide.md:5 error MD022/blanks-around-headings Headings should be surrounded by blank lines [Expected: 1; Actual: 0; Above]");
  for (const other of [stylelint, markdownlint]) {
    for (const log of [`${other}${OX_CLEAN}exit code: 0\n`, `${OX_CLEAN}${other}exit code: 0\n`]) {
      assert.equal(parseEvidence(log).trust, "exit_code", log);
      for (const criterion of ["lint is clean", "all lint checks pass", "stylelint and oxlint pass", "markdownlint and oxlint pass", "npm run lint passes with no warnings"]) {
        assert.deepEqual(verdictOf(log, criterion), { verdict: "unsure", reason: "warning_in_log" }, `${criterion}\n${log}`);
      }
    }
    assert.deepEqual(verdictOf(`${other}${OX_CLEAN}`, "lint is clean"), { verdict: "unsure", reason: undefined });
    assert.equal(resultOf(`${other}${OX_CLEAN}`, ["lint is clean"]).trust, "unparsed");
  }
  const warned = `${stylelint}${OX_WARN}exit code: 0\n`;
  assert.equal(oxlintOf(warned)?.warnings, 2);
  assert.deepEqual(verdictOf(warned, "lint is clean"), { verdict: "unsure", reason: "warning_in_log" });
});

test("R2: npm's spinner frames or script's ^D before the summary on a terminal capture", () => {
  const spun = (found: string) => `⠙\u001b[1G\u001b[0K⠹\u001b[1G\u001b[0K⠸\u001b[1G\u001b[0K${found}\r\nFinished in 4ms on 1 file with 96 rules using 8 threads.\r\n⠙\u001b[1G\u001b[0Kexit code: 0\n`;
  const warned = oxlintOf(spun("Found 2 warnings and 0 errors."));
  assert.deepEqual([warned?.warnings, warned?.incomplete, warned?.summary_line], [2, undefined, "Found 2 warnings and 0 errors."]);
  assert.deepEqual(verdictOf(doneEvidence(spun("Found 2 warnings and 0 errors.")), "oxlint passes"), { verdict: "unsure", reason: "warning_in_log" });
  assert.equal(oxlintOf(spun("Found 0 warnings and 0 errors.")), undefined);
  assert.deepEqual(verdictOf(doneEvidence(spun("Found 0 warnings and 0 errors.")), "oxlint passes"), { verdict: "met", reason: undefined });
  const script = "^D\b\b\\\u001b[1G\u001b[0KFound 1 warning and 0 errors.\r\nFinished in 4ms on 1 file with 96 rules using 8 threads.\r\n";
  assert.deepEqual([oxlintOf(script)?.warnings, oxlintOf(script)?.incomplete], [1, undefined]);
  assert.equal(oxlintOf(script.replace("1 warning", "0 warnings")), undefined);
  for (const prefixed of ["web/notes.txt:3:Found 1 warning and 0 errors.\n", '{"summary": "Found 1 warning and 0 errors."}\n', "- Found 1 warning and 0 errors.\n", "12:Finished in 4ms on 1 file with 96 rules using 8 threads.\n"]) {
    assert.equal(oxlintOf(prefixed), undefined, prefixed);
  }
});

test("R2: oxlint is no test result, so a test criterion backed only by builds and oxlint is still no tests run", () => {
  const vite = lines("vite v5.2.11 building for production...", "✓ 842 modules transformed.", "✓ built in 7.34s");
  const vitest = lines(" Test Files  4 passed (4)", "      Tests  31 passed (31)");
  assert.deepEqual(verdictOf(`${vite}exit code: 0\n`), { verdict: "unsure", reason: "no_tests_run" });
  assert.deepEqual(verdictOf(`${vite}${OX_WARN}exit code: 0\n`), { verdict: "unsure", reason: "no_tests_run" });
  assert.deepEqual(verdictOf(`${vite}${OX_CLEAN}exit code: 0\n`), { verdict: "unsure", reason: "no_tests_run" });
  assert.deepEqual(verdictOf(`${OX_WARN}exit code: 0\n`), { verdict: "unsure", reason: "no_tests_run" });
  assert.match(String(resultOf(`${vite}${OX_WARN}exit code: 0\n`, ["all tests pass"]).next_step), /^The log shows only a build or a lint run \(no test results\)/);
  assert.deepEqual(verdictOf(`${vitest}${OX_WARN}exit code: 0\n`), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(`${vitest}${OX_WARN}exit code: 0\n`, "all tests pass and lint is clean"), { verdict: "unsure", reason: "warning_in_log" });
  assert.equal("build_only" in (resultOf(`${OX_WARN}exit code: 0\n`, ["oxlint passes"])["runners"] as object[])[0]!, false);
});

test("R2: logs with neither oxlint summary, and other tools' summaries, are not claimed", () => {
  const foreign = [
    OX_AGENT,
    lines("web/cart.ts:12:9: Variable 'total' is declared but never used. [Warning/eslint(no-unused-vars)]", "", "1 problem"),
    lines("web/cart.ts", "  12:9  warning  Variable 'total' is declared but never used  eslint(no-unused-vars)", "", "✖ 1 problem (0 errors, 1 warning)"),
    lines("/srv/app/web/cart.ts", "  12:9  error  'total' is assigned a value but never used  no-unused-vars", "", "✖ 1 problem (1 error, 0 warnings)"),
    lines("Checked 14 files in 3ms. No fixes applied.", "Found 2 errors."),
    lines("Found 1 warning."),
    lines("web/cart.ts(12,9): error TS6133: 'total' is declared but its value is never read.", "", "Found 1 error in web/cart.ts:12"),
    lines("Finished in 0.0042 seconds (files took 0.31 seconds to load)", "12 examples, 0 failures"),
    lines("Finished in 2.418311s, 25.2236 runs/s, 71.1291 assertions/s.", "61 runs, 172 assertions, 0 failures, 0 errors, 0 skips"),
    lines("Finished in 0.9 seconds (0.4s async, 0.5s sync)", "12 tests, 0 failures"),
    lines("  ! a note printed by some script", "Found 3 issues and 0 errors in the report"),
  ];
  for (const log of foreign) assert.equal(oxlintOf(log), undefined, log);
});

test("R3: a lint, build or typecheck criterion with only a test runner parsed gets criterion_not_covered; the verdict is the same", () => {
  const log = `Test Files  4 passed (4)\n     Tests  31 passed (31)\n${OX_AGENT}exit code: 0\n`;
  const r = resultOf(log, ["all tests pass", "oxlint passes"], [0.98, 0.2]);
  assert.equal(r.verdict, "missing");
  assert.equal(r["reason"], "criterion_not_covered");
  assert.deepEqual(r["criteria"], [{ i: 1, verdict: "met", p: 0.98 }, { i: 2, verdict: "missing", p: 0.2, reason: "criterion_not_covered" }]);
  assert.match(String(r.next_step), /^Only vitest output was recognised.*no lint output for criterion 2\. Run the lint check on its own/);
  assert.deepEqual(verdictOf(log, "the build succeeds", 0.6), { verdict: "unsure", reason: "criterion_not_covered" });
  assert.deepEqual(verdictOf(log, "typecheck passes", 0.2), { verdict: "missing", reason: "criterion_not_covered" });
  assert.match(String(resultOf(log, ["lint and typecheck pass"], 0.2).next_step), /no lint or type check output for the criterion\. Run the lint check and the type check on their own/);
});

test("R3 leaves met, covered criteria, exit-code-only logs and earlier reasons alone", () => {
  const vitest = "Test Files  4 passed (4)\n     Tests  31 passed (31)\nexit code: 0\n";
  const met = resultOf(vitest, ["all tests pass", "lint passes"]);
  assert.equal(met.verdict, "met");
  assert.equal("reason" in met, false);
  assert.equal(met.next_step, undefined);
  assert.deepEqual(verdictOf(`${OX_CLEAN}exit code: 0\n`, "lint is clean", 0.2), { verdict: "missing", reason: undefined });
  assert.deepEqual(verdictOf("web/cart.ts(12,9): error TS6133: 'total' is declared but its value is never read.\nexit code: 0\n", "typecheck passes", 0.2), { verdict: "missing", reason: undefined });
  assert.deepEqual(verdictOf("Found 0 errors. Watching for file changes.\nexit code: 0\n", "the build succeeds", 0.2), { verdict: "missing", reason: undefined });
  assert.deepEqual(verdictOf("$ npm run lint\nexit code: 0\n", "lint passes", 0.2), { verdict: "missing", reason: undefined });
  assert.deepEqual(verdictOf(vitest, "all tests pass", 0.2), { verdict: "missing", reason: undefined });
  const skipped = "Test Files  4 passed (4)\n     Tests  30 passed | 1 skipped (31)\nexit code: 0\n";
  const capped = resultOf(skipped, ["all tests pass", "lint passes"]);
  assert.deepEqual([capped.verdict, capped["reason"]], ["unsure", "skipped_tests"]);
  assert.deepEqual(capped["criteria"], [{ i: 1, verdict: "unsure", p: 0.98 }, { i: 2, verdict: "unsure", p: 0.98, reason: "criterion_not_covered" }]);
});

test("R3: every runner name a parser emits has a kind, and every kind entry is emitted", () => {
  const emitted = parseEvidence("$ flutter test --no-pub\n00:00 +0: adds one to input values\n00:00 +1: All tests passed!\nexit code: 0\n").runners.map((r) => r.runner);
  assert.deepEqual(emitted, ["flutter test"]);
  const names = [...[...python, ...js, ...compiled, ...phpRuby, ...more, ...suites, ...scenarios, ...builds, ...native, ...moreTools, ...bun, ...oxlintParsers, ...phpAgent].map((p) => p.name), ...emitted];
  assert.deepEqual(names.filter((n) => RUNNER_KINDS[n] === undefined), []);
  assert.deepEqual(Object.keys(RUNNER_KINDS).filter((n) => !names.includes(n)), []);
  assert.deepEqual(uncoveredKinds("cargo check passes the typecheck", ["cargo build"]), []);
  assert.deepEqual(uncoveredKinds("the build succeeds and lint is clean", ["vite"]), ["lint"]);
  assert.deepEqual(uncoveredKinds("all tests pass", ["eslint"]), []);
});
