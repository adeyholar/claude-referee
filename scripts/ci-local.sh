#!/usr/bin/env bash
# Runs the steps of .github/workflows/ci.yml locally, as close to CI as one machine allows: no API key, a foreign HOME, a clean bundle check.
# Run it after committing and before pushing. Node 22.23.3, 24, 26 and 22.12.0 are downloaded once into ~/.cache; not covered: Linux and the hook latency timing.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s\n' "$1"; }

fakehome="$(mktemp -d)"
clean_env() { env -u TYPESAFE_API_KEY -u EVAL_TYPESAFE_API_KEY -u TYPESAFE_API_KEY_CMD -u REFEREE_DATA_DIR -u REFEREE_MODEL -u TYPESAFE_MODEL HOME="$fakehome" "$@"; }

step "typecheck"; npm run typecheck --silent
step "tests without a key, under a foreign HOME"; clean_env npm test --silent 2>&1 | grep -E "^ℹ (tests|pass|fail)"; test "${PIPESTATUS[0]}" -eq 0
for v in 22.23.3 24.21.0 26.10.0; do
  step "tests on Node $v, as the CI matrix (cached download, checksum verified)"
  nv="$(bash scripts/ci-node.sh "$v")"; "$nv" --version
  PATH="$(dirname "$nv"):$PATH" clean_env "$nv" --test --test-reporter=spec "test/**/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)"; test "${PIPESTATUS[0]}" -eq 0
done
step "build, then the committed bundle and npm copy must match"; npm run build --silent >/dev/null
git diff --exit-code HEAD -- plugins/claude-referee/dist npm >/dev/null || { echo "bundle or npm copy differs from HEAD: commit the rebuilt files"; exit 1; }

step "bundle runs without node_modules"
tmp="$(mktemp -d)"; cp -R plugins/claude-referee "$tmp/"; cli="$tmp/claude-referee/dist/cli.mjs"
for c in done decide judge claims verify receipts doctor eval; do
  clean_env node "$cli" "$c" --describe | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' || { echo "describe failed: $c"; exit 1; }
done
echo 'not json' | clean_env node "$tmp/claude-referee/dist/hook.mjs" session-start
echo '{}' | clean_env node "$tmp/claude-referee/dist/hook.mjs" stop
test "$(wc -c < "$tmp/claude-referee/dist/cli.mjs")" -lt 450000

step "bundle on Node 22.12, as the CI bundle job (cached download, checksum verified)"
nmin="$(bash scripts/ci-node.sh 22.12.0)"; "$nmin" --version
for c in done decide judge claims verify receipts doctor eval; do
  clean_env "$nmin" "$cli" "$c" --describe | "$nmin" -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' || { echo "describe failed on Node 22.12: $c"; exit 1; }
done
echo 'not json' | clean_env "$nmin" "$tmp/claude-referee/dist/hook.mjs" session-start
echo '{}' | clean_env "$nmin" "$tmp/claude-referee/dist/hook.mjs" stop
env -u TYPESAFE_API_KEY -u EVAL_TYPESAFE_API_KEY -u TYPESAFE_API_KEY_CMD -u REFEREE_MODEL -u TYPESAFE_MODEL HOME=/home/runner "$nmin" plugins/claude-referee/dist/cli.mjs eval score --suite all --fail-on violated | cut -c1-120
test "$(wc -c < "$tmp/claude-referee/dist/hook.mjs")" -lt 200000

step "recorded evals score offline with CI's HOME"
env -u TYPESAFE_API_KEY -u EVAL_TYPESAFE_API_KEY -u TYPESAFE_API_KEY_CMD -u REFEREE_MODEL -u TYPESAFE_MODEL HOME=/home/runner node plugins/claude-referee/dist/cli.mjs eval score --suite all --fail-on violated | cut -c1-200

step "plugin validation"
node scripts/validate-plugin.mjs
node scripts/validate-plugin.mjs --self-test

step "install canary (offline, only when a claude binary exists)"
if command -v claude >/dev/null; then rc=0; node scripts/canary-install.mjs || rc=$?; test "$rc" -eq 0 -o "$rc" -eq 2; else echo "claude not installed here; the canary workflow covers it"; fi

step "private terms";bash scripts/check-no-private.sh
step "secrets in git history (gitleaks 8.30.1, as CI; downloaded with its checksum when not installed)"
gl="$(command -v gitleaks || true)"
if [ -z "$gl" ]; then
  case "$(uname -s)_$(uname -m)" in
    Darwin_arm64) asset=darwin_arm64; sum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
    Darwin_x86_64) asset=darwin_x64; sum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
    Linux_x86_64) asset=linux_x64; sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
    Linux_aarch64) asset=linux_arm64; sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
    *) asset="" ;;
  esac
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/claude-referee/gitleaks-8.30.1-${asset:-none}"
  if [ -n "$asset" ] && [ ! -x "$cache/gitleaks" ]; then
    mkdir -p "$cache"
    curl -sSfL -o "$cache/gitleaks.tar.gz" "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${asset}.tar.gz" \
      && echo "$sum  $cache/gitleaks.tar.gz" | shasum -a 256 -c - >/dev/null \
      && tar xzf "$cache/gitleaks.tar.gz" -C "$cache" gitleaks || rm -f "$cache/gitleaks"
    rm -f "$cache/gitleaks.tar.gz"
  fi
  [ -x "$cache/gitleaks" ] && gl="$cache/gitleaks"
fi
if [ -z "$gl" ]; then echo "gitleaks unavailable (not installed, download failed): CI would scan, so stop here"; exit 1; fi
"$gl" git --redact --no-banner . 2>&1 | tail -1; test "${PIPESTATUS[0]}" -eq 0
printf '\nci-local: all steps passed\n'
