# `audit`: the Stop gate replayed over your own transcripts

Registered 2026-10-12. Step 1 (local, no Jev) is built and described under Result; step 2 (asking Jev) is registered, built and run once on this repository's folders (see Result of step 2); the bars below were fixed before that run. Chosen with `decide` among four directions: audit 1.00, both orders agreeing (receipt `rmv5a77raka7z`); the option costs in that context were written by the maintainer's assistant, so the 1.00 is not independent evidence. The measured facts below are.

## Why

The maintainer asked for a larger output from Jev instead of more small increments. What exists is a set of opt-in commands and a Stop hook in shadow mode. Two measurements point at the same gap:

- 689 of 919 Stop records (75 percent) were skipped because background tasks were pending, and the studies that judged the gate used self-generated sessions (wrong-done rate 0.203 on hard tasks, recall 0.933, precision 0.215). Real use has no ground truth: nobody labels a Stop.
- The machine already holds the missing ground truth: the user's next message after a turn. About 3,000 main transcripts and 1,400 subagent transcripts (aggregate, 97 folders) record what Claude said, what it ran and how the user answered.

TypeSafe describes Jev as a model for checking agent traces at low cost. A retrospective pass over those transcripts uses it for that, with no blocking behaviour and so no false-block risk.

## Step 1: `claude-referee audit` (local, no Jev)

Built. For each real user prompt of each main transcript it replays the Stop gate on the transcript text up to the next prompt (the facts the hook would have read when that turn ended) and classifies the turn with the gate's own skip rule: `no_edit`, `verified` (a passing check after the last edit), `unverified_ran_checks`, `unverified_no_check`. It tallies per project folder, counts subagent calls and notices, and counts how many next prompts carry the gate's weak cue (`reported_broken` or `repeated_request`). Output: one summary line plus a file with every folder's tally; folders are 12-hex hashes unless `--names`; no prompt, message or path text is kept or printed. It needs no key and sends nothing.

### Result (2026-10-12, the maintainer's machine, aggregates only)

- 2,984 main sessions, 3,859 turns, 286 edit turns: 63 verified (22 percent), 93 ran checks but none passed after the last edit, 130 had no check (unverified share 0.77 by this stricter definition; the earlier usage report counted any check and read 49 to 67 percent).
- The weak cue fired on 1 of 59 next prompts after verified turns and 2 of 202 after unverified turns (3 of 261, 1.1 percent), against 30 of 614 after turns without edits (4.9 percent). The cue is built to avoid false positives, so it misses most pushback after edits: it cannot serve as the label, and reading next prompts needs Jev.
- This repository alone: 64 edit turns (15 verified), 57 with a next prompt, the cue on 1 of them. Too few for any rate comparison.

## Step 2: reading the turns with Jev (registered, not run)

`audit --ask` (opt-in; `--dry-run` prints what would leave the machine and the token estimate and sends nothing). Per edit turn with a next prompt it asks Jev, with the existing redaction:

1. the Stop gate's own questions (`stop.claims_done`, `stop.claims_verified`, `stop.verification_applies`, `stop.outcome`) on the turn's task, final message, checks and edits, exactly as the hook would have, giving the gate's `would_block` for that turn;
2. one new yes/no question, `audit.pushback`, on the previous final message and the next prompt: does the next prompt say the previous work was wrong, incomplete, broken or not what was asked.

A next prompt counts as pushback at `audit.pushback` p of at least 0.90 and as no pushback at 0.10 or below; the rest is excluded from the rates and counted.

### Bars (fixed before any request)

- **B1, label check:** every turn labelled pushback (expected at most 40) is read by the maintainer's assistant against its next prompt text: at least 90 percent are real pushback at the previous work. Same model family writes and checks, so this is a sanity check, not an independent label; a person's labels replace it when available.
- **B2, power:** at least 15 turns with `would_block` and 15 pushback-labelled turns in the population. Below that the result is "not evaluable" and no signal claim is made.
- **B3, signal:** P(pushback | would_block) divided by P(pushback | not would_block) is at least 2, with a one-sided Fisher exact p below 0.05. Also reported: the same for unverified versus verified turns without Jev, and the AUROC of `claims_done * (1 - claims_verified)` against the pushback label.
- **B4, cost and privacy:** the run prints the number of requests and tokens before sending, spends under 5 USD, and the report holds counts only.

If B3 holds, the Stop gate's `soft` wording gets a measured sentence (still never `active` on this evidence alone). If B2 fails, the study waits for more data. If B3 fails with B2 met, the negative result is recorded in the measurements page and the gate stays a reminder.

### Data scope

This repository's own folders first. Other projects' transcripts contain employers' code and text; sending excerpts of them to the TypeSafe API needs the maintainer's explicit yes for each scope, and that yes has not been given.

### Amendments before the first request (2026-10-12)

Made while building step 2, after step 1's numbers and before any Jev request on transcripts; the bars B1 to B4 are unchanged.

- `--ask` requires `--project <text>` (no run over every folder) and stops at 300 turns (`too_large`). A dry run (`--dry-run`) prints every request that would be sent; it is the "print first" of the text above.
- `--skip <file>` (the `.private-terms` format) drops a turn whose session task, final message, check commands, edited paths or next prompt matches. It exists because the dry run on this repository found one private term in the text of one turn's request; with the maintainer's `.private-terms` as the skip file that turn is not sent. The count is printed as `skipped`.
- The pushback question text is the one shipped in `plugins/claude-referee/packs/generic/questions/audit.json`; its first wording failed the pack's own `compound` lint rule (and/or) and was reduced to one idea before any request.
- Verdict names: `not_evaluable` (B2 not met), `signal` (B2 and B3 met), `no_signal` (B2 met, B3 not). B3 is computed on the gate table (would_block against pushback).
- The data scope stays this repository's own folders; the dry run of 99 requests is about 85,000 input tokens (under 0.01 USD).

