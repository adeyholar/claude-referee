// Finds .claude/referee.json upward from cwd and merges .claude/referee.local.json over it (hooks and thresholds per key).
// Project files pick a pack and hooks and can only raise thresholds; key, key command and packs_dir are ignored.
// With no file, REFEREE_DEFAULT_PROJECT=shadow|soft gives every git repository the generic pack, the briefing and that stop-gate mode (docs/decisions/default-project.md); a file always wins.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Env } from "./config.ts";
import { RefereeError } from "./errors.ts";
import type { Area, Thresholds } from "./pack.ts";

export type StopGate = "off" | "shadow" | "soft" | "active";

export interface ProjectConfig {
  readonly root: string;
  readonly pack: string;
  readonly areas: readonly Area[] | undefined;
  readonly hooks: { readonly sessionStart: boolean; readonly stopGate: StopGate; readonly preModelSwitch: boolean };
  readonly thresholds: Thresholds | undefined;
}

interface RawProject {
  pack?: unknown;
  areas?: unknown;
  hooks?: { sessionStart?: unknown; stopGate?: unknown; preModelSwitch?: unknown };
  thresholds?: unknown;
}

function readProjectFile(path: string): RawProject {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not an object");
    return raw as RawProject;
  } catch {
    throw new RefereeError("bad_project", `Project file is not a JSON object: .claude/${path.split(/[\\/]/).pop()}`);
  }
}

function checkAreas(raw: unknown): Area[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new RefereeError("bad_project", "areas must be an array.");
  return raw.map((a: { prefix?: unknown; checks?: unknown; evidence?: unknown; pack?: unknown }) => {
    if (typeof a?.prefix !== "string" || !Array.isArray(a.checks) || !a.checks.every((c) => typeof c === "string")) {
      throw new RefereeError("bad_project", "Each area needs a prefix string and a checks array of strings.");
    }
    return {
      prefix: a.prefix,
      checks: a.checks as string[],
      ...(Array.isArray(a.evidence) ? { evidence: a.evidence.filter((e): e is string => typeof e === "string") } : {}),
      ...(typeof a.pack === "string" ? { pack: a.pack } : {}),
    };
  });
}

function mergeThresholds(base: unknown, local: unknown): Thresholds | undefined {
  const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  if (!obj(base) && !obj(local)) return undefined;
  const out: Record<string, Record<string, number>> = {};
  for (const src of [obj(base), obj(local)]) for (const [q, keys] of Object.entries(src ?? {})) out[q] = { ...out[q], ...(obj(keys) as Record<string, number> | undefined) };
  return out;
}

export function findProjectFile(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    const file = join(dir, ".claude", "referee.json");
    if (existsSync(file)) return file;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitRoot(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function defaultProject(cwd: string, env: Env): ProjectConfig | null {
  const mode = env["REFEREE_DEFAULT_PROJECT"]?.trim().toLowerCase();
  const root = mode === "shadow" || mode === "soft" ? gitRoot(cwd) : null;
  return root === null ? null : { root, pack: "generic", areas: undefined, hooks: { sessionStart: true, stopGate: mode as StopGate, preModelSwitch: false }, thresholds: undefined };
}

export function loadProject(cwd: string, env: Env = {}): ProjectConfig | null {
  const file = findProjectFile(cwd);
  if (!file) return defaultProject(cwd, env);
  const base = readProjectFile(file);
  const localFile = join(dirname(file), "referee.local.json");
  const local = existsSync(localFile) ? readProjectFile(localFile) : {};
  const merged: RawProject = { ...base, ...local, hooks: { ...base.hooks, ...local.hooks } };
  if (typeof merged.pack !== "string" || !merged.pack) throw new RefereeError("bad_project", "The project file needs a pack name, for example {\"pack\": \"generic\"}.");
  const gate = merged.hooks?.stopGate;
  return {
    root: dirname(dirname(file)),
    pack: merged.pack,
    areas: checkAreas(merged.areas),
    hooks: {
      sessionStart: merged.hooks?.sessionStart !== false,
      stopGate: gate === "shadow" || gate === "soft" || gate === "active" ? gate : "off",
      preModelSwitch: merged.hooks?.preModelSwitch === true,
    },
    thresholds: mergeThresholds(base.thresholds, local.thresholds),
  };
}

export function areaFor(areas: readonly Area[] | undefined, root: string, cwd: string): Area | null {
  if (!areas?.length) return null;
  const rel = relative(root, cwd).split(sep).join("/");
  const path = rel === "" ? "" : `${rel}/`;
  const matches = areas.filter((a) => path.startsWith(a.prefix) || a.prefix === "" || a.prefix === "./");
  return matches.sort((a, b) => b.prefix.length - a.prefix.length)[0] ?? null;
}
