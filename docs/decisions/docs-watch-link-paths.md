# Docs watch: name the pages that change in llms.txt

Written 2026-10-12, after the code (the bars below were checked by the tests). Chosen with `decide` before it, among three options: a first ask was weak (A 0.42, B 0.57, receipt `rmv4uctjr6r5b`); after one measured fact was added (below) it was clear, A 0.93 with both orders agreeing (receipt `rmv4ud650coyq`). The fact moved the verdict, so the weight is on the measurement, not on the second ask.

## Why

The weekly watcher recorded only the number of links in `llms.txt`. Its hash changed twice in 11 days: between 2026-10-01 and 2026-10-05 the count stayed 111 (a page swapped or described differently, never diagnosed), and on 2026-10-12 it went from 111 to 112. Neither change could be read from the output, and the Wayback Machine availability API returned no snapshot of the file (asked for 2026-10-05 and 2026-10-11), so the page added on 2026-10-12 cannot be named afterwards. `models.md`, `api.md` and the jaggedness page did not change then, so no limit or threshold moved.

## The rule

- The recorded facts of `llms.txt` hold `links` (as before) and `paths`: the sorted link targets, with the docs base URL removed.
- When the hash differs and both snapshots hold `paths`, the changed-page entry carries `added` and `removed` (the paths) and leaves the long list out of `was` and `now`.
- A snapshot without `paths` compares by hash as before; one `--update` migrates it.

## Bars

- **B1:** a test shows `paths` sorted and base-URL-free, and `added`/`removed` for an added page and for a swap with an equal count.
- **B2:** a test shows an old count-only snapshot still produces a changed-page entry without `added`/`removed`.
- **B3:** after `--update`, `node scripts/docs-watch.mjs` says unchanged; the snapshot diff touches only the `llms.txt` entry.
- **B4:** `npm run check` and `ci:local` green.

## Limits

- Only link targets are compared; an edited description on the same target changes the hash and gives empty `added` and `removed`.
- The page added on 2026-10-12 stays unnamed. The next change is the first one the watcher can name.
- A link line that does not match `- [title](target)` counts in `links` but not in `paths`.
