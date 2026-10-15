// decide: picks among 2-6 options. The best Choice is asked in the written and the reversed order (order moved Jev's pick by up to 0.52,
// asking again by 0.01); when those two tie and there are 3 to 6 options, the other balanced orders follow (docs/decisions/decide-balanced-near-ties.md).
// Per-option micro questions go in one request per option and are reported as flags; they never change the verdict.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { atLeast } from "../../engine/compare.ts";
import { REQUEST_TOKEN_LIMIT, STATE_TOKEN_LIMIT, estimateTokens } from "../../engine/config.ts";
import { RefereeError } from "../../engine/errors.ts";
import { threshold, type Pack, type Thresholds } from "../../engine/pack.ts";
import type { Outcome, Planned } from "../../engine/session.ts";
import type { Command, Context } from "../types.ts";
import { JEV_COST, JEV_EFFECTS, JEV_ERRORS, jevCommand, openPack, question, readSource, str } from "../shared.ts";

export interface Option {
  readonly name: string;
  readonly text: string;
}

interface Micro {
  readonly id: string;
  readonly question: string;
  readonly bad: boolean;
}

export interface Input {
  readonly decision: string;
  readonly context: string | undefined;
  readonly files: readonly string[];
  readonly options: readonly Option[];
  readonly micro: readonly Micro[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const FILE_LIMIT = 100_000;
const FILES_LIMIT = 200_000;

export function parseInput(text: string): Input {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new RefereeError("bad_input", "decide expects a JSON object.", { next_step: "Run decide --describe for the input shape." });
  }
  const bad = (message: string) => new RefereeError("bad_input", message, { next_step: "Run decide --describe for the input shape." });
  if (typeof raw["decision"] !== "string" || !raw["decision"].trim()) throw bad("decision must be a non-empty string.");
  if (!Array.isArray(raw["options"]) || raw["options"].length < 2 || raw["options"].length > 6) throw bad("options must list 2 to 6 options.");
  const options = raw["options"].map((o: unknown, i): Option => {
    if (typeof o === "string" && o.trim()) return { name: `o${i + 1}`, text: o };
    const { name, text: body } = (o ?? {}) as { name?: unknown; text?: unknown };
    if (typeof name !== "string" || !NAME.test(name)) throw bad(`Option ${i + 1} needs a short name: letters, digits, '_', '.', '-'.`);
    if (/^\d+$/.test(name)) {
      throw new RefereeError("bad_input", `Option ${i + 1} is named "${name}"; a name made only of digits loses its place in the reversed order.`, {
        next_step: "Use a name that starts with a letter, e.g. o1.",
      });
    }
    if (typeof body !== "string" || !body.trim()) throw bad(`Option ${name} needs a text.`);
    return { name, text: body };
  });
  if (new Set(options.map((o) => o.name)).size !== options.length) throw bad("Option names must be unique.");
  const files = raw["context_files"] ?? [];
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) throw bad("context_files must be an array of paths.");
  const micro = (Array.isArray(raw["micro"]) ? raw["micro"] : []).map((m: unknown, i): Micro => {
    const { id, question: q, bad: isBad } = (m ?? {}) as { id?: unknown; question?: unknown; bad?: unknown };
    if (typeof q !== "string" || !q.trim()) throw bad(`micro[${i}] needs a question.`);
    return { id: typeof id === "string" && NAME.test(id) ? id : `m${i + 1}`, question: q, bad: isBad === true };
  });
  if (micro.length > 8) throw bad("At most 8 micro questions.");
  return {
    decision: raw["decision"],
    context: typeof raw["context"] === "string" && raw["context"].trim() ? raw["context"] : undefined,
    files: files as string[],
    options,
    micro,
  };
}

function readContextFiles(context: Context, files: readonly string[]): { contents: Record<string, string>; read: { path: string; bytes: number }[] } {
  const contents: Record<string, string> = {};
  const read: { path: string; bytes: number }[] = [];
  let total = 0;
  for (const file of files) {
    const path = resolve(context.io.cwd, file);
    let bytes: number;
    try {
      bytes = statSync(path).size;
    } catch {
      throw new RefereeError("bad_input", `Cannot read context file: ${file}`);
    }
    if (bytes > FILE_LIMIT) throw new RefereeError("too_large", `Context file over 100 KB: ${file}`, { next_step: "Pass a smaller excerpt in context instead." });
    total += bytes;
    if (total > FILES_LIMIT) throw new RefereeError("too_large", "Context files over 200 KB in total.", { next_step: "Pass fewer or smaller files." });
    contents[file] = readFileSync(path, "utf8");
    read.push({ path: file, bytes });
  }
  return { contents, read };
}

function runnerUp(p: Readonly<Record<string, number>>, lean: string): string {
  return Object.entries(p).filter(([name]) => name !== lean).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "the other options";
}

function leader(p: Readonly<Record<string, number>>): string | null {
  const [first, second] = Object.entries(p).sort((a, b) => b[1] - a[1]);
  return first && second?.[1] === first[1] ? null : (first?.[0] ?? "");
}

