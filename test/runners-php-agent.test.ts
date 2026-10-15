// docs/decisions/php-agent-json.md: Pint, PHPStan and Rector one-line JSON summaries read as runner facts. Every object below is invented in the shape seen in real runs; no real path or message is committed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { doneRequest } from "../src/cli/commands/done.ts";
import { loadPack, packDirs } from "../src/engine/pack.ts";
import { parseEvidence } from "../src/engine/runners/index.ts";

const pack = loadPack("generic", packDirs(process.env));
const resultOf = (evidence: string, criterion: string, p = 0.98) => {
  const { planned, finish } = doneRequest(pack, undefined, [criterion], evidence);
  return finish(planned.length === 0 ? [] : [{ id: "done", answers: { c1: { type: "noul" as const, noul: p } }, stopped: [], cached: true }]);
};
const verdictOf = (evidence: string, criterion: string) => {
  const result = resultOf(evidence, criterion);
  return { verdict: result.verdict, reason: result["reason"] };
};
const factsOf = (evidence: string) => parseEvidence(evidence).runners;
const ESC = "\x1b";
const EXIT = "exit code: 0\n";

const PINT_PASS = '{"tool":"pint","result":"passed"}';
const PINT_FIXED = '{"tool":"pint","result":"fixed","files":[{"path":"app/Models/Order.php","fixers":["ordered_class_elements","unary_operator_spaces"]}]}';
const PINT_FAILED = '{"tool":"pint","result":"failed","files":[{"path":"app/Models/Order.php","fixers":["ordered_class_elements"]}]}';
const STAN_PASS = '{"tool":"phpstan","result":"passed","errors":0}';
const STAN_FAIL = '{"tool":"phpstan","result":"failed","errors":2,"error_details":{"app/Actions/Ship.php":[{"line":9,"message":"Cannot cast mixed to string.","identifier":"cast.string"}]}}';
const RECTOR_PASS = '{"tool":"rector","result":"passed","totals":{"changed_files":0,"errors":0},"changed_files":[]}';
const RECTOR_FAIL = '{"tool":"rector","result":"failed","totals":{"changed_files":3,"errors":1},"file_diffs":[{"file":"app/A.php","diff":"--- Original\\n+++ New\\n@@ -1 +1 @@\\n-{ $a }\\n+{$a}\\n"}]}';

test("B1: each tool and result gives the expected facts", () => {
  const one = (text: string) => factsOf(`${text}\n`).map(({ runner, failed, errors, incomplete, build_only, summary_line }) => ({ runner, failed, errors, incomplete, build_only, summary_line }));
  assert.deepEqual(one(PINT_PASS), [{ runner: "pint", failed: 0, errors: 0, incomplete: undefined, build_only: true, summary_line: "pint reported no style issues" }]);
  assert.deepEqual(one(PINT_FIXED), [{ runner: "pint", failed: 0, errors: 0, incomplete: true, build_only: true, summary_line: "pint rewrote files (result fixed)" }]);
  assert.deepEqual(one(PINT_FAILED), [{ runner: "pint", failed: 0, errors: 1, incomplete: undefined, build_only: true, summary_line: "pint reported style issues (result failed)" }]);
  assert.deepEqual(one(STAN_PASS), [{ runner: "phpstan", failed: 0, errors: 0, incomplete: undefined, build_only: true, summary_line: "phpstan reported no errors" }]);
  assert.deepEqual(one(STAN_FAIL), [{ runner: "phpstan", failed: 0, errors: 2, incomplete: undefined, build_only: true, summary_line: "phpstan reported 2 errors" }]);
  assert.deepEqual(one(RECTOR_PASS), [{ runner: "rector", failed: 0, errors: 0, incomplete: undefined, build_only: true, summary_line: "rector dry run found nothing to change" }]);
  assert.deepEqual(one(RECTOR_FAIL), [{ runner: "rector", failed: 3, errors: 1, incomplete: undefined, build_only: true, summary_line: "rector would change 3 files and reported 1 errors" }]);
});

