# What leaves your machine

claude-referee sends TypeSafe only what a judgement needs. Before anything goes out, it stops requests that contain something shaped like a secret, replaces personal details and caps the size of every field. Every command that calls Jev can show you its request first. Receipts and the answer cache stay on your machine, and your API key goes only to TypeSafe, as the credential on each request.

## Sent to TypeSafe

Requests go to `api.typesafe.ai`. TypeSafe's [privacy policy](https://typesafe.ai/legal/privacy-policy) says the service is hosted in the US.

| When | What is sent |
|---|---|
| Every call | The pack's question text and the input it asks about |
| `done` | Your criterion and the output you pipe in (with `--run`, the output of the project's detected check, which runs on your machine with no TypeSafe key variables in its environment; only a check found in your manifest runs, never an arbitrary command). Output from a runner claude-referee has a parser for is parsed in code and only the counts, exit code, failing test names and the matched summary and exit-code lines are sent, and, when the log has only an exit code, up to three echoed command lines (`$ cmd` or `> cmd`, 80 characters each, only when the command's first word is a known check tool such as `tsc`, `eslint`, `npm` or `cargo`, and none when the command hides or tolerates its output); any other output is sent as text, its first 2,000 and last 12,000 characters |
| `decide` | The decision, any inline `context`, the option texts and the contents of your `context_files`. The choice is asked twice, in two option orders, and in up to 2n orders (n options) when those two tie |
| `judge` and `verify` | The items, claims and source text you pass in |
| `look` (experimental) | Your criteria and the image files you name with `--image` (PNG or JPEG, at most 4), **unredacted**: pixels cannot be redacted, so a screenshot can show a key, an email or a name. Sent with TypeSafe's `TypeSafe-Danger-Zone-Images` header. `--dry-run` prints only each image's size, hash and dimensions. The cache keeps the answers, never the image |
| `audit --ask` (opt-in; plain `audit` sends nothing) | For each edit turn in the folders you name with `--project`: the same fields as the done-gate (the first 1,500 characters of the session's first prompt, the last 2,000 characters of Claude's final message, the check commands with their status, the edited paths) when no passing check ran, plus, for every such turn, the last 1,000 characters of Claude's final message and the first 600 characters of your next prompt. At most 300 turns per run; `--dry-run` shows every request first; `--skip <file>` drops turns that match your own patterns |
| Done-gate in shadow mode (also in every git repository when `REFEREE_DEFAULT_PROJECT` is set) | Each time Claude stops after editing without a passing check: the first 1,500 characters of your prompt, the last 2,000 characters of Claude's final message, the check commands with their pass/fail status, and the paths of the files Claude edited, without their contents |

The prompt and Claude's final message are free text. Patterns can't reliably clean free text, so keep the done-gate off where session text may not leave your machine.

The session briefing never calls the network.

## Check before sending

Add `--dry-run` to any command that calls Jev. claude-referee prints the redacted input and a token estimate. Nothing goes over the network, and nothing is cached or logged:

```bash
cargo test 2>&1 | npx claude-referee done --criteria "all tests pass" --evidence - --dry-run
```

If the input contains something shaped like a secret, the dry run stops with the same error the real command would give.

The done-gate has no preview. While it's on, in shadow mode too, it sends what the table above lists.

## Stopped before sending

A request that contains any of these is not sent at all:

- AWS access keys
- GitHub, GitLab, Slack (tokens and webhook URLs), Anthropic, OpenAI and TypeSafe API tokens
- Stripe live keys, npm, PyPI, Hugging Face, SendGrid and Google API keys, Telegram bot tokens, Azure storage account keys and Docker registry auth entries (which formats and why: [decision record](decisions/redaction-patterns.md))
- JWTs and private key blocks (PEM, OpenSSH, PGP, PuTTY)
- Credentials in connection strings (`://user:password@`)
- Assignments whose names contain KEY, TOKEN, SECRET or PASSWORD, when the value looks like a secret rather than a type name, a translation key, a pagination token, an SSH algorithm name or another identifier