export interface DecidePlan {
  readonly planned: Planned[];
  readonly perOption: boolean;
  readonly followUp: (byId: ReadonlyMap<string, Outcome["answers"]>) => Planned[];
  readonly summarize: (byId: ReadonlyMap<string, Outcome["answers"]>) => { mean: Record<string, number>; lean: string; verdict: "clear" | "weak" | "tie"; disagree: boolean; tied: boolean; orders: number };
}

const rotate = <T>(list: readonly T[], i: number): T[] => [...list.slice(i), ...list.slice(0, i)];

export function planDecide(pack: Pack, thresholds: Thresholds | undefined, state: Record<string, unknown>, options: readonly Option[], ablation?: "reversed", balancedOrders = true): DecidePlan {
  const best = question(pack, "decide.best");
  const ask = (list: readonly Option[]): Questions => ({ best: { ...best, criteria: Object.fromEntries(list.map((o) => [o.name, o.text])) } as Questions[string] });
  const stateTokens = estimateTokens(JSON.stringify(state));
  const questionTokens = estimateTokens(JSON.stringify(ask(options)));
  const perOption = stateTokens + questionTokens > Math.min(STATE_TOKEN_LIMIT, REQUEST_TOKEN_LIMIT);
  const fit = question(pack, "decide.fit");
  const planned: Planned[] = perOption
    ? options.map((o) => ({ id: `fit:${o.name}`, state: { ...state, option: o.text }, questions: { fit } }))
    : [
        { id: "written", state: state as Planned["state"], questions: ask(options) },
        ...(ablation === "reversed" ? [] : [{ id: "reversed", state: state as Planned["state"], questions: ask([...options].reverse()) }]),
      ];
  const qid = perOption ? "decide.fit" : "decide.best";
  const clearAt = threshold(pack, thresholds, qid, "clear", 0.85);
  const margin = threshold(pack, thresholds, qid, "margin", 0.1);
  const balanced: Planned[] =
    perOption || ablation || !balancedOrders || options.length < 3
      ? []
      : Array.from({ length: options.length - 1 }, (_, k) => rotate(options, k + 1)).flatMap((order, k) => [
          { id: `rot:${k + 1}`, state: state as Planned["state"], questions: ask(order) },
          { id: `revrot:${k + 1}`, state: state as Planned["state"], questions: ask([...order].reverse()) },
        ]);
  const probs = (byId: ReadonlyMap<string, Outcome["answers"]>, id: string): Record<string, number> | null => {
    const answer = byId.get(id)?.["best"];
    return answer?.type === "choice" ? { ...(answer.probabilities as Record<string, number>) } : null;
  };
  const summarize: DecidePlan["summarize"] = (byId) => {
    const mean: Record<string, number> = {};
    let disagree = false;
    let tied = false;
    let orders = 0;
    if (perOption) {
      for (const o of options) {
        const answer = byId.get(`fit:${o.name}`)?.["fit"];
        const criteria = (fit as { criteria?: unknown }).criteria;
        const levels = Array.isArray(criteria) ? criteria.length : 5;
        mean[o.name] = answer?.type === "score" ? answer.score / Math.max(levels - 1, 1) : 0;
      }
    } else {
      const written = probs(byId, "written") ?? {};
      const reversed = ablation === "reversed" ? written : (probs(byId, "reversed") ?? {});
      const [w, r] = [leader(written), leader(reversed)];
      tied = w === null || r === null;
      disagree = tied || w !== r;
      const extra = balanced.map((p) => probs(byId, p.id));
      const all = extra.length > 0 && extra.every((x) => x !== null) ? [written, reversed, ...(extra as Record<string, number>[])] : [written, reversed];
      for (const o of options) mean[o.name] = all.reduce((sum, p) => sum + (p[o.name] ?? 0), 0) / all.length;
      orders = ablation === "reversed" ? 1 : all.length;
    }
    const ranked = Object.entries(mean).sort((a, b) => b[1] - a[1]);
    const [lean = "", p1 = 0] = ranked[0] ?? [];
    const p2 = ranked[1]?.[1] ?? 0;
    const unanimous = orders <= 2;
    const blocked = unanimous && disagree;
    const verdict = !blocked && atLeast(p1, clearAt) && atLeast(p1 - p2, margin) ? "clear" : !blocked && atLeast(p1 - p2, margin) ? "weak" : "tie";
    return { mean, lean, verdict, disagree, tied, orders };
  };
  const followUp: DecidePlan["followUp"] = (byId) => (balanced.length > 0 && summarize(byId).verdict === "tie" ? balanced : []);
  return { planned, perOption, followUp, summarize };
}

