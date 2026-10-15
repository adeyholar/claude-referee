# `done --run`: the CLI runs the check itself

Registered 2026-10-15, before the code. The maintainer asked for it ("done --run ile devam et"); the advisor tool picked it over three measurement-only options, and Jev's last ask (a different option set) leaned to a transcript report at a weak 0.84.

## Why (local data, aggregates only)

In real projects since 2026-10-09, `done` calls that piped the real output of the check got `met` in 13 of 22; calls that typed or saved the evidence (an inline string, a file, a heredoc, an echo chain) got `met` in 3 of 13, and 12 of those 13 were exit-code-only. The failing calls show the same habits: output cut with `tail` or `grep`, a saved file from an earlier run, an exit code read from the wrong pipeline stage, and five to nine criteria against an exit code alone. A parser fixes one tool at a time; running the check inside `done` removes the class: the output is complete, the exit code is the check's own, and nothing is stale.

## What

`claude-referee done --run <test|lint|typecheck|build|check|ci|verify>` (or the exact detected command) runs the project's detected check, captures stdout and stderr in order, appends `exit code: N`, and judges that evidence exactly as piped evidence is judged (same parsers, caps and bands).

- **Only detected checks run.** The command must be one `detect-checks` finds from the nearest manifest (`package.json`, `composer.json`, `Cargo.toml`, `go.mod`, `artisan`), by family word or by its exact text. Anything else is refused with the detected list, and nothing runs. The CLI is not a general command runner: a project that allowlists `claude-referee` must not get a way around its Bash permission rules, and a script name from a cloned repository must not become shell syntax, so a detected script name has to match `[A-Za-z0-9:._-]+` or it is dropped (this also tightens the briefing).
- **Criteria default to the family** when `--criteria` is absent: `all tests pass`, `lint is clean`, `the typecheck passes`, `the build succeeds`, `all checks pass`; an explicit `--criteria` is used as given.
- **Exit code 3 unless `met`** by default (an explicit `--fail-on` overrides), so a Bash call that was not met reads as a failed check to the Stop gate and `audit`, and a `met` one as a passing check after the last edit.
- **Safety of the child:** the shell inherits the environment minus the TypeSafe key variables, gets no stdin, runs in the manifest folder, and is killed (process group) after `--timeout` seconds (default 600; the evidence then carries `exit code: 124`, so nothing is `met`).
- **Receipts** keep `run: true`, never the command text. `--dry-run` still runs the check (the request is built from its output) and sends nothing.

## Bars

- **B1:** resolution: a family word and an exact command resolve; any other command, a family with no detected script, and an unsafe script name are refused, and a marker file shows nothing ran.
- **B2:** execution (invented project, fake Jev): a passing check is judged and can be `met`; a failing check is `missing` without asking Jev; a timeout gives exit code 124 and no `met`; stderr and stdout keep their order; the TypeSafe key variables are not in the child's environment; `--run` with `--evidence` is refused.
- **B3:** exit code 3 when not `met`, 0 when `met`, and an explicit `--fail-on` wins.
- **B4:** the Stop gate and `audit` read a `claude-referee done --run` call as a check: exit 0 after the last edit counts as passing, a non-zero exit does not.
- **B5:** live on this repository: `done --run typecheck` is `met`; a deliberately failing detected check is `missing` with 0 requests.
- **B6:** `ci:local` green; the briefing stays within its 800 characters with a long plugin path.

## Not measured, stated up front

Whether Claude uses `--run` instead of piping, and what share of real `done` calls then reach `met`. The reference is the 13-of-22 and 3-of-13 above; re-count after the live install with the same transcript method, once at least 20 `--run` calls exist. Claude Code's Bash tool has its own timeout (two minutes by default), which applies to the whole `claude-referee` call.

## Result (2026-10-15)

Written after the code. B1 to B4 are `test/done-run.test.ts` (9 tests); the full suite and `ci:local` are B6.