Values and object keys are both checked. Packs can add stop patterns in `redact.json`.

A command with a single input exits with code 1 and the error `credential_in_state`. A batch command skips that item, reports it and carries on. The error names the kind of value and the field it was in, never the value itself.

## Replaced before sending

- Email addresses
- IP addresses, but not four-part version numbers
- Your home directory, which becomes `~`
- UUIDs, added by the `generic` pack

Each replaced value becomes `[REDACTED:<kind>]`. Packs can add patterns, such as account IDs, but never remove the built-in ones. Each receipt records how many values were stopped or replaced, never which.

Redaction is pattern-based. It can miss a secret in an unusual format, and it can't find sensitive details written as prose, such as a customer's name in your prompt. Use `--dry-run` when you're unsure, and keep customer data out of anything claude-referee reads.

## Stays on your machine

claude-referee's data directory holds:
- **Receipts:** one line per command run. A receipt holds exactly these fields, each only when it applies: `id`, `ts`, `command` (`verify`, the old name of `claims`, is recorded and counted as `claims`), `project` (a hash of the repository path), `worktree` (the kind of checkout the command ran in: `main`, `linked`, `claude-worktree` or `no-checkout`; a fixed word, never a path; receipts written before this field have none), `pack`, `model`, `verdict`, `reason` (a fixed code such as `exit_code_nonzero`), `outcome`, `error` (the error code), `requests`, `cached`, `input_tokens`, `cost_usd`, `request_ids`, `qhash` (a hash of the questions), `cache_keys` (hashes), `prev` (the hash of the previous receipt), `fresh`, `stopped` and `replaced` (redaction counts), `chars` (the size of the session briefing), `ms`, `run_id` (from `EVAL_RUN_ID`) and `session_id`: the Claude Code session's id, an opaque id that Claude Code already writes in its own transcripts and file names, never a path. Hook receipts take it from the hook's input. CLI receipts take it from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for the commands it runs, and only when it is 1 to 64 letters, digits, `.`, `_` or `-`; outside Claude Code they have none. CLI receipts written before they carried it have none and are not backfilled. `outcome` holds numbers and fixed codes copied from the result, never text: for `done` the `trust` (`parsed`, `exit_code` or `unparsed`), `p`, `exit_code`, `evidence_lines` (how many lines the evidence had) and `runners`, the names of the recognised runners (such as `node:test` or `tsc`, at most 8); for `decide` `lean_p`, `margin` (to the second option) and `orders`, but never the option name, since you write it; for `claims` `claims` (the number of claims), `supported`, `unsupported`, `contradicted`, `says_nothing`, `unsure` and `unanswered`, and `reasons`, how many claims got each reason code (`between_bands`, `contradicted`, `number_not_in_source` and the like, at most 12 codes); for `judge` `items`, `yes`, `no` and `review`. A command that asks Jev and fails after it was given input (one of its own options, or input on stdin that it read) still writes a receipt with its error code and `requests` 0: a bad input, a missing or invalid key, a pack or project that does not load, an input that is too large. `--describe`, `--help`, `--dry-run`, an unknown command or flag, a call that names none of the command's own options and whose stdin was not read (such as `done help`, or a log piped to `done` without `--criteria`), and commands that never ask Jev write none. Planned: done-gate receipts will also note assertions removed from test files and new skip markers, as counts and file paths only. Today receipts hold no request text, criteria, claim text or claim ids, option names, items, file paths or user names.
- **Local evidence (opt-in, off by default):** only when `REFEREE_KEEP_EVIDENCE=1` is set for a `done` run, its criteria and evidence are stored, redacted the same way as the Jev request, in `evidence/<receipt id>.json` under the data directory (mode 0600). Records older than 14 days are removed when a new one is written. `receipts --show-evidence` prints one to your terminal; `receipts --evidence-queue` lists the stored, unlabelled receipts by id, time, verdict, p, trust and runner names only; `receipts --label-receipt` appends your right or wrong label to `receipt-labels.jsonl`. Nothing here is sent anywhere.
- **The answer cache:** Jev's answers, keyed by the pack version, the model and hashes of the question and the redacted input, one file per request in `cache/`. An entry older than 30 days is no longer used: the same question goes to Jev again, and the new answer overwrites the file. Old files are not deleted on a schedule; one stays on disk until `receipts overrule` voids a run that used it, you delete the `cache/` directory yourself, or uninstalling removes the data directory. `--fresh` skips reading the cache; the new answer is still written.
- **Done-gate stops and labels:** `stops.jsonl` and `labels.jsonl` (excerpts, scores, your labels, an error code such as `rate_limited` when Jev could not be asked, the turn's edit and check counts and code-side marks, `turn`, a 12-character hash of the turn's prompt uuid, or of its position and the session id already in the record, that holds no prompt text, and on a stop skipped while background tasks ran, `bg_pending`, a count, and `would_ask`, true or false). `receipts --stops` also reads your own Claude Code transcript on your machine to hint at a label from your next prompt; it keeps and prints only a fixed reason (`reported_broken` or `repeated_request`), never the prompt text, and sends nothing anywhere. It finds the transcript by the stop's session id, in this project's transcript folders or else in any folder of Claude Code's projects directory, because a transcript stays in the folder of the directory where the session started. `receipts --session` looks the transcript up the same way and prints only whether it was found and its line count, never its path or text.
- **Results files:** the details of verdicts longer than 1,500 characters, such as per-item scores from `judge`.
- **Audit reports:** `audit-<time>.json` (and `audit-compare-<time>.json` with `--compare`, the same counts for two windows) in the results folder, written by `claude-referee audit`: counts per project folder (a 12-hex hash of the folder name, or the name with `--names`), no prompt, message or path text. `audit` reads your Claude Code transcripts on your machine, asks Jev nothing and sends nothing.
- **Circuit breaker:** `breaker/`, one small file per Claude Code session whose hook calls to Jev failed, named by a hash of the session ID and holding only a failure count and a time. It is deleted after the next success and pruned after a day.