export const decide: Command = {
  name: "decide",
  describe: {
    summary: "Score 2-6 options against your context, asking in two option orders, and in a balanced set of orders when those two tie (3 to 6 options).",
    inputs: {
      "stdin or --in <file>":
        'JSON: {"decision": string, "options": [{"name", "text"}] or [string], "context"?: string, "context_files"?: [path], "micro"?: [{"id", "question", "bad"?}]}',
      name: "Up to 40 letters, digits, '_', '.', '-'; not only digits.",
      context_files: "Read by the CLI, so Claude doesn't retype them. Max 100 KB each, 200 KB in total.",
      micro: "Optional yes/no rules asked once per option; reported in flags, never part of the verdict. bad: true means yes is bad. Without micro, a pack's decide.micro.* questions are used; a threshold of {\"bad\": 1} marks yes as bad.",
    },
    outputs: {
      verdict: "clear, weak or tie",
      lean: "The option with the highest mean probability",
      p: "Mean probability per option name across the orders asked (per_option mode: normalised fit score)",
      order_disagrees: "True when the written and reversed orders picked different leaders, or either order had an exact tie at the top; with two orders the verdict is then tie",
      orders: "How many option orders were asked: 2, or 2n when the first two tie and there are 3 to 6 options (every option in every slot, plus reversals; the verdict then comes from their mean)",
      mode: "per_option when the options don't fit one request",
      read: "Context files read, with sizes",
      flags: "Micro rules that failed, by option and rule id",
      next_step: "For weak and tie: add the missing fact; don't ask again",
    },
    errors: [...JEV_ERRORS],
    effects: JEV_EFFECTS,
    cost: `${JEV_COST} decide makes 2 requests; when those tie and there are 3 to 6 options, 2n - 2 more (4 to 10); plus one per option with micro questions.`,
  },
  options: { in: { type: "string" } },
  async run(context) {
    const input = parseInput(await readSource(context, str(context, "in"), "decision JSON"));
    const { contents, read } = readContextFiles(context, input.files);
    const { pack, project } = openPack(context);
    const state = {
      decision: input.decision,
      ...(input.context ? { context: input.context } : {}),
      ...(read.length ? { context_files: contents } : {}),
    };
    const stateTokens = estimateTokens(JSON.stringify(state));
    if (stateTokens > STATE_TOKEN_LIMIT) {
      const largest = Object.entries(contents).sort((a, b) => b[1].length - a[1].length)[0];
      throw new RefereeError("too_large", `The context is too large for one Jev request (about ${stateTokens} tokens, limit ${STATE_TOKEN_LIMIT}).`, {
        next_step: largest ? `Trim context or context_files; the largest file is ${largest[0]} (about ${estimateTokens(largest[1])} tokens).` : "Trim context.",
      });
    }

    const plan = planDecide(pack, project?.thresholds, state, input.options);
    const { perOption } = plan;
    const planned: Planned[] = [...plan.planned];
    const packMicro: Micro[] = Object.entries(pack.questions)
      .filter(([id, q]) => id.startsWith("decide.micro.") && q.type === "noul")
      .map(([id]) => ({ id: id.slice("decide.micro.".length), question: "", bad: (pack.thresholds[id]?.["bad"] ?? 0) >= 1 }));
    const micros = input.micro.length > 0 ? input.micro : packMicro;
    if (micros.length > 0) {
      const micro: Questions = Object.fromEntries(
        micros.map((m) => [m.id, input.micro.length > 0 ? { type: "noul", instructions: m.question } : question(pack, `decide.micro.${m.id}`)]),
      );
      for (const o of input.options) planned.push({ id: `micro:${o.name}`, state: { ...state, option: o.text }, questions: micro });
    }
    const byIdOf = (outcomes: readonly Outcome[]) => new Map(outcomes.map((o) => [o.id, o.answers]));
    return jevCommand(context, "decide", pack, planned, (outcomes: Outcome[]) => {
      const byId = byIdOf(outcomes);
      const { mean, lean, verdict, disagree, tied, orders } = plan.summarize(byId);
      const flags = input.options.flatMap((o) =>
        micros.flatMap((m) => {
          const answer = byId.get(`micro:${o.name}`)?.[m.id];
          const p = answer?.type === "noul" ? answer.noul : null;
          return p !== null && (m.bad ? p >= 0.7 : p <= 0.3) ? [{ option: o.name, rule: m.id, p }] : [];
        }),
      );
      const why = tied ? "An option order had an exact tie at the top. " : disagree ? "The two option orders picked different leaders. " : "";
      return {
        ok: true,
        verdict,
        lean,
        p: mean,
        ...(perOption ? { mode: "per_option" } : { order_disagrees: disagree, orders }),
        ...(read.length ? { read } : {}),
        ...(flags.length ? { flags } : {}),
        next_step:
          verdict === "clear"
            ? undefined
            : `${why}Add the missing fact: one that separates ${lean} from ${runnerUp(mean, lean)} (what each costs or breaks, how easily it is undone). If easy to undo, go with ${lean}. Asking again won't change it.`,
      };
    }, { followUp: (outcomes) => plan.followUp(byIdOf(outcomes)) });
  },
};
