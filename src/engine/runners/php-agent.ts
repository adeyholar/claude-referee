// Pint, PHPStan and Rector agent-format JSON summaries (docs/decisions/php-agent-json.md): one object per run, seen glued to other output.
// An object counts only at a line start, after a `N:` grep prefix, or right after another summary's closing brace; text before it on the line rules it out.
// Facts are counts and fixed sentences (never paths, file names or messages); the worst result per tool wins; `fixed` (files rewritten) marks the run incomplete.

import type { RunnerFacts, RunnerParser } from "./types.ts";
import { buildOnly, mk, prepare } from "./util.ts";

type Result = "passed" | "failed" | "fixed";
interface Summary {
  readonly result: Result;
  readonly errors: number;
  readonly changed: number;
}

const HEAD = /\{"tool":"(pint|phpstan|rector)","result":"(passed|failed|fixed)"/y;
const LEAD = /^\s*(?:\d+:)?/;
const PHPSTAN_ERRORS = /^\{"tool":"phpstan","result":"\w+","errors":(\d+)/;
const RECTOR_TOTALS = /^\{"tool":"rector","result":"\w+","totals":\{"changed_files":(\d+),"errors":(\d+)\}/;

function objectEnd(line: string, from: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return line.length;
}

function summariesIn(line: string): Map<string, Summary[]> {
  const found = new Map<string, Summary[]>();
  let at = (LEAD.exec(line) as RegExpExecArray)[0].length;
  for (;;) {
    HEAD.lastIndex = at;
    const head = HEAD.exec(line);
    if (!head) return found;
    const end = objectEnd(line, at);
    const text = line.slice(at, end);
    const [tool, result] = [head[1] as string, head[2] as Result];
    const rector = RECTOR_TOTALS.exec(text);
    const errors = Number(PHPSTAN_ERRORS.exec(text)?.[1] ?? rector?.[2] ?? 0);
    found.set(tool, [...(found.get(tool) ?? []), { result, errors, changed: Number(rector?.[1] ?? 0) }]);
    at = end;
  }
}

function factsFor(tool: string, all: readonly Summary[]): RunnerFacts {
  const errors = Math.max(...all.map((s) => s.errors));
  const changed = Math.max(...all.map((s) => s.changed));
  const failed = errors > 0 || changed > 0 || all.some((s) => s.result === "failed");
  const fixed = !failed && all.some((s) => s.result === "fixed");
  if (tool === "rector") {
    const summary = failed ? `rector would change ${changed} files and reported ${errors} errors` : "rector dry run found nothing to change";
    return buildOnly(mk("rector", { failed: changed, errors }, [], summary, false));
  }
  const reported = Math.max(errors, failed ? 1 : 0);
  const summary = tool === "phpstan" ? (failed ? `phpstan reported ${reported} errors` : "phpstan reported no errors") : fixed ? "pint rewrote files (result fixed)" : failed ? "pint reported style issues (result failed)" : "pint reported no style issues";
  return buildOnly(mk(tool, { errors: reported }, [], summary, fixed));
}

const runner = (tool: string): RunnerParser => ({
  name: tool,
  parse(text) {
    const all = prepare(text).flatMap((line) => summariesIn(line).get(tool) ?? []);
    return all.length === 0 ? null : factsFor(tool, all);
  },
});

export const parsers: readonly RunnerParser[] = ["pint", "phpstan", "rector"].map(runner);
