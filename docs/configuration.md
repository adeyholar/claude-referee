# Configuration

claude-referee combines settings from four places. Each one overrides the ones before it:

1. **Plugin settings**, your defaults for every project
2. **The project file** `.claude/referee.json`, what this repository uses
3. **Your personal file** `.claude/referee.local.json`, your overrides for this repository
4. **Environment variables**

Two limits apply:
- The project and personal files can pick a pack and turn hooks on or off, but they can only make thresholds stricter. They can't set the key, the key command or `packs_dir`.
- The API key has its own lookup order, described [below](#the-api-key).

Hooks stay off in any project without a project file. `hooks_enabled: false` in the plugin settings or `REFEREE_HOOKS=off` in the environment turns every hook off, whatever the project file says.

## Where settings live

| Where | Who writes it | What it sets |
|---|---|---|
| `/plugin configure claude-referee`, or `claude plugin configure claude-referee --values-stdin` (Claude Code 2.1.285+) | You | `api_key` (stored by Claude Code as a sensitive value), `packs_dir`, `hooks_enabled`, `model` (default `jev-1.13.0`) |
| `.claude/referee.json` (commit it) | The repository | The pack, optional `areas`, which hooks run, stricter thresholds |
| `.claude/referee.local.json` (gitignore it) | You | Personal overrides, same schema as the project file; `hooks` and `thresholds` are merged key by key |
| Environment | You | See [environment variables](#environment-variables) |

## The project file

```json
{
  "pack": "generic",
  "areas": [
    {
      "prefix": "services/api/",
      "checks": ["cargo nextest run --profile ci", "cargo test --doc"],
      "evidence": ["target/nextest/ci/junit.xml"]
    },
    { "prefix": "web/", "checks": ["npx tsc --noEmit", "npx vitest run"] }
  ],
  "hooks": { "sessionStart": true, "stopGate": "shadow" }
}
```

`cargo nextest` doesn't run doctests, which is why the example lists `cargo test --doc` as a second check. The `evidence` path assumes JUnit output is turned on for the `ci` profile in `.config/nextest.toml`.

| Key | Values | Default |
|---|---|---|
| `pack` | A pack name from the plugin or from `packs_dir` | required |
| `areas` | Per path prefix: the check commands, evidence files (planned) and an optional pack | none |
| `thresholds` | Per-question overrides in the same shape as the pack's `thresholds.json`. They can only make a check stricter (for `stop.gate`'s `claims_verified` and `blocked`, which block when the value is *below* the threshold, that means a lower value). In `.claude/referee.local.json` they merge per question and key over the project file's, so the personal file overrides only the keys it names | the pack's |
| `hooks.sessionStart` | `true` or `false` | `true` |
| `hooks.stopGate` | `off`, `shadow` or `soft`; `active` is not built yet and runs as `shadow` | `off` |
| `hooks.preModelSwitch` | Read but not used: the cache guard was dropped, see [decisions](decisions/dropped.md) | `false` |

`areas` tells claude-referee which checks count as proof for which part of the repository. The session briefing shows only the area where the session started. When no area matches, it lists up to 4 checks detected from the nearest `package.json`, `composer.json` (or `artisan`), `Cargo.toml` or `go.mod`, from the working directory up to the project root, and marks them `(detected)`; if there is none, and exactly one immediate subdirectory of the root has them, they are listed as `cd <dir> && <command>`. Only script names are read, never script bodies, and several candidate subdirectories give nothing rather than a guess. A pack can ship default areas in `areas.json`; they apply only when the project file has no `areas`. Planned: an evidence file will count only if it changed after Claude's last edit, so a stale report is treated as no evidence.

### Done-gate modes

The done-gate looks at a stop only when Claude edited files and no check passed after the last edit. It then asks Jev whether Claude claimed success it didn't verify.

- **`off`**: nothing runs.
- **`soft`**: records exactly like `shadow`, and when Jev would block it also prints one `systemMessage`, a warning shown to you in the transcript. It never blocks, never sets an error exit code and gives Claude no context, so Claude's behaviour does not change. It is not recommended before labelled stops show a false-block rate you accept.
- **`shadow`**: asks Jev and records the decision in `stops.jsonl` in the data directory (your labels go to `labels.jsonl` next to it, so labelling never rewrites the stops), but never blocks and prints nothing. It records the turns it skipped and why (no edits, a passing check after the last edit, `stop_hook_active`, background tasks, circuit breaker open). While background tasks run it still asks nothing and records `background_tasks`, but it reads the transcript as for any other stop: the record carries the turn's `edits`, `checks` and marks, `bg_pending` (how many background tasks the Stop event listed) and `would_ask` (whether the code-side rule, edits and no passing check after the last edit, would have asked Jev had no background task been running; the key and the pack are not checked). When the transcript cannot be read, that record keeps `edits` 0 and `checks` 0 and has no `would_ask`, as before. So does a stop whose turn, with the turn before it, spans more than 8 million characters (about 8 MB), though it still has `turn`: the analysis grows with the checks in the turn, up to about 135 ms per MB in a local measurement, and the Stop hook has 10 seconds. Each record whose transcript was read also has `turn` (none when the transcript has no real prompt), 12 hex characters of a hash of the turn's prompt uuid (of that line's position in the transcript and the session id when the entry has none), never the prompt text; the stops of one turn share it, so a turn that stopped several times can be counted once. A `stop_hook_active` record reads the transcript for `turn` only, and a `no_transcript` record has none; records written before this have no `turn`, `bg_pending` or `would_ask`. When Jev could not be asked, the record says why and keeps the error code in `error`: `jev_error` (Jev failed or timed out, such as `service_unavailable` or `rate_limited`), `credential` (redaction stopped the request, nothing was sent), `no_key` (no usable API key) or `config_error` (the project's pack does not load or lacks the `stop.*` questions; `doctor` names the cause). A project file that does not load is not recorded, since the mode cannot be read from it; `doctor` reports it as `project_error`. Only `jev_error` and `breaker_open` count as Jev errors in `error_rate`. A failed Jev call or a stopped request also writes a receipt with the error code; as in the CLI, its `requests` counts answered calls only, so it is 0 even when the call reached Jev. An edit Claude Code refused before applying it (a denial, or a tool error such as "String to replace not found") is not counted as an edit, and a prompt that is only a pasted image starts a new turn. Past 2 MB, `stops.jsonl` drops records older than 90 days at most about once a day, and records other sessions append meanwhile are kept (one that ends up stored twice is read and counted once). `claude-referee receipts --stops` lists the decisions with precision and false-block figures; `--unlabelled` shows the ones to review, and `--label <id> --right` or `--wrong` marks one. A command Claude Code refused to run (a permission or hook denial such as "This command requires approval") is sent to Jev as `denied`, meaning it did not run: it is neither a pass nor a failure, never counts as a passing check and never makes the stop skip. A check whose output Claude Code cut (a saved-to-file preview, a `... [N lines truncated] ...` gap, a command moved to the background) never counts as a passing check, so such a turn is asked about. The record also carries code-side marks when they apply, never sent to Jev: `truncated_checks`, `subagent_calls`, `subagent_reports` (a subagent or background task finished during the turn) and `stale_pass` (the previous turn had a passing check, this turn edited and has none). The record keeps the first 200 characters of the prompt and of the final message on your machine to help you label. For an unlabelled stop, `--stops` may also show `suggestion: {label: "right", reason}`, a hint read from your next prompt in the session transcript (`reported_broken` or `repeated_request`; a prompt that is only a pasted image is skipped); it is never stored, never counted and never replaces your label. The transcript is found by the stop's session id: first in this project's transcript folders, then in any folder of Claude Code's projects directory (`projects` under `CLAUDE_CONFIG_DIR`, or `~/.claude`), because Claude Code keeps a transcript in the folder of the directory where the session started, while a stop is recorded under the project the session was in when it stopped. That second look lists the projects directory once per call and checks the 1,000 most recently changed folders for at most 50 sessions per call. `claude-referee receipts --session <id>`, or `--session current` from Claude Code, joins one session across every project id it wrote under (a session that changed directory, or ran commands in a worktree or a scratch folder, writes under several): its receipts per command and verdict, its stops, and whether its transcript was found with its line count, never its path or text. CLI receipts carry the session only when the command ran inside Claude Code; CLI receipts written before they carried it have none and are not backfilled. Claude Code's [environment variable reference](https://code.claude.com/docs/en/env-vars) says the id that Bash commands and hook commands get matches the `session_id` in the hook input, follows `/clear` and is the resumed id after `--resume <id>`. The initial startup id it mentions for `--continue`, or `--resume` without an id, is said of MCP server subprocesses; claude-referee runs as a command, not as an MCP server. With at least 10 labels of each class, `--stops` adds `threshold_suggestion`: exact (Clopper-Pearson) 95% intervals and, if one exists, the smallest `claims_done` at or above the current value whose labelled stops have a precision lower bound of 0.8 or more. It only ever suggests raising the threshold and changes nothing itself.
- **`active`** (not built yet): set today, it runs as `shadow`, each record carries `configured: "active"` and `doctor` says so. When built: when Jev says the claim is unverified, the stop is blocked and Claude gets a note of at most 300 characters naming the area's check command. It blocks at most three times per session, with a 60-second cool-down.

`active` isn't recommended until shadow mode has at least 50 labelled stops with a precision of at least 0.8 and no more than 5% false blocks. It must also let through no more false "done" claims than Claude Code's built-in `/goal`, at a lower total cost. Both modes send the data listed in [privacy](privacy.md).

The gate is a reminder, not a judge: it flags success claims that have no counted check, and it has not been shown to separate wrong work from right. `active` is not recommended, and `soft` is useful only if you accept a warning under most success claims. What the numbers say about the two modes. On the [hard-task study](measurements.md#the-stop-gate-on-hard-tasks-wrong-done-study) (76 sessions of 32 traps we wrote, 15 wrong "done" claims) the gate blocked 14 of 15 wrong dones and also 51 of 53 correct ones, so a block is right 21% of the time on that mix (14 of 65, 12% to 34%). `claims_verified` did not tell wrong from right (AUC 0.40). So `shadow` records what Jev would do and costs you nothing in behaviour; `soft` would put a warning under about every success claim that has no counted check, most of them on correct work. Treat a warning as "no check I recognise ran", not as "this is wrong". The mix is synthetic and says nothing about the rate on your project: label your own stops (`receipts --stops`) before you rely on either mode. Latency is not a concern (p95 631 ms, no Jev errors in 72 asked stops).

The one measurement before it is a [self-generated study](measurements.md#the-stop-gate-on-self-generated-sessions-base-rate-study) of 119 sessions on seeded tasks: 1 wrong "done" in 100 asked stops, so the registered kill criterion fires and `active` is not recommended, and the gate would have blocked all 100 asked stops, 99 of them on correct work (Claude had not run a check the analyser counts). On that mix `soft` would have warned on every success claim without a counted passing check. Plainly: the gate flags success claims that have no counted check, not wrong work. It blocked nearly every success claim in the study (99 of 99 correct ones that were asked), so `soft` is noisy. Own-code runs such as `node -e` or heredocs are not counted, and changing that was considered and not adopted ([decision](decisions/stop-check-detection.md)). Real projects are unmeasured; label your own stops before you rely on either mode.

## The API key

claude-referee looks for the key in this order:
1. The plugin setting
2. `TYPESAFE_API_KEY`
3. `EVAL_TYPESAFE_API_KEY`
4. `TYPESAFE_API_KEY_CMD`
5. The macOS Keychain item `TYPESAFE_API_KEY`

Claude Code passes plugin secrets to hooks but not to the shell, so the commands Claude runs need one of the other sources. The Keychain and `TYPESAFE_API_KEY_CMD` work for both:

```bash
# macOS: prompts for the key, so it stays out of your shell history
security add-generic-password -a "$USER" -s TYPESAFE_API_KEY -w

# Linux (Secret Service, not yet tested): store it once...
secret-tool store --label="TypeSafe API key" service typesafe
# ...then add this line to your shell profile, so Claude Code inherits it
export TYPESAFE_API_KEY_CMD="secret-tool lookup service typesafe"
```

`TYPESAFE_API_KEY_CMD` is:
- read only from your environment, never from a project file
- run without a shell, so it must be a single command that prints only the key
- run at most once per process, with a 5-second timeout

claude-referee trims the key and rejects it with a configuration error if it contains spaces, control characters or non-ASCII characters. `npx claude-referee doctor` shows which source provided the key, never the key itself.

## Environment variables

| Variable | What it does |
|---|---|
| `TYPESAFE_API_KEY` | The API key |
| `EVAL_TYPESAFE_API_KEY` | The API key for evals and `claude plugin eval` runs, which pass on only a fixed allowlist and `EVAL_*` variables |
| `TYPESAFE_API_KEY_CMD` | A command that prints the key |
| `TYPESAFE_MODEL` | Overrides the `model` setting. The pack's thresholds were tuned on the default model |
| `TYPESAFE_BASE_URL` | The API root, `https://api.typesafe.ai` by default. For proxies and tests |
| `REFEREE_BASE_URL_KEY` | The key for a `TYPESAFE_BASE_URL` that isn't `https://api.typesafe.ai`. Without it no request is sent: the TypeSafe key never goes to another host |
| `REFEREE_HOOKS=off` | Turns every hook off |
| `CLAUDE_CODE_SESSION_ID` | Set by Claude Code for the commands it runs, never by claude-referee. A CLI receipt records it as `session_id` when it is 1 to 64 letters, digits, `.`, `_` or `-`, and `receipts --session current` reads it |
| `REFEREE_DATA_DIR`, `REFEREE_PACKS_DIR`, `REFEREE_PACK`, `REFEREE_MODEL` | Set for you. The session briefing hook exports them to Claude's shell through `CLAUDE_ENV_FILE`, so the commands Claude runs use the same data directory, pack and `model` setting as the hooks. `TYPESAFE_MODEL` still wins over `REFEREE_MODEL`. It never exports the key |

Outside Claude Code, the CLI works out the default data directory itself. Pass `--data-dir` to use another one.

## Packs

Questions and thresholds live in packs, not in code. A pack is a directory of data files:

```text
my-pack/
├── pack.json          name, version, the Jev model it was tuned on, optional "extends"
├── questions/*.json   the questions
├── thresholds.json    thresholds by question ID or group, each with named keys (below)
├── cheatsheet/*.md    optional: session.md is the session briefing text
├── redact.json        optional: extra redaction patterns
└── areas.json         optional: default areas, used when the project file has none
```

A question file maps question IDs to questions:

```json
{
  "done.met": {
    "type": "noul",
    "instructions": {
      "question": "Does `evidence` show that `criterion` holds?",
      "note": "A claim of success in prose is not evidence."
    },
    "criteria": {
      "true": "The check output directly shows that the criterion holds.",
      "false": "The output does not show it, or shows that it fails."
    }
  }
}
```

The matching entry in `thresholds.json`:

```json
{ "done.met": { "met": 0.7, "missing": 0.5 } }
```

The commands read these groups and keys; the value in brackets is the `generic` pack's, which is also the value used when a pack leaves the key out:

| Group | Keys | Read by |
|---|---|---|
| `done.met` | `met` (0.7), `missing` (0.5) | `done` |
| `decide.best`, `decide.fit` | `clear` (0.85), `margin` (0.1) | `decide`; `decide.fit` when the options don't fit one request |
| each `judge` question: `line.risky`, `failure.env`, `string.translatable` (i18n pack) | `auto` (0.9) | `judge` |
| `audit.pushback` | `auto` (0.9) | `audit --ask` |
| `verify.relation` | `supports` (0.8), `contradicts` (0.5), `says_nothing` (0.5) | `claims` |
| `verify.injection` | `flag` (0.7) | `claims` |
| `stop.gate`, one group for the four `stop.*` questions (a key under `stop.claims_done` is not read) | `claims_done` (0.7), `verification_applies` (0.5), `claims_verified` (0.5), `blocked` (0.4) | the done-gate, `receipts --stops` and the dashboard (`claims_done`, for the threshold suggestion) |
| `decide.micro.<id>` | `bad`: 1 means a yes is bad | `decide`, from the pack's file only |

`thresholds` in `.claude/referee.json` or `.claude/referee.local.json` use the same groups and keys. A value there is used only when it is higher than the pack's (at most 1), except `claims_verified` and `blocked` under `stop.gate`, where it is used only when it is lower (at least 0). The personal file's values merge per group and key over the project file's.

Where the bundled numbers come from: `done.met`'s 0.7 and 0.5 were chosen on 25 cases in the earlier private kit, so they're in-sample. `done` v2 has not been measured on its original bar; on unseen real CI logs it failed its registered bars (wrong `met` 2 of 85, `met` recall among parsed logs 0.873; [result](measurements-real-logs-2.md)), so treat the thresholds as untuned defaults. `verify.relation` (supports 0.8, contradicts and says nothing 0.5) and `verify.injection` (0.7) were set by hand and checked once on 60 held-out claims. A replay of the recorded answers found nothing to tune: see [verify v2](measurements.md#verify-v2-on-held-out-claims). The 0.9 bands for `judge` follow the kit's rule of acting only at 0.90 or above. `line.risky` and `failure.env` were checked once on 62 invented cases each with no wrong `yes` at the 0.9 band, but only 52% and 81% of hold-out cases got a definite answer ([result](measurements.md#judge-on-invented-lines-and-logs)).

`cheatsheet/session.md` may use three placeholders: `{{pack}}`, `{{cli}}` (the absolute path of the bundled CLI) and `{{checks}}` (the area's check commands, or the detected ones). The briefing is capped at 800 characters.

`redact.json` adds patterns; it can never remove the built-in ones:

```json
{
  "stop": [{ "kind": "internal_token", "pattern": "\\bitk_[A-Za-z0-9]{24,}" }],
  "replace": [{ "kind": "account_id", "pattern": "\\bacct_[0-9]{8}\\b" }]
}
```

A pattern may carry `flags`, such as `"i"`. The `g` and `y` flags are ignored, so a pattern is checked against every field from the start.

Packs are data only; claude-referee never runs code from a pack.

The `generic` pack has these 12 questions: `done.met`, `verify.relation`, `verify.injection`, `decide.best`, `decide.fit`, for `judge` `line.risky` and `failure.env`, for `audit --ask` `audit.pushback`, and for the done-gate `stop.claims_done`, `stop.claims_verified`, `stop.verification_applies` and `stop.outcome`. A pack used with `hooks.stopGate` needs the four `stop.*` questions, its own or through `"extends": "generic"`; without them the gate records `config_error`.

The `i18n` pack extends `generic` and adds `string.translatable` for `judge`: see [the i18n recipe](recipes/i18n.md).

The `generic` pack ships with the plugin. Your team's packs can live in a private repository. To use them:
1. Point `packs_dir` at that repository.
2. Name the pack in `.claude/referee.json`.

`npx claude-referee lint-pack <path>` checks a pack against TypeSafe's question-writing rules.

## Always-on cost

While claude-referee is enabled, its skill listing adds at most 250 tokens to every session, even in projects without `.claude/referee.json`. Each release is checked against that limit. Hooks start a short Node process at the events they handle. `claude plugin details claude-referee` shows the always-on token count.

## Update and uninstall

- **Update:** third-party marketplaces don't auto-update by default. Run `claude plugin marketplace update claude-referee`, then `claude plugin update claude-referee@claude-referee`. You can also turn on auto-update for the marketplace in `/plugin` → **Marketplaces**.
- **Export receipts:** `npx claude-referee receipts export --out receipts.jsonl`.
- **Check or void receipts:** `receipts verify` checks the hash chain; `receipts overrule <id>` voids one decision and deletes the cached answers it used.
- **Uninstall:** `claude plugin uninstall claude-referee@claude-referee` deletes claude-referee's data directory, including receipts and the cache, unless you add `--keep-data`.

## Troubleshooting

- **Hooks stay silent but `doctor` works in your terminal.** Claude Code probably can't find Node 20.3 or later on its own `PATH`. That happens most often when Claude Code is launched from a desktop app instead of a shell.
- **`doctor` finds no key, but hooks work.** The key is stored only as a plugin setting, which reaches hooks but not the shell. Add the Keychain item or `TYPESAFE_API_KEY_CMD`.
- **`npx claude-referee` and Claude disagree.** `npx claude-referee` runs the copy published to npm, while Claude runs the copy bundled with the plugin. Run `npx claude-referee@<version>` with the plugin's version, which `/plugin` shows, to match them.
