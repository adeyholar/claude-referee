#!/usr/bin/env bash
# Prints the path of a cached Node binary of one version, downloaded from nodejs.org and checked against its SHASUMS256.txt.
# scripts/ci-local.sh uses it to run the CI jobs that pin Node 22.12 and 22.23. Usage: bash scripts/ci-node.sh 22.23.3
set -euo pipefail
v="$1"
case "$(uname -s)_$(uname -m)" in
  Darwin_arm64) plat=darwin-arm64 ;;
  Darwin_x86_64) plat=darwin-x64 ;;
  Linux_x86_64) plat=linux-x64 ;;
  Linux_aarch64) plat=linux-arm64 ;;
  *) echo "ci-node: unsupported platform $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
dir="${XDG_CACHE_HOME:-$HOME/.cache}/claude-referee/node-v$v-$plat"
if [ ! -x "$dir/bin/node" ]; then
  tmp="$(mktemp -d)"
  name="node-v$v-$plat.tar.gz"
  curl -sSfL -o "$tmp/$name" "https://nodejs.org/dist/v$v/$name"
  curl -sSfL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$v/SHASUMS256.txt"
  (cd "$tmp" && grep "  $name\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null)
  mkdir -p "$dir"
  tar xzf "$tmp/$name" -C "$dir" --strip-components 1
  rm -rf "$tmp"
fi
echo "$dir/bin/node"
