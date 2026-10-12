# A test that the version files, the changelog and the ROADMAP agree

Written 2026-10-12, after the code (the bars below were checked by the test). Chosen with `decide` among three options before it: version test 1.00, both orders agreeing (receipt `rmv52wr0qosnn`). The option costs in that context were written by the maintainer's assistant, so the 1.00 is not independent evidence; the measured facts below are.

## Why

The ROADMAP header said "Latest release: v0.2.5" while `package.json`, `plugin.json`, `npm/package.json` and the CHANGELOG top section said 0.2.8. It missed three releases (0.2.6, 0.2.7, 0.2.8) and stayed wrong in the public repository for three days. Nothing compared those places. `test/docs-facts.test.ts` already checks doc statements against code, so the check goes there.

## The rule

`test/docs-facts.test.ts` fails unless, for the version in `package.json`: `plugins/claude-referee/.claude-plugin/plugin.json` and `npm/package.json` carry the same version, the first versioned CHANGELOG heading is that version, and `ROADMAP.md` contains `Latest release: v<version> (` and a `| Release <version> |` row. A release commit has to update the header and the row in the same commit.

## Bars

- **B1:** the test passes on the current files.
- **B2:** the header check fails on the stale ROADMAP of c8cd924 (checked by running its condition on that file: header false).
- **B3:** `npm run check` and `ci:local` green.

## Not done: silent `tsc` reading

Considered in the same decision and not built. On 71,916 distinct local tool results, 158 contain an npm echo of `tsc` or `vue-tsc` and 2 have the silent shape (echo, blank line, `exit code: 0`); both came from this repository's own typecheck gate. No other project shows the shape, so there is no measured use outside this repository, and the change would add a wrong-`met` surface (a solution-style `tsconfig.json` with `"files": []` exits 0 silently while checking nothing). Revisit if another project's logs show the shape.

## Limits

- The test checks that the header names the version, not that the release exists on GitHub or npm.
- The `| Release <version> |` row must exist, but its text is not checked.
