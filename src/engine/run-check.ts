// Runs one detected check for `done --run` (docs/decisions/done-run.md): only a command that detect-checks found, in the manifest folder, never an arbitrary string.
// The shell writes stdout and stderr to one pipe so their order holds, gets no stdin and no key variables; the exit code comes from the shell's exit, not from the pipe closing.
// A timeout kills the whole process group and reports 124; if this process is stopped, the group dies with it. Output over the cap keeps its head and its tail; the evidence reader clips further.

import { spawn } from "node:child_process";
import type { Env } from "./config.ts";
import { RefereeError } from "./errors.ts";
import type { Check } from "./detect-checks.ts";

const HEAD_MAX = 1_000_000;
const TAIL_MAX = 4_000_000;
export const KEY_VARIABLES = /^(?:TYPESAFE_API_KEY(?:_CMD)?|EVAL_TYPESAFE_API_KEY|REFEREE_BASE_URL_KEY|CLAUDE_PLUGIN_OPTION_\w*(?:KEY|SECRET|TOKEN)\w*)$/;
const GRACE_MS = 1500;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const DEFAULT_CRITERIA: Readonly<Record<string, string>> = {
  test: "all tests pass",
  typecheck: "the typecheck passes",
  lint: "lint is clean",
  build: "the build succeeds",
  check: "all checks pass",
  ci: "all checks pass",
  verify: "all checks pass",
};

export interface CheckRun {
  readonly output: string;
  readonly code: number;
  readonly timedOut: boolean;
}

const bad = (message: string, next_step: string): RefereeError => new RefereeError("bad_input", message, { next_step });

export function pickCheck(spec: string, set: { checks: readonly Check[] } | null): Check {
  const pipe = "Pipe the check's output instead: <check> 2>&1 | claude-referee done --criteria \"...\" --evidence -";
  if (!set || set.checks.length === 0) throw bad("No check was detected here (a package.json or composer.json script named test, lint, typecheck, build, check, ci or verify; Cargo.toml; go.mod).", pipe);
  const runnable = set.checks.filter((c) => c.runnable);
  const found = runnable.find((c) => c.family === spec.trim() || c.command === spec.trim());
  if (found) return found;
  const list = runnable.map((c) => `${c.family} = ${c.command}`).join("; ");
  throw bad(`--run takes a detected check by family or exact command, not ${JSON.stringify(spec.slice(0, 60))}.`, runnable.length > 0 ? `Detected here: ${list}. ${pipe}` : pipe);
}

export function runCheck(command: string, cwd: string, env: Env, timeoutMs: number): Promise<CheckRun> {
  const clean = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !KEY_VARIABLES.test(e[0])));
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `exec 2>&1; ${command}`], { cwd, env: clean, stdio: ["ignore", "pipe", "ignore"], detached: true });
    let head = Buffer.alloc(0);
    let tail: Buffer[] = [];
    let tailSize = 0;
    let omitted = false;
    let timedOut = false;
    let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      killGroup();
      process.kill(process.pid, signal);
    };
    process.on("exit", killGroup);
    for (const signal of SIGNALS) process.once(signal, onSignal);
    child.stdout.on("data", (chunk: Buffer) => {
      if (head.length < HEAD_MAX) {
        const take = chunk.subarray(0, HEAD_MAX - head.length);
        head = Buffer.concat([head, take]);
        chunk = chunk.subarray(take.length);
      }
      if (chunk.length === 0) return;
      tail.push(chunk);
      tailSize += chunk.length;
      while (tailSize > TAIL_MAX && tail.length > 1) {
        tailSize -= (tail.shift() as Buffer).length;
        omitted = true;
      }
    });
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      process.off("exit", killGroup);
      for (const signal of SIGNALS) process.off(signal, onSignal);
      child.stdout.destroy();
      const output = `${head.toString("utf8")}${omitted ? "\n[… output omitted …]\n" : ""}${Buffer.concat(tail).toString("utf8")}`;
      resolve({ output, code: timedOut ? 124 : (code ?? 1), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      grace = setTimeout(() => finish(null), GRACE_MS);
    }, timeoutMs);
    child.on("exit", (code) => {
      grace ??= setTimeout(() => finish(code), GRACE_MS);
    });
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(127));
  });
}
