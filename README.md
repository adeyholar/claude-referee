<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.gif">
    <img alt="claude-referee: evidence over eloquence. Claude says all tests pass; the referee's done-gate (active mode, planned) replies that no check has passed since the last edit and asks Claude to run cargo nextest, which shows 2 failures." src="assets/hero-light.gif" width="100%">
  </picture>
</p>

<p align="center">
  An unofficial Claude Code plugin that checks "done" claims and small judgement calls with TypeSafe Jev, and keeps receipts.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#whats-measured-so-far">What's measured</a> ·
  <a href="#what-it-costs">What it costs</a> ·
  <a href="MANIFESTO.md">Manifesto</a> (<a href="MANIFESTO.tr.md">Türkçe</a>) ·
  <a href="docs/measurements.md">Measurements</a> ·
  <a href="README.tr.md">Türkçe</a>
</p>

<!-- Demo: record it with `vhs assets/demo.tape` (keep it under 2 MB; `gifsicle -O3` if needed) and uncomment.
<p align="center"><img src="assets/demo.gif" alt="claude-referee demo in a terminal" width="100%"></p>
-->

---

Coding agents write well. "All tests pass. Done." is one fluent line, and it costs nothing to write. Checking it takes a test run, and if the line is wrong, someone finds out later.

claude-referee is an unofficial plugin for Claude Code that checks lines like that. Claude still makes the big decisions. Small questions that can be checked, such as *is it really done?* or *which of these options fits our rules?*, go to Jev: a model from TypeSafe that answers with a probability, like "0.97 yes", instead of a paragraph. Every check is logged on your machine.

## What it does

<!-- Keep the Release column honest: nothing is marked v0.1 unless v0.1 ships it. Check before tagging. -->

| When | What happens | Release |
|---|---|---|
| **You or Claude run a command** | `done`, `decide`, `judge` or `claims` (the old name `verify` still works) asks Jev and prints a one-line answer | v0.1 |
| **A session starts** | Claude gets a short note, at most 800 characters, on how to use the commands | v0.1 |
| **Claude stops** | Off by default. In `shadow` mode it only records what it would have done (`receipts --stops`); `soft` adds a warning without an error (since v0.2.0). The planned `active` mode blocks a stop when Jev says Claude's "done" is unverified, with a note naming the check to run, at most three times a session. If Jev is slow or down, the hook fails open | `shadow` since v0.1.3, `soft` since v0.2.0; `active` planned, [not recommended yet](docs/measurements.md#the-stop-gate-on-self-generated-sessions-base-rate-study) |

If a check finds nothing, Claude sees nothing. If it finds something, Claude sees a note of 300 characters at most.

