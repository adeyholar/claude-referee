// SessionStart briefing: a short, byte-stable text from the pack's cheat sheet, only in projects with .claude/referee.json.
// No network. Exports non-secret settings to Claude's shell through CLAUDE_ENV_FILE; never the key. Any failure means silence.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../engine/config.ts";
import { checkoutClass, projectId, resolveDataDir } from "../engine/datadir.ts";
import { detectChecks } from "../engine/detect-checks.ts";
import { loadPack, packDirs } from "../engine/pack.ts";
import { areaFor, loadProject } from "../engine/project.ts";
import { appendReceipt, newReceiptId } from "../engine/receipts.ts";

export const BRIEFING_LIMIT = 800;

export interface HookIo {
  readonly env: Env;
  readonly home: string;
  now(): number;
  readStdin(): Promise<string>;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fit(text: string): string {
  if (text.length <= BRIEFING_LIMIT) return text;
  const cut = text.slice(0, BRIEFING_LIMIT);
  return cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0)) || cut;
}

export async function sessionStart(io: HookIo, pluginRoot: string): Promise<string | null> {
  const started = io.now();
  const { env } = io;
  if (env["REFEREE_HOOKS"] === "off" || /^(?:false|0|no|off)$/i.test(env["CLAUDE_PLUGIN_OPTION_HOOKS_ENABLED"]?.trim() ?? "")) return null;
  let input: { cwd?: unknown; session_id?: unknown };
  try {
    input = JSON.parse(await io.readStdin()) as typeof input;
  } catch {
    return null;
  }
  if (typeof input?.cwd !== "string") return null;
  const cwd = input.cwd;
  const project = loadProject(cwd, env);
  if (!project?.hooks.sessionStart) return null;

  const dirs = packDirs(env);
  let pack = loadPack(project.pack, dirs);
  const area = areaFor(project.areas ?? pack.areas, project.root, cwd);
  if (area?.pack && area.pack !== pack.name) pack = loadPack(area.pack, dirs);
  const template = pack.cheatsheet["session"];
  if (!template) return null;

  const detected = area?.checks.length ? [] : detectChecks(cwd, project.root);
  const checks = area?.checks.length ? area.checks.join("; ") : detected.length ? `${detected.join("; ")} (detected)` : "none listed in .claude/referee.json";
  const text = fit(
    template
      .replaceAll("{{pack}}", pack.name)
      .replaceAll("{{cli}}", join(pluginRoot, "dist", "cli.mjs"))
      .replaceAll("{{checks}}", checks)
      .trim(),
  );

  const dataDir = resolveDataDir(env, io.home, cwd);
  const envFile = env["CLAUDE_ENV_FILE"];
  if (envFile) {
    const lines = [`export REFEREE_DATA_DIR=${quote(dataDir)}`, `export REFEREE_PACK=${quote(pack.name)}`];
    const packsDir = env["CLAUDE_PLUGIN_OPTION_PACKS_DIR"]?.trim();
    if (packsDir) lines.push(`export REFEREE_PACKS_DIR=${quote(packsDir)}`);
    const model = env["CLAUDE_PLUGIN_OPTION_MODEL"]?.trim();
    if (model) lines.push(`export REFEREE_MODEL=${quote(model)}`);
    try {
      appendFileSync(envFile, lines.join("\n") + "\n");
    } catch {}
  }
  appendReceipt(dataDir, {
    id: newReceiptId(started),
    ts: new Date(started).toISOString(),
    command: "session-start",
    project: projectId(cwd),
    worktree: checkoutClass(cwd),
    pack: pack.name,
    requests: 0,
    cached: 0,
    input_tokens: 0,
    cost_usd: 0,
    chars: text.length,
    ms: Math.max(0, io.now() - started),
    ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}),
  });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
}
