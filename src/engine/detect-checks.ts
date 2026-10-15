// Names up to 4 check commands from the nearest manifest (package.json, composer.json, Cargo.toml, go.mod); reads script names only.
// Used by the SessionStart briefing when no area lists checks, and by `done --run`, which runs only what is found here: a script name outside SAFE is dropped.
// Any read or parse error means "no checks".

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const FAMILIES = ["test", "typecheck", "lint", "check", "build", "ci", "verify"] as const;
export const DETECTED_MAX = 4;
const JOINED_MAX = 80;
const SAFE = /^[A-Za-z0-9:._-]+$/;

function scripts(file: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { scripts?: unknown };
    return typeof raw.scripts === "object" && raw.scripts !== null && !Array.isArray(raw.scripts) ? Object.keys(raw.scripts) : [];
  } catch {
    return [];
  }
}

function pick(names: readonly string[], family: string): string | undefined {
  const safe = names.filter((n) => SAFE.test(n));
  return safe.includes(family) ? family : safe.filter((n) => n.startsWith(`${family}:`)).sort()[0];
}

function runner(dir: string): string {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun run";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn run";
  return "npm run";
}

function laravel(dir: string): boolean {
  if (existsSync(join(dir, "artisan"))) return true;
  try {
    return "laravel/framework" in ((JSON.parse(readFileSync(join(dir, "composer.json"), "utf8")) as { require?: object }).require ?? {});
  } catch {
    return false;
  }
}

function manifestDir(cwd: string, root: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (["package.json", "composer.json", "Cargo.toml", "go.mod", "artisan"].some((f) => existsSync(join(dir, f)))) return dir;
    if (dir === root || dirname(dir) === dir) return null;
  }
}

export interface Check {
  readonly family: string;
  readonly command: string;
  readonly runnable: boolean;
}

function checksIn(dir: string): Check[] {
  const found = new Map<string, string>();
  const composer = scripts(join(dir, "composer.json"));
  const npm = scripts(join(dir, "package.json"));
  for (const family of FAMILIES) {
    const fromComposer = pick(composer, family);
    const fromNpm = pick(npm, family);
    if (fromComposer) found.set(family, `composer ${fromComposer}`);
    else if (family === "test" && laravel(dir)) found.set(family, "php artisan test");
    else if (fromNpm) found.set(family, `${runner(dir)} ${fromNpm}`);
    else if (family === "test" && existsSync(join(dir, "Cargo.toml"))) found.set(family, "cargo test");
    else if (family === "test" && existsSync(join(dir, "go.mod"))) found.set(family, "go test ./...");
  }
  return FAMILIES.flatMap((family) => (found.has(family) ? [{ family, command: found.get(family) as string, runnable: true }] : []));
}

// Only when exactly one immediate subdirectory of the root has checks; several would mean guessing the subproject.
function onlySubdir(root: string): { name: string; checks: Check[] } | null {
  const isDir = (d: string): boolean => {
    try {
      return statSync(join(root, d)).isDirectory();
    } catch {
      return false;
    }
  };
  let names: string[];
  try {
    names = readdirSync(root).filter((d) => !d.startsWith(".") && d !== "node_modules" && d !== "vendor" && isDir(d));
  } catch {
    return null;
  }
  const hits = names.map((name) => ({ name, checks: checksIn(join(root, name)) })).filter((h) => h.checks.length > 0);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

// The checks `done --run` may run (those with runnable true), with the folder to run them in (the manifest's, or the root for a single checked subfolder; `subdir: false` turns that fallback off).
// A subfolder name must start with a letter, digit or underscore, so it can never read as a `cd` option.
export function detectCheckSet(cwd: string, root: string, options: { subdir?: boolean } = {}): { dir: string; checks: Check[] } | null {
  const dir = manifestDir(cwd, root);
  if (dir) {
    const checks = checksIn(dir);
    return checks.length > 0 ? { dir, checks } : null;
  }
  const sub = options.subdir === false ? null : onlySubdir(root);
  if (!sub) return null;
  const plain = /^[A-Za-z0-9_][\w.-]*$/.test(sub.name);
  return { dir: root, checks: sub.checks.map((c) => ({ family: c.family, command: `cd ${plain ? sub.name : JSON.stringify(sub.name)} && ${c.command}`, runnable: plain })) };
}

export function detectChecks(cwd: string, root: string): string[] {
  const out: string[] = [];
  for (const { command } of detectCheckSet(cwd, root)?.checks ?? []) {
    if (out.length === DETECTED_MAX || [...out, command].join("; ").length > JOINED_MAX) break;
    out.push(command);
  }
  return out;
}