## Result of step 2, first run (2026-10-12, this repository's folders)

Run once on this repository's own transcript folders with `--skip` set to the maintainer's private-terms file (1 turn dropped; the dry run was checked for those terms first: 0 matches). 97 requests, about 83,000 input tokens (about 0.004 USD at the list price), receipt `rmv5ay6zh9on3`, no request failed or was stopped. A second run read all 97 answers from the cache.

- Population: 56 edit turns with a next prompt, 41 of them unverified.
- `would_block`: 3 of the 41 unverified turns (7 percent). Pushback at the 0.90 band: 0 of 56; 42 below 0.10; 14 in between.
- **B2 (power): not met** (3 `would_block` turns and 0 pushback turns against 15 and 15). Verdict `not_evaluable`. **B1** has nothing to check (no turn was labelled pushback). **B3** is not defined (rate 0 in both groups). **B4** met (97 requests, counts only in the file, well under 5 USD).
- Post-hoc reading, not a bar: the assistant read the 12 next prompts with the highest pushback scores (0.61 down to 0.10) against their text. None is a clear report of failure; one is an implicit retry request ("try again") that scored 0.22, so the question may miss that kind of pushback (n = 1). The weak cue had fired on 1 of the 57 edit-turn next prompts of these folders (before the skip file).
- What the first run says about the study: pushback is rare in this maintainer's real sessions (0 of 56 at 0.90, the weak cue 1 of 57). Even if every local folder were added (261 edit turns with a next prompt), the expected number of pushback turns stays in single digits, so B2's 15 is out of reach on this machine's data. A predictive claim about the gate needs a denser label, more months of data or other users' data. No claim is made.

### What the run did show (descriptive, added after the first run, no bar)

- The gate funnel on the 41 unverified turns: 7 claimed the work was done, 5 of those were not verified, a check applied to 3, and 3 would have been flagged. The raw unverified share of edit turns (0.77 machine-wide, 0.76 here) overstates what a reminder would say: most unverified turns did not claim to be finished or the change needed no check. `audit --ask` now prints this as `funnel`.
- Verified share of edit turns by ISO week, all local folders: 2026-W37 3 of 8, W38 0 of 15, W39 5 of 54, W40 3 of 20, W41 48 of 179, W42 (to 10-12) 4 of 10. The session briefing with the done-check line is in use since 2026-10-09 (W41). W41's 179 edit turns are mostly this repository's own development, where checks are the habit, so the rise is not shown to be an effect of the briefing; split by folder before reading it (the file report has per-folder weeks). `audit` now prints the last eight weeks as `weeks`.

## Step 3: before and after a change date, `audit --compare <ISO>` (registered 2026-10-13, local, no Jev)

The question the product has to answer about itself: do edit turns end with a passing check more often after a change such as the session briefing. `--compare` splits the same transcripts at a date (`--since` and `--until` still bound the whole range, `--exclude <text>` drops folders whose name contains it), counts verified edit turns before and after, and repeats the count over the folders that have enough edit turns in both windows, so a change in which projects were worked on does not pass as an effect. Counts only; the file report keeps both windows' per-folder tallies.

Choice of the build, Jev `decide` over three options (an audit tab in the dashboard, this, a subagent-report audit): first ask weak (this option 0.67, orders disagreed, receipt `rmv67rw8mm665`); after one added fact (a full scan takes 7.1 seconds over 3.1 GB, which makes a per-load dashboard tab slow) 0.77 with both orders agreeing (`rmv67sbkrayfi`). Below the 0.90 bar, so taken as the cheaper and reversible option, not as a clear verdict. The costs in the question were written by the assistant.

### Bars (fixed before the first run)

- **C1, power:** at least 30 edit turns in each window after `--exclude`. The paired set takes folders with at least 3 edit turns in each window and needs at least 2 such folders. Below C1 the verdict is `not_evaluable`.
- **C2, signal:** `higher` when the verified share after is at least 0.10 above the share before, the one-sided Fisher exact p is below 0.05, and the paired set points the same way (its difference above 0). `lower` is the mirror image. Otherwise `no_signal`.
- **C3, reading:** a `higher` is an association after a date, not an effect: nothing is randomised, habits drift, and the maintainer's own development in this repository is checked by habit. The measurement of the 0.2.7 session briefing is the run `--compare 2026-10-09T14:00:00Z --exclude claude-referee` on 2026-10-18 or later; earlier runs are smoke runs and update nothing.
- **C4, cost and privacy:** local, no network, the output holds counts and folder hashes, never text.

Smoke run on the maintainer's machine (2026-10-13, after the bars were written; by C3 it updates nothing): cut `2026-10-09T14:00:00Z`, this repository excluded: 200 edit turns before (41 verified), 25 after (9 verified); `not_evaluable` (C1: 25 is under 30), difference 0.15, p 0.07, paired set 2 folders 0.24 to 0.36. All folders: 259 before (56 verified), 31 after (11 verified), difference 0.13, p 0.07, `no_signal`. One scan took 7.5 seconds.

## Not in this decision

A SubagentStop hook, a commit and PR rules guard and the dashboard tab were compared and not chosen first. The audit's per-turn units extend to subagent reports later (659 Agent calls are in the main transcripts).

## Limits

- The transcript format is Claude Code's own and not a documented interface; the reader the Stop hook already uses breaks the same way.
- Sessions that are not interactive (tool sessions, note takers) count as turns without edits.
- A turn's class uses the Stop gate's detector, which misses checks it does not recognise.
- Prompts in other languages: the weak cue knows English and Turkish phrases only.
