// CLI runner: parses flags, prints one JSON line, maps verdicts and errors to exit codes.
// Exit codes: 0 for any verdict, 1 for real errors, 3 when --fail-on matches the verdict.
// A Jev command given input (its own option or stdin it read; positionals never count) that fails unreceipted gets a zero-request receipt, never with --dry-run.
// `<command> --help` or `-h` prints the command's contract like --describe; a bare `--describe` prints the command index.

import { join } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { KIT, VERSION } from "../engine/config.ts";
import { checkoutClass, projectId, resolveDataDir } from "../engine/datadir.ts";
import { RefereeError, isRefereeError } from "../engine/errors.ts";
import { render, renderError, type Result } from "../engine/output.ts";
import { appendReceipt, envSessionId, errorReceipt } from "../engine/receipts.ts";
import { isReceipted } from "../engine/session.ts";
import type { Command, Context, GlobalFlags, Io } from "./types.ts";

export const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  describe: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  pretty: { type: "boolean" },
  "dry-run": { type: "boolean" },
  fresh: { type: "boolean" },
  verbose: { type: "boolean" },
  "data-dir": { type: "string" },
  pack: { type: "string" },
  "fail-on": { type: "string" },
};

export const SHARED_CONTRACT = {
  flags: {
    "--help (-h)": "After a command: print that command's contract, the same as --describe.",
    "--pretty": "Indented JSON for people.",
    "--data-dir <dir>": "Use another data directory for receipts, cache and results.",
    "--pack <name>": "Use this pack instead of the project's.",
    "--dry-run": "Commands that ask Jev: print the redacted request and a token estimate; send, cache and log nothing. Long requests are shortened; --pretty shows them in full. A verdict decided in code (done on a non-zero exit code) is printed as is, with dry_run.",
    "--fresh": "Commands that ask Jev: skip the answer cache.",
    "--verbose": "Commands that ask Jev: also print requests, cached, input_tokens, cost_usd, model and ms as one JSON line on stderr; nothing with --dry-run.",
    "--fail-on <verdict,...>": "Exit with code 3 when the verdict is one of these, e.g. --fail-on missing,unsure.",
  },
  outputs_common: {
    ok: "true with a verdict; false on an error line",
    verdict: "The command's verdict; see outputs",
    next_step: "What to do next, when there is something to do",
    receipt: "Id of the receipt this run wrote",
    requests: "Requests sent to Jev (with --dry-run: planned)",
    cached: "Answers from the cache or merged with an identical request",
    details: "Only when the line would pass 1,500 characters: the file with the full result; the line keeps short scalar fields",
    dry_run: "--dry-run: true; nothing was sent, cached or logged",
    est_tokens: "--dry-run: estimated input tokens",
    replaced: "--dry-run: values redaction replaced",
    sent: "--dry-run: the redacted requests",
    sent_shown: "--dry-run: how many requests fit on the line",
    error: "Error line: the error code",
    message: "Error line: what went wrong",
    status: "Error line: the API's HTTP status, when there was one",
    retry_after_ms: "Error line: when to retry, if the API said",
  },
  exit_codes: {
    "0": "A verdict, including a negative one such as missing.",
    "1": "An error; the JSON line holds error, message and next_step.",
    "3": "The verdict is listed in --fail-on.",
  },
};

function usage(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length), 4);
  const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.describe.summary}`);
  return [
    `${KIT} ${VERSION}`,
    "",
    `Usage: ${KIT} <command> [options]`,
    "",
    "Commands:",
    ...lines,
    "",
    "Every command accepts --describe (JSON contract), --pretty, --data-dir, --pack and --fail-on <verdict,...>.",
    "Commands that ask Jev also accept --dry-run, --fresh and --verbose.",
    `${KIT} <command> --help (or -h) prints that command's contract, the same as --describe.`,
    `${KIT} --describe prints this command list as JSON (it takes only --pretty); ${KIT} --describe <command> is <command> --describe.`,
  ].join("\n");
}

const INDEX_ARGS: ReadonlySet<string> = new Set(["--describe", "--pretty", "--help", "-h"]);

function index(commands: readonly Command[]): Record<string, unknown> {
  return {
    name: KIT,
    version: VERSION,
    usage: `${KIT} <command> [options]`,
    commands: Object.fromEntries(commands.map((c) => [c.name, c.describe.summary])),
    contract: `${KIT} <command> --describe (or --help, -h) prints that command's inputs, outputs, errors, effects and cost.`,
    ...SHARED_CONTRACT,
  };
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length] ?? 0;
}

export function closestFlag(token: string, options: ParseArgsOptionsConfig): string | undefined {
  if (!token.startsWith("--")) return undefined;
  const name = token.slice(2).toLowerCase();
  let best: string | undefined;
  let bestDistance = 3;
  for (const key of Object.keys(options).sort()) {
    const d = editDistance(name, key);
    if (d < bestDistance && d < name.length) {
      best = `--${key}`;
      bestDistance = d;
    }
  }
  return best;
}

