# Contributing to claude-referee

Thanks for helping. claude-referee is small on purpose: every check has to earn its place with a measurement, and every number in the docs says whether it was measured or modelled. Contributions that keep it that way are the most welcome.

You don't need a TypeSafe API key. Tests run offline against a local fake of the Jev API, and CI never calls Jev.

## Setup

- Node 22.18 or later for development. Tests run the TypeScript sources directly with Node's built-in type stripping. The bundle itself runs on Node 20.3 or later.
- No global tools. Everything is in `devDependencies`.

```bash
git clone https://github.com/ismaildasci/claude-referee
cd claude-referee
npm ci
npm run check    # typecheck, tests, build
```

To try your build inside Claude Code:

```bash
claude --plugin-dir plugins/claude-referee
```

## How the code is laid out

| Path | What lives there |
|---|---|
| `src/engine/` | Shared logic: key lookup, data directory, redaction, cache, the Jev client, packs and project files |
| `src/cli/` | The CLI runner and one file per command in `src/cli/commands/` |
| `src/hooks/` | Hook entry points; v0.1 has the SessionStart briefing |
| `plugins/claude-referee/` | What users install: the manifest, the committed bundle in `dist/`, `hooks/`, `skills/` and `packs/` |
| `test/` | `node:test` suites; `test/fake-jev.ts` stands in for the API |
| `scripts/` | The build and the private-terms check; maintainer tools such as `docs-watch.mjs`, `usage-report.mjs` (the four usage measures from your local data, counts only) `check-ui-firefox.mjs <light|dark>` (the dashboard in headless Firefox over WebDriver BiDi, synthetic data; exit 0 only when every check passes) and `verify-release.mjs <version>` (after a publish: the registry tarball's integrity and every file in it byte for byte against the git tag's `npm/` folder; exit 0 only when all match) |
| `assets/` | README, manifesto and social preview images, and the demo tape; see `assets/README.md` |

## The bundle is committed

`plugins/claude-referee/dist/` is built from `src/` and committed, so installs never need `node_modules`. After changing anything under `src/`, run `npm run build` and commit `dist/` in the same commit. CI rebuilds it and fails if the result differs.

## Code style

- TypeScript in strict mode, ES modules, no runtime dependencies besides the bundled TypeSafe SDK.
- Comments go at the top of a file only, at most five lines, saying what the file is for. No comments between lines of code; names and small functions carry the meaning.
- Everything printed for Claude is one short JSON line, decision first, and never echoes the input back. A command returns a result object and the runner in `src/cli/run.ts` prints it; commands never write to stdout themselves.
- Hooks fail open: any error means silence and exit code 0.

## Tests

- Every behaviour change comes with a test. Run a single file with `node --test test/redact.test.ts`.
- Redaction changes need a stop fixture for what should be caught and a keep fixture for the false positive it must not catch.
- Never commit a real secret, or a fake one that a scanner would flag. Build credential-shaped test values at run time; see `FAKE` in `test/helpers.ts`.
- Keep customer data, company names and internal paths out of fixtures.

## Packs

Questions and thresholds live in packs, not in code. A new pack or question:
1. goes under `plugins/claude-referee/packs/<name>/`, laid out as in [docs/configuration.md](docs/configuration.md#packs);
2. follows TypeSafe's question rules: one atomic question, criteria that say what yes and no mean, facts in the state rather than in the question;
3. says in the pull request how its thresholds were chosen. "Not tuned yet" is an honest answer and a fine start.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org), in English, one line, at most six words including the prefix, no body:

```text
feat: add pytest output parser
fix: keep version strings out of IP redaction
docs: explain the done-gate modes
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.

## Pull requests

- One topic per pull request.
- `npm run check` passes, and `dist/` is rebuilt if `src/` changed.
- Numbers you add to the docs are labelled measured or modelled, with their scope.
- The pull request template lists the rest.

## Where to start

Issues labelled `good first issue` are small and self-contained. [ROADMAP.md](ROADMAP.md) lists where help matters most.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.
