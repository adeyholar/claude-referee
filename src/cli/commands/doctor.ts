// doctor: Node and Claude Code versions, where the key comes from (never the key), data dir, packs and model.
// --online also lists the models the key can use, which checks the key without spending tokens.
// In a project it also loads the project file and its pack (and the stop.* questions when the done-gate is on) and names the gate mode.

import { listModels } from "../../engine/client.ts";
import { DEFAULT_BASE_URL, PROFILES, VERSION, resolveModel } from "../../engine/config.ts";
import { dirSize, resolveDataDir, tildify } from "../../engine/datadir.ts";
import { isRefereeError } from "../../engine/errors.ts";
import { isTypeSafeHost, noKeyNextStep, resolveEndpointKey, runCommand, type KeySource } from "../../engine/key.ts";
import { listPacks, loadPack, packDirs } from "../../engine/pack.ts";
import { findProjectFile, loadProject } from "../../engine/project.ts";
import { stopQuestions } from "../../engine/stopgate/decide.ts";
import type { Command } from "../types.ts";

function shownBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const shown = url.toString().replace(/\/+$/, "");
  return shown === DEFAULT_BASE_URL ? undefined : shown;
}

function nodeOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

export const doctor: Command = {
  name: "doctor",
  describe: {
    summary: "Check Node, Claude Code, the key source, data directory, packs and model.",
    inputs: { "--online": "Also list the models the key can use (one free API call)." },
    outputs: {
      verdict: "ready or not_ready",
      version: "claude-referee version",
      node: "Node version; 22.12 or later is needed",
      claude: "Claude Code version, or null when claude is not on the PATH",
      key_source: "Where the key was found: REFEREE_BASE_URL_KEY (only for another host), plugin_setting, TYPESAFE_API_KEY, EVAL_TYPESAFE_API_KEY, TYPESAFE_API_KEY_CMD or keychain, or null. Never the key.",
      key_error: "Only when no usable key was found: the error code, e.g. no_api_key",
      online: "With --online: ok, or the error code of the key check",
      models: "With --online: the models the key can use",
      model: "The Jev model commands use",
      base_url: "Only when TYPESAFE_BASE_URL points somewhere other than the default; credentials and query are removed.",
      data_dir: "The data directory, with ~ for home",
      data_bytes: "Size of the data directory in bytes",
      packs: "Installed packs with version, content hash and source.",
      project: "The project file (.claude/referee.json) found from here, \"(default: shadow)\" or \"(default: soft)\" when REFEREE_DEFAULT_PROJECT gives this git repository the default, or null",
      project_error: "Only when the project file or its pack does not load from this shell (bad_project, pack_not_found or bad_pack). A packs_dir plugin setting reaches hooks, not the shell, so the verdict stays as it is.",
      stop_gate: "The done-gate mode the project file sets, when not off. active is not built yet and runs as shadow; stop_gate_note says so.",
      stop_gate_note: "Only with stop_gate active: it is not built yet and runs as shadow",
      next_step: "What to fix when not ready.",
    },
    errors: ["bad_input"],
    effects: "Reads only. With --online, one request to list models.",
    cost: "Free.",
  },
  options: { online: { type: "boolean" } },
  async run({ io, flags, values }) {
    const node = process.version;
    const claude = (await runCommand("claude", ["--version"], 3000))?.trim().split(/\s+/)[0] ?? null;
    let keySource: KeySource | null = null;
    let keyError: string | null = null;
    let key: string | null = null;
    try {
      const resolved = await resolveEndpointKey(io.env, io.platform);
      keySource = resolved.source;
      key = resolved.key;
    } catch (error) {
      keyError = isRefereeError(error) ? error.code : "internal";
    }
    let models: string[] | null = null;
    let online: string | null = null;
    if (values["online"] === true && key) {
      try {
        models = await listModels({ key, budget: PROFILES.cli, baseURL: io.env["TYPESAFE_BASE_URL"] });
        online = "ok";
      } catch (error) {
        online = isRefereeError(error) ? error.code : "internal";
      }
    }
    const baseUrl = shownBaseUrl(io.env["TYPESAFE_BASE_URL"]);
    const dataDir = resolveDataDir(io.env, io.home, io.cwd, flags.dataDir);
    const projectFile = findProjectFile(io.cwd);
    let projectError: string | undefined;
    let stopGate: string | undefined;
    let projectDefault: string | undefined;
    try {
      const project = loadProject(io.cwd, io.env);
      if (project) {
        if (!projectFile) projectDefault = project.hooks.stopGate;
        const pack = loadPack(project.pack, packDirs(io.env));
        if (project.hooks.stopGate !== "off") stopGate = project.hooks.stopGate;
        if (stopGate) stopQuestions(pack);
      }
    } catch (error) {
      projectError = isRefereeError(error) ? error.code : "internal";
    }
    const ready = nodeOk(node) && keySource !== null && (online === null || online === "ok");
    const nextStep = !nodeOk(node)
      ? "Install Node 22.12 or later on the PATH Claude Code uses."
      : keyError === "no_api_key" && !isTypeSafeHost(io.env["TYPESAFE_BASE_URL"])
        ? "TYPESAFE_BASE_URL points away from api.typesafe.ai: set REFEREE_BASE_URL_KEY to that host's key, or unset TYPESAFE_BASE_URL. The TypeSafe key is never sent there."
        : keyError === "no_api_key"
        ? noKeyNextStep(io.platform)
        : keyError
          ? "The stored key is malformed; store it again."
          : online && online !== "ok"
            ? `The key check failed (${online}).`
            : projectError
              ? `The project file or its pack does not load (${projectError}): check .claude/referee.json, referee.local.json, the pack name and packs_dir.`
              : undefined;
    return {
      ok: true,
      verdict: ready ? "ready" : "not_ready",
      version: VERSION,
      node,
      claude,
      key_source: keySource,
      ...(keyError ? { key_error: keyError } : {}),
      ...(online ? { online } : {}),
      ...(models ? { models } : {}),
      model: resolveModel(io.env),
      ...(baseUrl ? { base_url: baseUrl } : {}),
      data_dir: tildify(dataDir, io.home),
      data_bytes: dirSize(dataDir),
      packs: listPacks(packDirs(io.env)),
      project: projectFile ? tildify(projectFile, io.home) : projectDefault ? `(default: ${projectDefault})` : null,
      ...(projectError ? { project_error: projectError } : {}),
      ...(stopGate ? { stop_gate: stopGate } : {}),
      ...(stopGate === "active" ? { stop_gate_note: "active is not built yet and runs as shadow." } : {}),
      next_step: nextStep,
    };
  },
};
