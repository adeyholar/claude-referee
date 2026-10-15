# `done`: runners for PHP agent-format JSON summaries

Registered 2026-10-15, before the parser code. Chosen with `decide` (p 0.91, both orders agree, receipt `rmv96d0pwc5jf`) over a criterion-aware next step; the option costs were written by the assistant. An earlier first ask among three options (parser, a usage-report filter, the next step) leaned to the cheapest one (0.76, weak) and the filter shipped first.

## Why (local data, aggregates only)

The usage report and the local Claude Code transcripts from 2026-10-09 to 2026-10-15 show where `done` fails in real work:

- `done` calls in real projects that ran the PHP stack (`composer test`, Pint, PHPStan, Rector): 13, of which 1 `met`, 8 `missing`, 4 `unsure`. The other 21 calls: 15 `met`, 6 `missing`.
- 10 of the 15 exit-code-only calls were PHP stack. Since 2026-10-09 no `done` receipt carries a PHP runner (parsed runners: node:test, vite, vitest, oxlint).
- In the 117 recorded `composer test` and related outputs on this machine, 62 carry one-line JSON summaries: `{"tool":"pint","result":"passed"|"fixed"}`, `{"tool":"phpstan","result":"passed"|"failed","errors":N,...}`, `{"tool":"rector","result":"passed"|"failed","totals":{"changed_files":N,"errors":N},...}`. Today nothing reads them, so a log made of them is "exit code only".
- A controlled probe: an exit-status criterion over a log with only `exit code: 0` gave `met` (0.83 to 0.97); real calls whose log also held an unread JSON line gave `missing` (0.17 to 0.49).

The format is known from this machine's runs only; the tools' own documentation was not read, so the key names are observed, not specified.

## What

One new runner file with three parsers, `pint`, `phpstan`, `rector`. A summary object is counted only when it starts a line, follows a `grep -n` style `N:` prefix, or follows the closing brace of another summary object (the real logs glue them: `...passed"}{"tool":"phpstan"...`). Anything else, such as the same text inside a message or after other text on a line, is not read.

Facts (build-only, like the oxlint runner; no paths, no error messages, no `error_details`, no file lists):

- `pint`: `passed` gives errors 0; `failed` gives errors 1; `fixed` marks the run incomplete (files were rewritten, so the check did not verify the code as it stands; the existing incomplete cap already says "changed files").
- `phpstan`: `passed` gives errors 0; `failed` gives errors N (at least 1).
- `rector`: `passed` gives errors 0; `failed` gives failed = changed files N and errors M.
- The worst result per tool wins; the summary line is one of a fixed set of sentences.

Kinds: `pint` and `phpstan` cover `lint`; `rector` covers nothing (a rector dry run is not a lint run). The warning caps are not changed: a log whose other linter reports warnings still caps a lint or clean criterion at `unsure`.

## Bars (checked by tests and one replay)

- **B1:** invented fixtures for every tool and result, glued objects, a `grep -n` prefix and ANSI progress text give exactly the expected facts.
- **B2:** the same JSON inside a message, a quoted string, a test name, or after other text on a line is not read as a runner; a `failed` summary with `exit code: 0` is a conflict (never `met`).
- **B3:** no fact contains a path, a file name or an error message (the tests assert it on fixtures that carry them).
- **B4:** replay over the local real outputs, counts only in this repository: how many logs gain a runner, and that none is read as passing while its own log has a `failed` summary or a non-zero exit line. The replay is fitted to the same outputs that showed the format; it is a regression check, not a clean test.
- **B5:** the existing suites and the recorded evals score unchanged (`ci:local` green), and `RUNNER_KINDS` lists every runner name.
- **B6:** a live `done` probe on invented fixtures in a temporary data directory: a `passed` summary with an exit-status or tool criterion gives `met`; a `failed` summary gives `missing` or `unsure`, never `met`.

## Not measured, stated up front

- The effect on real calls. The 13 calls' evidence was never stored, and re-sending their criteria and outputs to the API for a replay was not done. The reference to re-measure after the live install is 1 `met` of 13 for PHP-stack calls; read it with the same transcript count.
- Composite `composer test` logs that also hold another linter's warnings stay capped at `unsure` for lint and clean criteria.
- A criterion that says "test" (`composer test exits with code 0`) is a test criterion for the existing build-only cap, so on a log made only of these runners and a lint run it is capped at `unsure` (`no_tests_run`), where before it was read from the exit code alone. Tool-named criteria (`phpstan reports no errors`, `pint passes`) are the case this change is for. The cap was not changed; whether `composer test` as a command name should count as a test claim is a separate question.
- Pint `failed` and Rector `failed` with errors were seen in only a few runs; the `pint` `failed` shape was not seen at all and is read by its `result` value alone.

## Result (2026-10-15)

Written after the code. B1 to B3 and B5 are tests (`test/runners-php-agent.test.ts`, `test/lint-cap-tool-names.test.ts`); B4 and B6 ran once.

- **B4, replay over the 117 local real outputs** (counts only; fitted to the same outputs that showed the format, so a regression check): 62 outputs hold 118 summary objects. Trust before the change: 18 parsed, 67 exit code only, 32 unparsed; after: 65 parsed, 23 exit code only, 29 unparsed. 47 outputs gained a runner only from these parsers. 9 outputs hold a `failed` object and all 9 read as failing; 0 read as passing while a `failed` object exists; 0 objects were rejected by the line-start rule; 0 conflicts.
- **B6, live `done` on invented fixtures** (temporary data directory, run from source): `pint` passed with an exit-status criterion `met` 0.93; `phpstan` passed with "reports no errors" `met` 0.96; `phpstan` failed with exit code 0 `missing` 0.02; `phpstan` failed with exit code 1 `missing`, Jev not asked; `pint` fixed `missing` 0.24 (Jev's answer; the code cap would have made it `unsure`); the same criterion over only `exit code: 0` `missing` 0.26 (before the change a passed summary was invisible).
- **B5:** `ci:local` green (see the commit).
