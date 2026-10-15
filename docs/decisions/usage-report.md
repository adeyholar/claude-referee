# scripts/usage-report.mjs: the four usage measures, reproducible

Registered 2026-10-09, before any code change. Chosen with `decide` among three options (maintainer script o2 1.00, both orders agreeing; receipt `rmv131y002f0c`).

## Why

The development loop rests on four measures that were computed with throw-away scripts and then lost; twice a throw-away script mis-attributed receipts. The baselines live only in conversation.

## The measures (local data only, counts and shares, no text)

1. **Edit turns with a counted check:** stop records grouped by `turn`; turns with edits; those with a counted check. Baseline 28 of 52 (54%), before the briefing nudge went live.
2. **Re-ask after a non-clear decide:** per session, the next `decide` within 10 minutes of a `weak` or `tie` one, and how many are `clear`. Baseline 24 of 83.
3. **Exit-code-only `missing`:** `done` receipts, `missing` ones with `trust: exit_code`, and their `evidence_lines` (under 5, 5 or more, unknown for receipts before 0.2.7). Baseline 123 of 242.
4. **Labels:** receipt labels joined to the receipt's verdict, right and wrong per verdict (4 right, 0 wrong `met` so far).

`--days N` (default 7), `--since <ISO time>` for before and after comparisons, `--data-dir`. Output: one JSON line.

## Bars

- **B1:** invented receipts, stops and labels give exactly the expected counts for each measure, including the window and the 10-minute rule.
- **B2:** no text field is read or printed; ids and criteria never appear in the output.
- **B3:** the script runs on the real data directory and its totals agree with `receipts --evidence-stats` for the labels.
- **B4:** `npm run check` and `ci:local` green; a note in CONTRIBUTING.

## Limits

- It reads one data directory (all projects in it); it cannot tell this repository's own worktrees from other projects without the `worktree` field, which only receipts written by 0.2.6 and later have.
- The measures are observational; no control group.

## Update 2026-10-15: `--exclude-pack` and `--until`

Written after the code and one run on the real data directory; the test (invented receipts) is bar B5 below.

**Why.** The re-ask measure was read from all sessions. One session that ran a reply-gating workflow (a judge pack other than `generic`, plus `decide` in the same session) wrote 265 of the 268 non-clear `decide` re-asks since the briefing went live (raw 86 cleared of 268; without that session 3 of 3), and every one of the 541 `judge` receipts. So the 24 of 83 baseline was not a measure of coding use.

**What.** `--exclude-pack <name>` (repeatable) leaves out every session that wrote a receipt under that pack, from all four measures; the output counts them as `excluded_by_pack`. `--until <ISO time>` closes the window, so a before window can be read with the same rules as the after window. Filtering the `decide` receipts by pack does not work: they carry `generic`; the pack shows on the session's other receipts.

**Baselines under the same rules** (`--exclude-session current --exclude-pack <the reply-gate pack>`; raw in brackets):

| Window | Edit turns with a counted check | Re-ask cleared | Exit-code-only share of `missing` |
|---|---|---|---|
| 2026-10-02 to 2026-10-09 14:00 UTC (before the briefing) | 33 of 67 (0.49) | 27 of 89 [32 of 97] | 141 of 231 |
| 2026-10-09 14:00 UTC to 2026-10-15 | 25 of 49 (0.51) | 3 of 3 [86 of 268] | 25 of 36 (0.69) |

**Reading.** The share of edit turns with a counted check did not move (0.49 to 0.51; n 67 and 49, no test, observational). The re-ask measure has no reading after the install: with the reply gate out, only 3 non-clear `decide` calls were re-asked. The exit-code-only share of `missing` went from 0.61 to 0.69. The earlier recorded baselines (28 of 52, 24 of 83, 123 of 242) used other windows and stay as history.

**B5:** `test/usage-report.test.ts` checks, on invented data, that a pack exclusion drops the whole session from every measure, counts it once, and that `--until` closes the window.

**Limit.** A session counts as excluded if any receipt in it carries the pack, including receipts outside the window.
