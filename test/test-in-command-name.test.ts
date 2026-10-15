// docs/decisions/test-in-command-name.md: "test" inside a script runner's command is not a test claim for the build-only cap; every other wording and the toolchain test commands still are.

import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsTests, doneRequest } from "../src/cli/commands/done.ts";
import { loadPack, packDirs } from "../src/engine/pack.ts";

const pack = loadPack("generic", packDirs(process.env));
const BUILD_ONLY = '{"tool":"pint","result":"passed"}\n{"tool":"phpstan","result":"passed","errors":0}\nexit code: 0\n';
const WITH_WARNINGS = `Found 4 warnings and 0 errors.\nFinished in 900ms on 400 files with 116 rules using 8 threads.\n${BUILD_ONLY}`;
const verdictOf = (criterion: string, evidence = BUILD_ONLY) => {
  const { planned, finish } = doneRequest(pack, undefined, [criterion], evidence);
  const result = finish(planned.length === 0 ? [] : [{ id: "done", answers: { c1: { type: "noul" as const, noul: 0.98 } }, stopped: [], cached: true }]);
  return { verdict: result.verdict, reason: result["reason"] };
};

test("B1: a script runner's test script in the criterion is not a test claim, other wordings are", () => {
  for (const c of ["composer test exits with code 0", "npm run test:unit passes", "make test succeeds", "pnpm test exits 0", "yarn test:ci passes", "bun run test passes", "composer test (pint, rector, phpstan, vue-tsc) exits with code 0"]) {
    assert.equal(claimsTests(c), false, c);
    assert.deepEqual(verdictOf(c), { verdict: "met", reason: undefined }, c);
  }
  for (const c of ["all tests pass", "the tests pass", "composer test passes all the tests", "cargo test passes", "bun test passes", "php artisan test passes", "go test ./... passes", "the spec suite passes", "npm test and the integration tests pass"]) {
    assert.equal(claimsTests(c), true, c);
    assert.deepEqual(verdictOf(c), { verdict: "unsure", reason: "no_tests_run" }, c);
  }
});

test("the other caps ignore the wording: a log that says no tests ran, or another linter's warnings, still cap a script-name criterion", () => {
  assert.deepEqual(verdictOf("npm test exits with code 0", "Error: no tests found\nexit code: 0\n"), { verdict: "unsure", reason: "no_tests_run" });
  assert.deepEqual(verdictOf("composer test (pint, phpstan) exits with code 0", WITH_WARNINGS), { verdict: "unsure", reason: "warning_in_log" });
  assert.deepEqual(verdictOf("composer test exits with code 0", WITH_WARNINGS), { verdict: "met", reason: undefined });
});
