# `audit`: the Stop gate replayed over your own transcripts

Registered 2026-10-12. Step 1 (local, no Jev) is built and described under Result; step 2 (asking Jev) is registered here and built, and has not run on any transcript yet, so no bar below has been looked at. Chosen with `decide` among four directions: audit 1.00, both orders agreeing (receipt `rmv5a77raka7z`); the option costs in that context were written by the maintainer's assistant, so the 1.00 is not independent evidence. The measured facts below are.

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

## Not in this decision

A SubagentStop hook, a commit and PR rules guard and the dashboard tab were compared and not chosen first. The audit's per-turn units extend to subagent reports later (659 Agent calls are in the main transcripts).

## Limits

- The transcript format is Claude Code's own and not a documented interface; the reader the Stop hook already uses breaks the same way.
- Sessions that are not interactive (tool sessions, note takers) count as turns without edits.
- A turn's class uses the Stop gate's detector, which misses checks it does not recognise.
- Prompts in other languages: the weak cue knows English and Turkish phrases only.