- **B1, B2, B3, B4 hold.** A refused command (`touch`, an unlisted family, `rm -rf /`, `test; touch pwned`, a script named `test:$(touch pwned)`) runs nothing; a passing check reaches `met` and exits 0; a failing check is `missing` with 0 requests and exits 3; a timeout of 1 second kills a 20-second check and reports 124; stdout and stderr keep their order; `TYPESAFE_API_KEY` and `REFEREE_BASE_URL_KEY` are absent in the child while other variables pass; `--run` with `--evidence`, a bad `--timeout` and Windows are refused; the Stop gate counts a `done --run` call with a `met` result as a pass and a failed call as not.
- **B5 (live, real Jev, `jev-1.14.0`):** `done --run typecheck` on this repository `met` (p 0.9, exit-code-only evidence); an invented project: a check printing `Tests: 3 passed, 3 total` `met` 0.99 (exit 0), a lint check with one warning `missing` 0.15 (exit 3), a build exiting 2 `missing` with 0 requests (exit 3).
- **Briefing:** 695 characters in the worst case of the test (four long detected checks and a 87-character plugin path), limit 700.
- Changed after seeing live output: a not-met verdict under `--run` gets its own next step (the old text said to pipe the output in, which is the wrong advice when `done` ran the check).

## Independent review (2026-10-15, same day)

A read-only agent reviewed the five commits of the day against the registered rules and reported 12 verified findings (it ran probes in a scratch folder; no network, no key). All but the two noted below were fixed the same day, each with a test in `test/done-run.test.ts` or the file of its area:

- **Security:** the plugin's own setting `CLAUDE_PLUGIN_OPTION_API_KEY` (the first key source) reached the check's environment; the filter now drops every key-like name (`TYPESAFE_API_KEY`, `TYPESAFE_API_KEY_CMD`, `EVAL_TYPESAFE_API_KEY`, `REFEREE_BASE_URL_KEY` and any `CLAUDE_PLUGIN_OPTION_*KEY|SECRET|TOKEN*`), and the test checks all of them.
- **Stop gate:** a not-met `done --run` next to another call in one command (`...; done --run test || true`) could count as a pass. Every verdict in the output must now be `met`, a command made only of run segments needs one verdict per segment, a mixed command falls back to the ordinary reading, and the segment is recorded as `claude-referee done --run` without its criteria text (which would otherwise have reached the gate's check list). Only `claude-referee done ...` and `node .../cli.mjs done ...` count, not other subcommands that happen to carry `--run`.
- **`runCheck`:** it waited for the pipe to close, so a check that left a background child behind hung until the timeout and then reported a false 124, and a descendant that escaped the process group could block the timeout. The exit code now comes from the shell's `exit` event, `close` gets a 1.5 s grace, and the timeout path resolves after the same grace. A SIGINT, SIGTERM or SIGHUP to the CLI (or its exit) kills the check's process group, so a cancelled Bash call no longer orphans a test run.
- **Order of checks:** the criteria count was validated after the check had run; it is now validated first. The check's own exit status now outvotes a stray "exit code 1" the check itself printed.
- **`claimsTests`:** `test\w*` swallowed `tests` and `testing`, so "make tests pass" and "yarn tests pass" escaped the build-only cap; the script token now ends at a word boundary.
- **Folders and files:** a lone subfolder named `-P`, `-L` or `--` became a `cd` option and ran the check in `$HOME`; a name must now start with a letter, digit or underscore. Without a project (no file, no default) the single-subfolder fallback is off for `--run`. `look` refuses a path that is not a regular file (a FIFO blocked forever), counts duplicate images once against the 24 MiB cap and reads the first IHDR.
- **Smaller:** a null token count from the API is now unpriced instead of 0 tokens and 0 dollars; image calls get a 30 s attempt and 60 s total budget; `look --dry-run` says size and hash (it never printed dimensions; its token estimate leaves the images out); the usage split no longer counts errored `done` calls as piped; an unterminated PHP summary object no longer hides the next one.
- **Not changed:** symlinked subfolders are still followed by the subfolder fallback; the image reference is a 48-bit hash prefix that a user redaction pattern such as `[0-9a-f]{12}` would rewrite (the request then fails before sending, never a wrong cache hit); a multibyte character straddling the 1,000,000-byte head boundary shows as two replacement characters.
- **Unverified by the reviewer:** whether Claude Code's Bash tool environment actually carries the plugin key variable; Linux and Windows behaviour (macOS only).
