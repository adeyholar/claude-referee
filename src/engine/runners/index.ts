// parseEvidence: turns piped check output into facts (runner counts, exit code, failing names) or "unparsed", which can never become met; merges worst-case.
// GitHub line prefixes (gh run view "job<TAB>step<TAB>ISO ", raw "ISO ") are stripped first; a cancel or timeout annotation marks every parsed runner incomplete.
// A monorepo wrapper's non-zero exit report (turbo, nx, bun, concurrently, npm) counts only when the log's own exit lines show no non-zero code.

import { parsers as compiled } from "./compiled.ts";
import { commandLines } from "./echo.ts";
import { parsers as builds } from "./builds.ts";
import { parsers as bun } from "./bun.ts";
import { parsers as js } from "./js.ts";
import { parsers as more } from "./more.ts";
import { parsers as moreTools } from "./more-tools.ts";
import { parsers as native } from "./native.ts";
import { parsers as oxlint } from "./oxlint.ts";
import { parsers as phpAgent } from "./php-agent.ts";
import { parsers as phpRuby } from "./php-ruby.ts";
import { parsers as python } from "./python.ts";
import { parsers as scenarios } from "./scenarios.ts";
import { parsers as silent } from "./silent.ts";
import { parsers as suites } from "./suites.ts";
import type { RunnerFacts, RunnerParser } from "./types.ts";
import { exitMatches, stripTransport, wrapperExits } from "./util.ts";

export type { RunnerFacts, RunnerParser } from "./types.ts";

export type Trust = "parsed" | "exit_code" | "unparsed";

export interface ParsedEvidence {
  readonly trust: Trust;
  readonly exit_code: number | null;
  readonly exit_lines: readonly string[];
  readonly command_lines: readonly string[];
  readonly runners: readonly RunnerFacts[];
  readonly conflict: boolean;
  readonly lines: number;
}

const PARSERS: readonly RunnerParser[] = [...python, ...js, ...compiled, ...phpRuby, ...more, ...suites, ...scenarios, ...builds, ...native, ...moreTools, ...bun, ...oxlint, ...silent, ...phpAgent];


const HALTED = /^##\[error\](?:The operation was canceled\.|The job (?:running on runner .+ )?has exceeded the maximum execution time|The runner has received a shutdown signal)/m;

export function parseEvidence(text: string): ParsedEvidence {
  const body = stripTransport(text);
  const halted = HALTED.test(body);
  const runners = PARSERS.map((p) => p.parse(body))
    .filter((r): r is RunnerFacts => r !== null)
    .map((r) => (halted ? { ...r, incomplete: true } : r));
  const read = exitMatches(body).map((m) => ({ line: m[0], code: Number(m[2]) }));
  const exits = read.some((e) => e.code !== 0) ? read : [...wrapperExits(body), ...read];
  const exit_lines = exits.slice(0, 3).map((e) => e.line.trim().slice(0, 80));
  const command_lines = commandLines(body, new Set(read.map((e) => e.line.trim())));
  const exit_code = exits.length === 0 ? null : (exits.find((e) => e.code !== 0)?.code ?? 0);
  const conflict = runners.some((r) => r.failed + r.errors > 0) && (runners.some((r) => r.failed + r.errors === 0 && r.passed > 0) || exit_code === 0);
  const trust: Trust = runners.length > 0 ? "parsed" : exit_code !== null ? "exit_code" : "unparsed";
  return { trust, exit_code, exit_lines, command_lines, runners, conflict, lines: text.split("\n").length };
}
