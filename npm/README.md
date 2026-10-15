# claude-referee

*Evidence over eloquence.* An unofficial CLI that hands small, checkable judgements to [TypeSafe Jev](https://docs.typesafe.ai) and keeps local receipts. It is the same CLI that the claude-referee Claude Code plugin bundles.

```bash
npm test 2>&1 | npx claude-referee done --criteria "all tests pass" --evidence -
npx claude-referee decide < decision.json
npx claude-referee doctor
```

Every command prints one JSON line and accepts `--describe` (or `--help`, `-h`), which prints its contract; `npx claude-referee --describe` lists the commands. `--dry-run` shows the redacted request without sending it.

You need Node 22.12 or later and a TypeSafe API key in `TYPESAFE_API_KEY`, `TYPESAFE_API_KEY_CMD` or, on macOS, the Keychain item `TYPESAFE_API_KEY`.

Documentation, the Claude Code plugin and the manifesto: https://github.com/ismaildasci/claude-referee

Not affiliated with, endorsed by or sponsored by Anthropic or TypeSafe. MIT licensed.
