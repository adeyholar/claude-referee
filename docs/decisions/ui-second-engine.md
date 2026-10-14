# `ui` in a second browser engine

Written 2026-10-14, after the first runs. The check list below is the list of the 2026-10-06 Chrome run plus two items (the Flow details click, a console-error count). It was not registered before the first run, and one check was changed after the first run (see Result), so read "22 of 22" as a checked list, not a pre-registered pass.

## Why

The ROADMAP row for the local dashboard said "checked in one browser" (headless Chrome 145, 2026-10-06). A second engine was an open item. The dashboard builds its page with `textContent`, a strict CSP and a Blob download, which behave differently across engines.

## Method

`scripts/check-ui-firefox.mjs <light|dark>` starts the real `ui` server in-process on synthetic stops and receipts (excerpts carry an `<img onerror>` and a `<script>` tag), starts headless Firefox with a fresh profile, and drives it over WebDriver BiDi on a WebSocket (Node's global `WebSocket`). No driver download, no dependency. Dark mode is a profile pref (`layout.css.prefers-color-scheme.content-override`). Firefox 147.0.2.

The 22 checks: the Flow tab loads and a click opens Jev's stored answers; five tabs; the token is gone from the URL after load; the colour scheme matches the mode; the queue lists the two stops the gate would have blocked; excerpts show as text and inject nothing; `S`, `B`, `R` keys and a real pointer click on Wrong move and label (and `labels.jsonl` then holds `right` and `wrong`); Overview and Privacy render their tables; the three export buttons exist and one download reaches the download folder; no horizontal overflow at 375 px on Flow and Overview; no alert or prompt opened; no console error or CSP violation other than the favicon one below.

## Result (2026-10-14)

- Light 22 of 22, dark 22 of 22. Two screenshots (the dark queue and the light Flow at 375 px) were looked at by the assistant and showed no layout fault; the other screenshots were not looked at, and no pixel comparison with the Chrome run was made.
- The first light run failed one check: Firefox asks for `/favicon.ico` and logs one console error, because the CSP says `img-src 'none'`. No functional effect. The policy was not loosened for a console message; the check now counts the message and reports it instead of failing on it. That is the one change made after seeing a result.
- Negative control: a copy of the page with the task excerpt set through `innerHTML` made three checks fail (excerpts are text, markup shows as text, no CSP violation), so the checks can fail.

## Not covered

Safari/WebKit (`safaridriver` is on the machine; enabling it needs the user, not tried), headful Firefox (headless writes the download to the configured folder; a headful download prompt was not looked at), a Windows launcher, real receipts instead of synthetic ones.

## Choice

Chosen with Jev (`decide`, receipts `rmv8df2g0019j` and `rmv8dfwxqjv1n`) over docs-watch headings for `api.md`, a dashboard Audit tab and an audit disclosure count. The first ask was weak (lean 0.60); after one measured fact (Firefox 147.0.2 installed, a BiDi session answered from a 20-line script) it led at 0.88 with both orders agreeing, below the 0.90 bar, so it was taken as the cheapest and reversible option. The option costs were written by the assistant, so they are not independent evidence.