Why not just a command? In the kit that came before claude-referee, Claude could run the `done` check whenever it liked, and it ran once in 14 days. A check that doesn't run by itself barely exists. That's why there is a check that runs every time Claude stops; today it records what it would do, and in `soft` mode also warns you when it would have blocked. The Stop gate is a reminder that no counted check ran, not a measured judge of wrong work, and `active` is not recommended (see [what's measured](#whats-measured-so-far)).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-it-works-dark.gif">
  <img alt="Claude Code sends hook events and CLI calls to claude-referee on your machine. It parses evidence in code, stops secrets and redacts personal data, then batches the questions into one request to the TypeSafe Jev API. Jev returns probabilities; the referee thresholds them into silence, a short note or a JSON verdict." src="assets/how-it-works-light.gif" width="100%">
</picture>

1. Something happens in Claude Code: a session starts, or Claude runs one of the commands.
2. claude-referee runs on your machine. It stops anything that looks like a password or key, replaces emails and IP addresses, and turns the question into one small request.
3. Jev answers with probabilities.
4. claude-referee compares them with fixed thresholds. It stays silent, adds a short note, or prints a one-line JSON result.

If plain code can answer a question, no model is asked. The diagram shows the full design: the session note, the four commands, reading test output in code and the stop check in `shadow` and `soft` mode work today, and blocking a stop (`active`) is planned ([roadmap](ROADMAP.md)); the model-switch warning was dropped because Claude Code already asks.

## What's measured so far

In short: the order of the options changes Jev's answer more than asking again does, and the real cost of a check is Claude's time, not Jev's.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/status-board-dark.png">
  <img alt="Status board. Measured: option order moves Jev's pick (up to 0.52); asking again barely does (0.01); two orders match all 24 (20/20); the briefing fits in 600 characters. Modelled: one small judgement usually loses money; batches break even at about 23 items (80K context). Not shown yet: lower total cost per task; done-gate precision on 50 labelled stops; held-out accuracy for the done check." src="assets/charts/status-board-light.png" width="100%">
</picture>

Most numbers here come from one private codebase, one team and one author: the kit that came before claude-referee, in September 2026. Treat them as early signs, not general results. The rows dated 2026-09-30 and later were measured with claude-referee itself, on public or invented inputs. The scripts are in this repository, and for most rows the scored results too; the text of the real CI logs and the raw session transcripts are not. How each one was measured is in [docs/measurements.md](docs/measurements.md); four later studies have their own pages: [option orders](docs/measurements-decide-order-scale.md), [the Stop gate with the edit contents](docs/measurements-stop-state.md) and [without them](docs/measurements-stop-requirements.md), and [the held-back real logs](docs/measurements-real-logs-3.md).

### Option order moves the answer. Asking again doesn't.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/order-vs-retry-dark.png">
  <img alt="Horizontal bars on a 0 to 0.6 axis. Same request asked again: at most 0.01. Fresh re-run with the cache bypassed: at most 0.02. Options reordered: 0.20 on average, at most 0.52. Measured on 20 real 4-option decisions from one private codebase, 24 orders each." src="assets/charts/order-vs-retry-light.png" width="100%">
</picture>

In the earlier kit, when the same options were listed in a different order, Jev's probability for one option moved by up to 0.52. Asking the exact same question again moved it by 0.01 at most. So `decide` asks every choice twice, once in your order and once reversed, and averages the two; when those two tie and there are 3 to 6 options, it also asks the other balanced orders (below). It never tells Claude to simply ask again: a tie is settled by adding the missing fact. On claude-referee's own public set of 20 decisions, 19 of them with a leader at 0.9 or more, order moved it by up to 0.13 and asking again by up to 0.04. On a pre-registered set of 39 close-call decisions, order moved it by 0.26 on average and up to 0.42, and the reversed order brought the answer closer to the all-orders answer than asking the written order twice did.

### Two orders are enough

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/policies-compare-dark.png">
  <img alt="Five ordering policies compared by Jev requests per decision and by how many of 20 decisions matched the all-orders leader. Written order only: 1 request, 18 of 20. Written plus reversed: 2 requests, 20 of 20. Four rotations: 4 requests, 19 of 20. Two orders, all 24 if unsure: 10.8 requests on average, 20 of 20. All 24 orders: 24 requests, the reference." src="assets/charts/policies-compare-light.png" width="100%">
</picture>

Asking in your order and in reverse picked the same winner as trying all 24 orders, in 20 of 20 decisions, with 2 requests instead of 24. Near ties are the exception: in a later study of 252 decisions, two orders matched the all-orders leader on 21 of 32 near ties, and a balanced set of 2n orders (every option in every slot, plus the reverses) on 30 of 32. So when the two orders tie, `decide` now asks the rest of that set and takes the verdict from the mean of all 2n; replayed on that study, this fired on 21% of decisions with 4 or more options and lost nothing elsewhere ([record](docs/decisions/decide-balanced-near-ties.md)).

### The bill is the Claude turn, not Jev

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/claude-turn-cost-dark.png">
  <img alt="Jev cost per decision: $0.0007. Claude-side cost per CLI call: $0.10, estimated at list prices. 321 CLI calls, median context 230K to 470K tokens, 37% of calls from subagents." src="assets/charts/claude-turn-cost-light.png" width="100%">
</picture>

A Jev decision cost about $0.0007. The Claude turn around it cost about $0.10 (estimated from list prices), because every extra turn makes Claude re-read the whole conversation. So the referee stays quiet unless it finds something, groups questions into one request and keeps its answers short. Grouping questions saves money on the Jev side too, as TypeSafe measured:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/typesafe-batching-dark.png">
  <img alt="Batching questions, measured by TypeSafe on jev-1.12: 13 questions in one request cost $0.000497 and took 0.27 s; 13 separate requests cost $0.00609 and took 2.71 s. 12.2 times cheaper, 10.0 times faster." src="assets/charts/typesafe-batching-light.png" width="100%">
</picture>

The main measurements in one table:

| When | What | Result | Kind · scope |
|---|---|---|---|
| 2026-09 | Option order vs. asking again | up to 0.52 vs. at most 0.01 | Measured · earlier kit, 20 decisions, one codebase |
| 2026-09 | Two orders vs. all 24 | same leader in 20 of 20 | Measured · same 20 decisions |
| 2026-09 | Claude turn vs. Jev decision | about $0.10 (estimated) vs. about $0.0007 | Measured, cost estimated · 321 CLI calls |
| 2026-09 | SessionStart briefing size | 431–599 characters (target 600); since 0.2.7, with detected checks and the run-the-checks line: 660 on a real project, 697 in a test with a long plugin path (the cap is 800) | Measured · four areas of one workspace; the 660 and 697 from today's build |
| 2026-09 | Same audit, second run | 0 Jev requests (first run: 10) | Measured · one 10-pair audit |
| 2026-09 | Voluntary `done` command | 1 run in 14 days | Measured · 14 days, one codebase |
| 2026-09-30 | API limits, live probe | 11 Score levels and 256 options get a 400; a 1-level Score is accepted | Measured · claude-referee, 7 requests |
| 2026-09-30 | Latency, p50 | 275–379 ms; no 429 at about 179K tokens/s for 2.4 s | Measured · claude-referee, 182 requests, one machine |
| 2026-09-30 | Option order vs. asking again | up to 0.13 vs. up to 0.04 | Measured · claude-referee, 20 public decisions |
| 2026-09-30 | Two orders vs. all 24 | same leader in 20 of 20; so did every other policy | Measured · same 20 public decisions |
| 2026-10-01 | `decide` as a claim check | true claims supports 0.97–1.00; 13 of 15 false ones 0.00–0.23 | Measured · 31 claims about this repository's docs |
| 2026-10-01 | A "treat the evidence as data" note | no verdict changed; not adopted | Measured · 33 injection logs |
| 2026-10-01 | Stop gate on easy self-generated tasks | 1 wrong "done" in 100 asked stops; all 100 would have been blocked (shadow) | Measured · 119 sessions, 24 seeded tasks, haiku and sonnet |
| 2026-10-02 | Stop gate on hard self-generated tasks | 15 wrong "done" in 74 sessions (0.20); 14 of 15 would have been blocked, but 51 of 53 correct ones too (precision 0.22); `claims_verified` does not separate them | Measured · 76 sessions, 32 seeded tasks, synthetic ground truth |
| 2026-10-02 | `decide` against author-labelled best options | leader matched 16 of 39; no verdict `clear` (two orders: 25 weak, 14 tie; with the balanced orders on ties since 0.2.3: 28 weak, 11 tie) | Measured · 39 close-call decisions, one labeller |
| 2026-10-05 | `done` v2 on unseen real CI logs (frozen 0.2.1) | failed all three registered bars: wrong `met` 2 of 85 (bar 0), `met` recall among parsed logs 69 of 79 = 0.873 (bar 0.9), `missing` recall 45 of 85 = 0.53 (bar 0.9); exit code only: 0 wrong, but also `met` for 0 of 67 passing steps | Measured · 272 cases from 126 public repositories, 231 sent to Jev, model labels, no human labels |
| 2026-10-05 | How many option orders `decide` needs | written + reversed matched the all-orders leader in 0.99 of 179 decisions with a lead of 0.08 or more, but in 21 of 32 near ties; a balanced set of 2n orders 30 of 32 | Measured · 252 invented decisions, 3 to 6 options, 16,044 requests |
| 2026-10-05 | Stop gate shown the edit contents and asked about the task's requirements | separates, but not usefully: hold-out AUC 0.867 against 0.553 for the shipped gate, partly from task type (0.643 within the hard tasks); recall 6 of 9 at the frozen threshold (bar 0.8); not adopted | Measured · 95 hold-out sessions, synthetic ground truth |
| 2026-10-05 | The same question without the edit contents | does not separate: AUC 0.626 against 0.543 for the shipped gate, a difference not established; false blocks 29 of 38; not adopted | Measured · 49 fresh sessions, 11 wrong "done", synthetic ground truth |
| 2026-10-06 | `decide` asks the balanced orders on ties | near-tie agreement 30 of 32 against 21 of 32; fired on 21% of decisions with 4 or more options; the live command differs from the study's harness by 0.008 on average | Measured on the data the design came from · replay of 252 recorded decisions, 8 live |
| 2026-10-06 | `decide` with author names against neutral names | neither agrees more with the labels (16.5 against 17.5 of 39, sign test p 1.0); the names move the leader in 15 of 39 | Measured · 39 close-call decisions, one labeller |
| 2026-10-06 | `judge` with the `i18n` pack on invented strings | hold-out bar passed: 0 wrong `yes` on 46 `no` items, 0 wrong `no` on 49 `yes` items; a definite answer on 53 of 95 | Measured · 135 invented strings, model labels |
| 2026-10-06 | `extract` and the `i18n` pack on real repositories | `extract` found 1,725 of 2,463 strings (0.700); judge bar failed: 5 wrong `yes` on 37 `no` items, no `no` at all | Measured · 4 public React and Vue repositories, model labels |
| 2026-10-06 | The same, second sample | `extract` found 2,124 of 2,790 (0.761); 0 wrong answers on 116 hold-out candidates (only 9 technical), a definite answer on 18 | Measured · 9 public repositories, model labels |
| 2026-10-06 | `done` with three more parsers (0.2.3), held-back half of the second real-log sample | wrong `met` from 0 to 1 of 52; `met` recall among parsed logs 26 of 35 = 0.743 | Measured, a second look, not an unseen test · 115 cases from 62 repositories |

More charts (calibration, per-option questions, secret-rule tuning, briefing size) are in [docs/measurements.md](docs/measurements.md).

## What it costs

In short: one small check usually costs more on Claude's side than it saves. Checks pay off when many items are checked at once.

**Not claimed yet:** that claude-referee makes a Claude Code task cheaper overall. That needs a test that compares sessions with and without it, with the plan published before it runs. The result will be published either way.

The chart shows what one check costs on Claude's side, depending on how its answer reaches Claude. These are estimates for Opus 5.5 with 50K tokens of conversation, not measurements.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/cost-dark.png">
  <img alt="Bar chart of what one judgement costs on the Claude side. Default paths: silent hook $0, 300-character note $0.0004, CLI flags only $0.012, JSON via heredoc up to $0.017. Other ways: Haiku prompt hook $0.002, MCP tool call $0.017, request file $0.028. Modelled for Opus 5.5 with 50K tokens of cached context. Not measured." src="assets/cost-light.png" width="100%">
</picture>

Real sessions were much longer than 50K tokens:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/context-size-dark.png">
  <img alt="Token axis from 0 to 500K. The cost chart assumes 50K (modelled). The measured median at call time was 230K to 470K, across 321 CLI calls from one private codebase." src="assets/charts/context-size-light.png" width="100%">
</picture>

So when is it worth asking Jev instead of letting Claude decide? In this estimate, only when many items are checked at once: about 23 items in an 80K-token conversation.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/break-even-dark.png">
  <img alt="Items needed to break even, modelled from list prices: 80K context with items not in context 23; items already in context 48; verbose 2,000-token result 37; 150K context with items not in context 34; items already in context 71. Not measured." src="assets/charts/break-even-light.png" width="100%">
</picture>

Asking the same question again is free: answers are cached on your machine.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/cache-rerun-dark.png">
  <img alt="One 10-pair audit: the first run made 10 Jev requests with 7,316 input tokens; the same audit again made 0 requests; again with --fresh made 10 requests." src="assets/charts/cache-rerun-light.png" width="100%">
</picture>

To see your own numbers, use `/usage` in Claude Code for Claude, and this for Jev:

```sh
npx claude-referee receipts --tokens
```

## Install

You need Claude Code 2.1.139 or later (tested with 2.1.295), Node 20.3 or later on the `PATH` Claude Code sees, and a [TypeSafe API key](https://docs.typesafe.ai).

**1. Install the plugin**

```sh
claude plugin marketplace add ismaildasci/claude-referee
claude plugin install claude-referee@claude-referee
```

**2. Store your key once.** The commands Claude runs and the referee's hooks both look for it here:

```sh
# macOS: saves it in the Keychain and prompts for the key, so it stays out of your shell history
security add-generic-password -a "$USER" -s TYPESAFE_API_KEY -w

# Linux (not yet tested): store it with Secret Service, then point claude-referee at it from your shell profile
secret-tool store --label="TypeSafe API key" service typesafe
export TYPESAFE_API_KEY_CMD="secret-tool lookup service typesafe"
```

```powershell
# Windows (not yet tested), PowerShell 7.1 or later: asks for the key without showing it and saves it for your user.
# Open a new terminal and restart Claude Code afterwards so both pick it up.
[Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", (Read-Host "TypeSafe API key" -MaskInput), "User")
```

On Windows the key is a user environment variable (`HKCU\Environment`), not a credential store, so programs you run can read it.

On macOS or Linux you can also just set `TYPESAFE_API_KEY`. `/plugin configure claude-referee` (or `claude plugin configure claude-referee --values-stdin`, Claude Code 2.1.285+) also stores the key, but Claude Code passes plugin secrets to hooks only, not to the shell. The full lookup order is in [configuration](docs/configuration.md#the-api-key).

**3. Turn it on for a project** by committing `.claude/referee.json`. Without this file, the referee stays silent:

```json
{ "pack": "generic", "areas": [{ "prefix": "", "checks": ["npm test"] }] }
```

`areas` is optional. Without it, the session briefing lists up to four checks it finds in the nearest `package.json`, `composer.json`, `Cargo.toml` or `go.mod` (script names only), and marks them `(detected)`.

**4. Check the setup:**

```sh
npx claude-referee doctor            # add --online to check the key with one free call
```

If `doctor` works but Claude sees no briefing, Claude Code probably can't find Node on its `PATH`. The unit tests run on Windows in CI (Node 24); the PowerShell key step and a real Claude Code session on Windows are not tested yet.

### Try it

```sh
# Is it done? Pipe the check output straight in, so Claude never has to read it.
npm test 2>&1 | npx claude-referee done --criteria "all tests pass" --evidence -

# Run one yes/no rule over many items: here, every added line of a diff.
# On real diffs this generic question left most answers in `review`, so say what the change is.
git diff -U0 --no-ext-diff | grep '^+[^+]' | npx claude-referee judge --question line.risky --context "<what the change is>" --items -
# Adopting a rule on old code: record today's findings once, then report only new ones.
# See docs/judge-baseline.md for --baseline <file> and --baseline-write.

# Pick between options. The referee reads the context files itself.
npx claude-referee decide <<'EOF'
{"decision": "Where should rate-limit counters live?",
 "options": [{"name": "redis", "text": "Redis, already deployed"},
             {"name": "memory", "text": "In-process LRU on each instance"}],
 "context_files": ["docs/adr/0007-scaling.md"]}
EOF

# Count, from your own local transcripts, how many of your Claude Code edit turns ended with a passing check. Local only: no Jev call, nothing sent.
npx claude-referee audit --since 2026-10-01

# See what would be sent, without calling Jev
npm test 2>&1 | npx claude-referee done --criteria "all tests pass" --evidence - --dry-run

# See this project's calls, stops and Jev's stored answers in a local dashboard (127.0.0.1, Flow tab first)
npx claude-referee ui
```

Each command prints one line of JSON: `ok`, the verdict, a few numbers, a `next_step` when there is one, and, for the commands that ask Jev, a receipt ID. Every verdict exits 0, including "not done"; in CI, `--fail-on missing,unsure` exits 3 on those verdicts. `--describe` (or `--help`, `-h`) after a command prints its full contract, and `claude-referee --describe` lists the commands as JSON. An unknown option names the closest valid one when that is at most two edits away and the typed option has more characters than edits.

> [!TIP]
> **Make the evidence explicit.** A check that prints nothing on success shows nothing. While building claude-referee, the referee answered `missing` (0.46) to "typecheck passes" because `tsc` printed no output; adding the exit code turned it into `met` (0.97). (Measured once, 2026-09-30.) That was one command. On real CI logs where the evidence was only an exit code, `done` answered `met` for none of 67 passing steps: with an exit code alone, a passing step came back `unsure` (34) or `missing` (33), never `met`. Pipe the runner's own summary when you can. When the log has only an exit code, up to three echoed command lines of a known check tool (`$ tsc --noEmit`, `> eslint .`) are sent with it, so Jev knows what ran. In real use on the maintainer's machine (other projects, aggregate counts only), `met` came from an exit code alone 71 times against 43 from a parsed runner, and 64 of those 71 had every criterion worded as an exit status. Such a `met` proves only the exit status, so word the criterion as what the output must show. Take the exit line from `$?` (after a pipe, `$pipestatus[1]` in zsh or `${PIPESTATUS[0]}` in bash), never type it, and run separate checks as separate `done` calls.
> ```sh
> { npx tsc --noEmit; echo "tsc exit code: $?"; } 2>&1 | npx claude-referee done --criteria "typecheck passes" --evidence -
> ```

`done` can return `met` only when it recognises a runner summary, or sees an exit code line. A clean `eslint` or `oxlint` run, which prints nothing, counts as a runner summary when the log is the npm script echo (`> pkg@1.0.0 lint`, `> eslint .`) plus an exit code of 0 and no other output. Anything else comes back `unsure` with `trust: unparsed`. A non-zero exit code in the evidence is `missing` (`reason: exit_code_nonzero`) and Jev isn't asked; the run still writes a receipt with 0 requests, and `--dry-run` gives the same verdict. Skipped, risky or incomplete tests cap `met` at `unsure` (`reason: skipped_tests`), and so do expected failures such as Swift Testing known issues or vitest's `expected fail`; a recognised run that is cut off, empty, cancelled or flaky gives `reason: incomplete_run`; a test criterion backed only by a build or an oxlint run gives `reason: no_tests_run`; a lint or clean criterion with a warning behind it gives `reason: warning_in_log`, also when it only names the linter (`oxlint`, `eslint`). If a recognised log has no runner for a lint, build or typecheck criterion (in a combined log, say, only the test runner's summary was read), a verdict that is not `met` and has none of the reasons above gets `reason: criterion_not_covered`: run that check on its own and pipe its output. That reason never changes the verdict.

**How far to trust `done`.** `done` v2 is not measured on its original bar. On a sample of real CI logs that nobody tuned the code for, it failed its registered bars: wrong `met` 2 of 85 (the bar is 0), `met` recall among recognised logs 0.873 (bar 0.9). On those logs, with exit-code-only evidence it almost never said `met` and answered `unsure` where a person would say `missing`; criteria worded as exit statuses often get `met` from the exit code alone (see the tip above). Two parser defects behind the two wrong `met` were fixed afterwards, on those same cases, so the 0 wrong `met` that follows is fitted and not an unseen test. The details are in [measurements-real-logs-2](docs/measurements-real-logs-2.md). Three parsers added in 0.2.3 (`mix test`, `ctest`, `rubocop`) were then scored once on the half of that sample I had held back. Wrong `met` went from 0 to 1 of 52: a rubocop log that said in plain words that some analyses would be skipped. `met` recall among recognised logs on that half was 26 of 35 (0.743). That half comes from a sample whose totals I had already seen, so this is a second look, not an unseen test ([measurements-real-logs-3](docs/measurements-real-logs-3.md)). The rubocop case, a skip line read as a clean run, is capped since 0.2.6 ([record](docs/decisions/rubocop-skip-warning-result.md)). Read `met` as a hint that the output shows the check passing, not as proof, and keep reading the output yourself when it matters.

## What leaves your machine

- Only what a check needs is sent to TypeSafe's API, which runs in the US.
- If the input contains something that looks like a password, key or token, nothing is sent.
- Emails, IP addresses and your home folder path are replaced before sending.
- `--dry-run` shows exactly what would be sent, without sending it.
- The receipts stay on your machine: model, tokens, cost, time, the verdict and its numbers, never the text you sent. With the done-gate on, `stops.jsonl` also keeps excerpts of your prompt and Claude's last message. If you set `REFEREE_KEEP_EVIDENCE=1`, `done` also keeps its redacted criteria and evidence on your machine for 14 days, so you can label verdicts (`receipts --evidence-queue` lists them); it is off by default and nothing is sent.
- Anything that would send free text on its own stays off until you turn it on.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/charts/redaction-dark.png">
  <img alt="What the redaction rules caught in a scan of 12,166 Bash outputs from one private codebase: 3 looked like credentials, which would stop a request. 2,048 values were replaced: 1,490 UUIDs, 190 IP addresses, 190 other identifiers, 178 emails. Slowest output: 14 ms. The replacements weren't reviewed by hand." src="assets/charts/redaction-light.png" width="100%">
</picture>

More detail: [what leaves your machine](docs/privacy.md).

## The rules

1. **No proof, no "done".** Test output counts as proof; a sentence saying the tests pass doesn't.
2. **Silence is the default.** A check that finds nothing adds nothing to Claude's context.
3. **Code first, then a model.** If plain code can answer, no model is asked.
4. **Count the turns, not the calls.** An extra Claude turn costs far more than a Jev call.
5. **Ask better, not again.** Add the missing fact instead of repeating the question.
6. **Send the minimum.** Only what a check needs leaves your machine.
7. **Receipts, or it didn't happen.** Every call is logged, and no saving is claimed without a measurement.
8. **The referee can be overruled.** You and Claude keep the final say.

The reasoning behind each one is in [MANIFESTO.md](MANIFESTO.md) ([Türkçe](MANIFESTO.tr.md)).

## Learn more

- [Configuration](docs/configuration.md): settings, the project file, packs and the key lookup order
- [What leaves your machine](docs/privacy.md) and [Economics](docs/economics.md)
- [Measurements](docs/measurements.md): most numbers above, with their method and limits; four later studies have their own pages, linked under [What's measured so far](#whats-measured-so-far)
- [A recipe for the project `verify` skill](docs/verify-skill.md): run `done` on your test output before every commit
- [GitHub Action](docs/recipes/github-action.md): runs `done` on a pull request's test log and `claims` on the doc lines it adds ([Marketplace](https://github.com/marketplace/actions/claude-referee))
- [The i18n recipe](docs/recipes/i18n.md): `extract` finds candidate UI strings for the `i18n` pack's `judge` question
- [FAQ](docs/faq.md), [Roadmap](ROADMAP.md) and [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md): no API key needed, tests run offline. Security reports: [SECURITY.md](SECURITY.md)
- Writing your own TypeSafe code? TypeSafe's official plugin gives Claude the full API context: `claude plugin marketplace add typesafe-ai/skills`, then `claude plugin install typesafe@typesafe-ai`. claude-referee doesn't need it.

---

<sub>claude-referee is an independent, unofficial project, not affiliated with or endorsed by Anthropic or TypeSafe. It fails open, it can be switched off, and it is not a security boundary. MIT licensed. "Claude" and "Claude Code" are trademarks of Anthropic, PBC; "TypeSafe" and "Jev" are trademarks of their owner, used here only to say what claude-referee works with.</sub>
