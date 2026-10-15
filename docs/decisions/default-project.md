# `REFEREE_DEFAULT_PROJECT`: on in every git repository without a file in each one

Registered 2026-10-15, before the code. The maintainer asked for claude-referee to run always ("claude-referee çalışsın hep"), and the first way it was done (a line in the global CLAUDE.md telling Claude to create `.claude/referee.json` and append it to `.git/info/exclude` in each project) made a session write files into repositories. An environment variable does the same without touching a repository.

## Change

`REFEREE_DEFAULT_PROJECT=shadow` or `soft` (anything else, including `active`, is off). In a directory with no `.claude/referee.json` above it, but inside a git repository (a `.git` entry above the working directory), the hooks and the CLI treat the project as `{"pack": "generic", "hooks": {"sessionStart": true, "stopGate": "<mode>"}}` with the repository root as its root. A project file always wins, whatever it says (including `"stopGate": "off"`, which is how one repository opts out). Outside a git repository nothing turns on. `doctor` prints `(default: shadow)` in `project`.

## What it switches on, stated plainly

The session briefing (no network) and the Stop gate in `shadow` mode (or `soft`) in **every** git repository you open. The Stop gate sends, when Claude stops after editing without a passing check, the first 1,500 characters of your prompt, the last 2,000 characters of Claude's final message, the check commands with their status and the edited file paths (no contents) to TypeSafe ([privacy.md](../privacy.md)). Set it only if every repository you open may send that. The variable is not set by default and nothing in the package sets it.

## Bars

- **B1:** with the variable unset, empty, `active`, `on`, `off` or `1`, no project is found without a file; with `shadow` or `soft` (case and spaces ignored) a project is found from any directory inside a git repository, rooted at the repository; a file wins; no git repository above means none.
- **B2:** the session briefing runs in a default project and in none of the other cases.
- **B3:** `doctor` names the default; `ci:local` green.

## Not covered

Worktrees whose `.git` is a file count as repositories (any `.git` entry does). Per-repository thresholds, areas and pack choice still need a file. The Stop gate's skips and shadow records are unchanged.
