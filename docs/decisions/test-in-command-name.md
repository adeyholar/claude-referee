# `done`: "test" inside a script name is not a test claim

Registered 2026-10-15, before the code. A real session (the maintainer relayed it) wrote the criterion "composer test (pint, rector, lint, phpstan, vue-tsc) exits with code 0", got `unsure` (`no_tests_run`) and had to narrow the criterion to lint and typecheck to get an answer. The project's `composer test` script is a lint and type chain with no tests, so the log held only build-only runners (oxlint, Pint, PHPStan, Rector), and the build-only cap treats any criterion that contains the word "test" as a claim that tests ran. [php-agent-json.md](php-agent-json.md) had named this as a limit; it is a defect in practice.

## Change

A script-runner command named in the criterion is not a test claim: `composer test`, `npm test`, `npm run test:unit`, `pnpm test`, `yarn test`, `make test`, `bun run test` (also with a `:suffix`). The word is removed before the build-only cap asks whether the criterion is about tests. Anything else is unchanged: "all tests pass", "the tests pass", "composer test passes all the tests", and the toolchain test commands (`cargo test`, `go test`, `dotnet test`, `php artisan test`, `mvn test`, `bun test`, ...), whose subcommand is the test runner itself. The other caps do not look at the criterion's wording and are untouched (zero tests ran, skipped tests, incomplete runs, warnings).

## Bars

- **B1:** on a log of only build-only runners with exit code 0, "composer test exits with code 0", "npm run test:unit passes" and "make test succeeds" can be `met`; "all tests pass", "the tests pass", "composer test passes all the tests", "cargo test passes" and "bun test passes" stay `unsure` with `no_tests_run`.
- **B2:** the recorded `done` suites score unchanged on `jev-1.13.0` (wrong positives, wrong negatives, `met` counts per suite equal to the committed recordings' scores), so the cap that protects them does not move.
- **B3:** `ci:local` green.

## Not measured

How often a real script named `test` runs no tests. The `--run test` default criterion stays "all tests pass" (strict): for a project whose `test` script only lints, `done --run test` says so (`no_tests_run`) and names `--criteria "<command> exits with code 0"` as the way to claim what the script does.