When claude-referee is installed as `claude-referee@claude-referee`, the data directory is `~/.claude/plugins/data/claude-referee-claude-referee/`. Receipts are grouped under a hash of the repository path, never the path itself. `npx claude-referee doctor` shows where the directory is and how big it has grown. Uninstalling deletes it unless you add `--keep-data`.

claude-referee never writes your API key anywhere: not to `CLAUDE_ENV_FILE`, receipts, the cache, tool output or project files.

## The dashboard

`npx claude-referee ui` serves a page from your own machine on 127.0.0.1 behind a random token. It makes no network call out, loads nothing from other hosts and sends no telemetry. Its first tab, Flow, lists this project's calls and done-gate stops, newest first: the command, how many requests went to Jev or which answers came from the cache, the verdict and the receipt's outcome numbers and codes, and on demand Jev's stored answer to each question (at most 12 stored answers per call and 600 per page; an answer older than 30 days counts as gone, as it does for the cache). It reads the receipts, the answer cache and `stops.jsonl` and stores nothing new; the text that was sent to Jev is not shown, because it is never stored. It shows stop excerpts, so keep the URL it prints to yourself; the threats and defences are in [docs/decisions/ui-security.md](decisions/ui-security.md).

## Retention

TypeSafe's [privacy policy](https://typesafe.ai/legal/privacy-policy) (updated November 19, 2025) says TypeSafe won't train or fine-tune models on your input. Its [data processing addendum](https://typesafe.ai/legal/data-processing) (updated April 24, 2026) keeps customer personal data "for as long as necessary", with no fixed period. Zero data retention is available to enterprise customers; see TypeSafe's [legal page](https://docs.typesafe.ai/legal.md). Check the current versions before you rely on them.

Don't send customer data. Check your employer's policy before using claude-referee on work code.