test("B1: glued objects, a grep -n prefix and ANSI progress text are read; the worst result per tool wins", () => {
  const glued = `${PINT_PASS}${STAN_PASS}${RECTOR_PASS}${EXIT}`;
  assert.deepEqual(factsOf(glued).map((r) => r.runner).sort(), ["phpstan", "pint", "rector"]);
  const progress = `${PINT_PASS}  0/30 [░░░░░░]   0%${ESC}[1G${ESC}[2K 30/30 [▓▓▓▓▓▓] 100%\n49:${STAN_PASS}\n`;
  assert.deepEqual(factsOf(progress).map((r) => r.runner).sort(), ["phpstan", "pint"]);
  const worst = factsOf(`${PINT_PASS}\n${PINT_FIXED}\n${STAN_PASS}\n${STAN_FAIL}\n`);
  assert.deepEqual(worst.map((r) => [r.runner, r.errors, r.incomplete ?? false]), [["pint", 0, true], ["phpstan", 2, false]]);
  assert.equal(parseEvidence(`${PINT_PASS}\n${EXIT}`).trust, "parsed");
});

test("B2: the same text inside a message, a title, a quote or after other text is not read; unknown tools and results are ignored", () => {
  for (const text of [
    `note: ${STAN_PASS}`,
    `✔ prints ${PINT_PASS}`,
    `"${PINT_PASS.replaceAll('"', '\\"')}"`,
    `   x ${RECTOR_PASS}`,
    '{"tool":"eslint","result":"passed"}',
    '{"tool":"pint","result":"skipped"}',
    '{"tool":"phpstan","outcome":"passed"}',
  ]) assert.deepEqual(factsOf(`${text}\n${EXIT}`), [], text);
  assert.equal(parseEvidence(`note: ${PINT_PASS}\n${EXIT}`).trust, "exit_code");
});

test("B3: no path, file name or message reaches the facts", () => {
  const facts = JSON.stringify(factsOf(`${PINT_FIXED}${STAN_FAIL}${RECTOR_FAIL}\n`));
  assert.doesNotMatch(facts, /app\/|\.php|Cannot cast|Original|ordered_class|identifier/);
});

test("B2/B6: a failed summary next to exit code 0 is a conflict and never met; passed summaries give met for tool and exit criteria", () => {
  assert.deepEqual(parseEvidence(`${STAN_FAIL}\n${EXIT}`).conflict, true);
  assert.notEqual(verdictOf(`${STAN_FAIL}\n${EXIT}`, "phpstan reports no errors").verdict, "met");
  assert.notEqual(verdictOf(`${RECTOR_FAIL}\n${EXIT}`, "the rector dry run changes nothing").verdict, "met");
  assert.deepEqual(verdictOf(`${STAN_PASS}\n${EXIT}`, "phpstan reports no errors"), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(`${PINT_PASS}\n${EXIT}`, "pint style check passes with exit code 0"), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(`${RECTOR_PASS}\n${EXIT}`, "the rector dry run changes nothing"), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(`${PINT_FIXED}\n${EXIT}`, "pint style check passes"), { verdict: "unsure", reason: "incomplete_run" });
});

test("composite logs keep the existing caps: warnings from another linter cap a lint criterion, and a criterion about tests still needs test results", () => {
  const composite = `Found 4 warnings and 0 errors.\nFinished in 900ms on 400 files with 116 rules using 8 threads.\n${PINT_PASS}\n${STAN_PASS}\n${EXIT}`;
  assert.deepEqual(verdictOf(composite, "composer run check exits with code 0"), { verdict: "met", reason: undefined });
  assert.deepEqual(verdictOf(composite, "phpstan reports no errors"), { verdict: "unsure", reason: "warning_in_log" });
  assert.deepEqual(verdictOf(composite, "composer test exits with code 0"), { verdict: "met", reason: undefined }, "a script's name is not a test claim (test-in-command-name.md)");
  assert.deepEqual(verdictOf(composite, "all tests pass"), { verdict: "unsure", reason: "no_tests_run" });
});

test("a criterion about tests is not met by these runners alone", () => {
  assert.equal(verdictOf(`${PINT_PASS}\n${STAN_PASS}\n${EXIT}`, "all tests pass").verdict, "unsure");
});