function unknownOption(error: unknown, options: ParseArgsOptionsConfig): { token: string; suggestion: string } | null {
  if ((error as { code?: unknown })?.code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") return null;
  const token = /Unknown option '([^']+)'/.exec(error instanceof Error ? error.message : "")?.[1];
  const suggestion = token === undefined ? undefined : closestFlag(token, options);
  return token !== undefined && suggestion !== undefined ? { token, suggestion } : null;
}

function flagsFrom(values: Record<string, unknown>): GlobalFlags {
  const str = (key: string): string | undefined => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  return {
    pretty: values["pretty"] === true,
    dryRun: values["dry-run"] === true,
    fresh: values["fresh"] === true,
    verbose: values["verbose"] === true,
    dataDir: str("data-dir"),
    pack: str("pack"),
    failOn: (str("fail-on") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
}

function asksJev(command: Command, context: Context): boolean {
  return command.asksJev ? command.asksJev(context) : command.describe.errors.includes("no_api_key");
}

function receiptError(io: Io, flags: GlobalFlags, command: string, error: unknown, started: number): void {
  try {
    const code = isRefereeError(error) ? error.code : "internal";
    const receipt = errorReceipt({ command, project: projectId(io.cwd), worktree: checkoutClass(io.cwd), error: code, started, now: io.now(), fresh: flags.fresh, runId: io.env["EVAL_RUN_ID"], sessionId: envSessionId(io.env) });
    appendReceipt(resolveDataDir(io.env, io.home, io.cwd, flags.dataDir), receipt);
  } catch {
    void 0;
  }
}

export async function run(argv: readonly string[], io: Io, commands: readonly Command[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    io.write(usage(commands) + "\n");
    return 0;
  }
  if (name === "--version" || name === "-v") {
    io.write(`${VERSION}\n`);
    return 0;
  }
  const indexCall = INDEX_ARGS.has(name) && argv.includes("--describe");
  const target = indexCall ? argv.findIndex((arg) => !INDEX_ARGS.has(arg)) : -1;
  if (indexCall && target === -1) {
    io.write(JSON.stringify(index(commands), null, argv.includes("--pretty") ? 2 : 0) + "\n");
    return 0;
  }
  if (indexCall && commands.some((c) => c.name === argv[target])) {
    return run([argv[target] ?? "", ...argv.slice(0, target), ...argv.slice(target + 1)], io, commands);
  }
  let pretty = rest.includes("--pretty");
  try {
    const command = commands.find((c) => c.name === name);
    if (!command) {
      const message = indexCall ? `--describe without a command takes only --pretty; '${argv[target]}' is not a command.` : `Unknown command: ${name}`;
      throw new RefereeError("bad_input", message.slice(0, 300), { next_step: `Run ${KIT} --help for the list.` });
    }
    const options = { ...GLOBAL_OPTIONS, ...command.options };
    let parsed;
    try {
      parsed = parseArgs({ args: [...rest], options, allowPositionals: true, strict: true });
    } catch (error) {
      const unknown = unknownOption(error, options);
      const message = unknown ? `Unknown option '${unknown.token}'. Did you mean ${unknown.suggestion}?` : error instanceof Error ? error.message : String(error);
      throw new RefereeError("bad_input", message.slice(0, 300), { next_step: `Run ${KIT} ${name} --describe for the inputs.` });
    }
    const values = parsed.values as Record<string, unknown>;
    const flags = flagsFrom(values);
    pretty = flags.pretty;
    if (values["describe"] === true || values["help"] === true) {
      io.write(JSON.stringify({ command: command.name, ...command.describe, ...SHARED_CONTRACT }, null, pretty ? 2 : 0) + "\n");
      return 0;
    }
    let payload = Object.keys(values).some((key) => Object.hasOwn(command.options, key));
    const tracked: Io = {
      ...io,
      readStdin: async () => {
        const text = await io.readStdin();
        if (text.trim()) payload = true;
        return text;
      },
    };
    const context: Context = { io: tracked, flags, values: parsed.values, positionals: parsed.positionals };
    const started = io.now();
    let result: Result;
    try {
      result = await command.run(context);
    } catch (error) {
      if (!flags.dryRun && payload && asksJev(command, context) && !isReceipted(error)) receiptError(io, flags, command.name, error, started);
      throw error;
    }
    const receipt = typeof result["receipt"] === "string" ? result["receipt"] : null;
    const detailsDir = flags.dryRun ? null : join(resolveDataDir(io.env, io.home, io.cwd, flags.dataDir), "results");
    io.write(render(result, { pretty, detailsDir, receipt }) + "\n");
    const verdict = result["verdict"];
    const failOn = flags.failOn.length > 0 ? flags.failOn : (command.defaultFailOn?.(context) ?? []);
    return typeof verdict === "string" && failOn.includes(verdict) ? 3 : 0;
  } catch (error) {
    const known = isRefereeError(error) ? error : new RefereeError("internal", error instanceof Error ? error.message : String(error));
    io.write(renderError(known, pretty) + "\n");
    return 1;
  }
}
