---
name: jev
description: Hand small, checkable judgements to TypeSafe Jev through the claude-referee CLI instead of judging them yourself. done checks test or lint output against criteria, decide scores 2-6 options against context files, judge runs one yes/no rule over many items, claims (old name verify) checks claims against a source. Use when a check's output decides "done", or when 20+ items need the same rule.
---

# claude-referee

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" <command>`. Every command prints one JSON line: `ok`, `verdict`, a few numbers, a `next_step` when there is one, and, for commands that ask Jev, a `receipt`. `<command> --describe` (or `--help`) prints a command's contract, and `--describe` alone lists the commands. `--dry-run` shows the redacted request without sending it.

## When Jev pays off

- A check decides whether the task is done. Let `done --run` run it, or pipe its whole output to `done` without reading it first.
- A choice between 2-6 options whose facts live in files. `decide` reads the files itself.
- One yes/no rule over many items. In the cost model this pays off from about 20 items that aren't in context yet, or about 50 that are (modelled, not measured).
- A single small judgement about text already in context doesn't pay off. Decide it yourself.

## Calls

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" done --run test
```

`--run` takes a family (test, typecheck, lint, build, check, ci, verify) or the exact command the project's manifest defines, runs it in the manifest folder and judges all of its output; it refuses anything else, exits 3 unless the verdict is `met`, and without `--criteria` asks the family's question. Prefer it to piping. Pipe only for a check it does not list:

```bash
npm test 2>&1 | node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" done --criteria "all tests pass" --evidence -
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" look --image after-save.png --criteria "a green confirmation that the changes were saved is visible"
```

`look` is experimental: PNG or JPEG, 256 to 1568 px a side, and the image goes to TypeSafe unredacted, so send only what the check needs.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" decide <<'EOF_JSON'
{"decision": "Where should rate-limit counters live?",
 "options": [{"name": "redis", "text": "Redis, already deployed"}, {"name": "memory", "text": "In-process LRU on each instance"}],
 "context_files": ["docs/adr/0007-scaling.md"]}
EOF_JSON
```

```bash
git diff -U0 --no-ext-diff | grep '^+[^+]' | node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" judge --question line.risky --context "<what the change is>" --items -
```

## Rules

- A weak or tie verdict is settled by adding the missing fact or narrowing the question, or by going with `lean` when the choice is easy to undo. Within 30 days an identical request is answered from the local cache, so asking again returns the same answer, and rewording until it passes is not evidence.
- Make evidence explicit. A command that prints nothing on success shows nothing; add its exit code to the output. `done` can return `met` only for output from a recognised runner or with an exit code line (`trust` in the result); anything else comes back `unsure`. On real CI logs `done` failed its registered bars (wrong `met` 2 of 85), so `met` is a hint, not proof.
- `met` with `trust: exit_code` proves only the exit status. Word criteria as what the output must show ("all tests pass, none skipped"), not as an exit status ("exits 0"), and pipe the runner's own summary.
- The exit line comes from the shell, never from you: `{ <check>; echo "exit code: $?"; } 2>&1 | ...`. After a pipe `$?` is the last command's status; use `$pipestatus[1]` in zsh or `${PIPESTATUS[0]}` in bash. `exit=0` is not read. Never type an exit line or a summary into the evidence, and pipe a saved log as it is.
- Run separate checks as separate `done` calls. In one combined log a check with no parser adds only its exit line, so Jev never sees its output. When a test or build runner is recognised and no linter is, only a linter's warning or error line (`file:line:col: warning ...`) or a linter summary with a count above 0 (`✖ 3 problems`, `Found 2 warnings`) caps a lint or clean criterion at `unsure` (`warning_in_log`); warnings in other shapes are not read. Once one linter's summary is recognised, another linter's warnings in the same log are not read either. Either way the lint criterion can still reach `met`. Only the first three exit lines reach Jev.
- Pass paths through `context_files` instead of retyping file contents.
- Input shaped like a credential stops the request. Remove it; don't work around it.
- The referee can be overruled. It answers narrow questions and stays silent below its thresholds.

TypeSafe facts, limits and data handling are in [references/core.md](references/core.md).
