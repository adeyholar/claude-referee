// Verifies a published claude-referee release: the registry tarball against the integrity value the registry reports, then every file in it byte for byte against the git tag's npm/ folder.
// Usage: node scripts/verify-release.mjs <version> [--repo <dir>] [--out <dir>]. Read-only (the tarball is kept only with --out); exit 0 only when everything matches.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// Both arguments map a path inside the package to its bytes. A published package is only right when nothing differs and nothing is missing on either side.
export function compareTrees(tarball, tag) {
  const result = { identical: [], different: [], only_in_tarball: [], only_in_tag: [] };
  for (const [path, bytes] of tarball) {
    const other = tag.get(path);
    if (!other) result.only_in_tarball.push(path);
    else if (Buffer.compare(bytes, other) === 0) result.identical.push(path);
    else result.different.push(path);
  }
  result.only_in_tag = [...tag.keys()].filter((path) => !tarball.has(path));
  return result;
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });

async function verify(version, repo, out) {
  const tag = `v${version}`;
  const attempt = (message, fn) => {
    try {
      return fn();
    } catch {
      throw new Error(message);
    }
  };
  const name = attempt(`git tag ${tag} or its npm/package.json not found in ${repo}`, () => JSON.parse(run("git", ["-C", repo, "show", `${tag}:npm/package.json`], { encoding: "utf8" })).name);
  const dist = attempt(`${name}@${version} is not on the npm registry (yet)`, () => JSON.parse(run("npm", ["view", `${name}@${version}`, "dist", "--json"], { encoding: "utf8" })));
  const response = await fetch(dist.tarball);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrityOk = integrityOf(bytes) === dist.integrity;
  const scratch = mkdtempSync(join(tmpdir(), "verify-release-"));
  const file = join(scratch, "package.tgz");
  writeFileSync(file, bytes);
  const extracted = join(scratch, "x");
  mkdirSync(extracted);
  run("tar", ["-xzf", file, "-C", extracted]);
  const root = join(extracted, "package");
  const tarball = new Map(walk(root).map((p) => [relative(root, p), readFileSync(p)]));
  const listed = run("git", ["-C", repo, "ls-tree", "-r", "--name-only", tag, "--", "npm"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const inTag = new Map(listed.map((p) => [p.replace(/^npm\//, ""), run("git", ["-C", repo, "show", `${tag}:${p}`])]));
  const compared = compareTrees(tarball, inTag);
  let kept;
  if (out) {
    mkdirSync(out, { recursive: true });
    kept = join(out, `${name}-${version}.tgz`);
    writeFileSync(kept, bytes);
  }
  const ok = integrityOk && !compared.different.length && !compared.only_in_tarball.length && !compared.only_in_tag.length;
  return { ok, version, tag, integrity_ok: integrityOk, files: tarball.size, identical: compared.identical.length, different: compared.different, only_in_tarball: compared.only_in_tarball, only_in_tag: compared.only_in_tag, ...(kept ? { tarball: kept } : {}) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
  const version = process.argv[2];
  if (!version || version.startsWith("--")) {
    console.log(JSON.stringify({ ok: false, error: "usage: node scripts/verify-release.mjs <version> [--repo <dir>] [--out <dir>]" }));
    process.exit(1);
  }
  try {
    const result = await verify(version, resolve(arg("--repo") ?? "."), arg("--out") ? resolve(arg("--out")) : undefined);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error).split("\n")[0] }));
    process.exit(1);
  }
}
