// Reads a Claude Code transcript (JSON lines) and reports the current turn: edits and checks since the last real user prompt, and turn, 12 hex of sha256 over that prompt's uuid (else its line position and the session), never its text.
// Scans backwards for that prompt and forwards from it; only content-free facts are kept, never throws. Marks: truncated checks, subagent reports, a pass from the previous turn. A check keeps only its matched segments (each clipped, joined up to 1,000 characters), never a cd or a heredoc body; node --test on a temp-dir file is Claude's own run, not a check.
// An edit Claude Code refused before applying it (a <tool_use_error> or a denial) is not an edit; other errors still count. An image-only prompt starts a turn. A check's output is read with ANSI colours stripped, as done reads evidence.

import { createHash } from "node:crypto";
import { parseEvidence } from "../runners/index.ts";
import { stripAnsi } from "../runners/util.ts";
import type { CheckRun, CheckStatus, StopFacts } from "./types.ts";

const TASK_MAX = 1500;
const FINAL_MAX = 2000;
const CMD_MAX = 200;
const JOINED_MAX = 1000;
const RESULT_TAIL = 200_000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SEPARATORS = new Set(["&&", "||", "|", "|&", ";", "&", "\n", "(", ")"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["{", "time", "exec", "command", "env"]);
const SCRIPT = /^(test|lint|typecheck|check|build)(:.+)?$/;
const PACKAGE_SCRIPT = /^(ci|verify)(:.+)?$/;
const DIRECT_TOOLS = new Set(["vitest", "jest", "tsc", "eslint", "playwright", "pytest", "ruff", "mypy", "phpunit", "pest", "rspec", "oxlint"]);
const INFO_FLAGS = new Set(["--version", "-V", "--help", "-h"]);
const REDIRECT = /^(?:\d*|&)(?:>>?|<)/;
const REDIRECT_ALONE = /^(?:\d*|&)(?:>>?|<<?<?|>&|<&)$/;
const TEMP_PATH = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/|\$\{?TMPDIR\b)/;
const FAILURE_MARKER = /\berror\b|\bfail(?:ed|ure|ures|ing)?\b|npm ERR!|✖|✗/i;
const USER_LINE = /"type"\s*:\s*"user"/;
const TOOL_RESULT_LINE = /"type"\s*:\s*"tool_result"/;
const TOOL_USE_ID = /"tool_use_id"\s*:\s*"([^"]*)"/g;
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
const TRUNCATED = [/^\s*<persisted-output>/, /\.\.\. \[\d+ (?:lines|characters) truncated\] \.\.\./, /^\s*Command did not complete within its \d+s timeout and was moved to the background/];

interface Block {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown };
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}
interface Entry {
  type?: unknown;
  uuid?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  origin?: { kind?: unknown };
  toolDenialKind?: unknown;
  message?: { content?: unknown };
}
interface Pending {
  cmd: string;
  silent: boolean;
  runs: number;
  mixed: boolean;
  seq: number;
  status: CheckStatus;
  truncated: boolean;
}
interface EditUse {
  path: string;
  seq: number;
  rejected: boolean;
}
interface Token {
  text: string;
  start: number;
  end: number;
}

function withoutHeredocs(command: string): string {
  const out: string[] = [];
  let delimiter: { word: string; strip: boolean } | null = null;
  for (const line of command.split("\n")) {
    if (delimiter) {
      if ((delimiter.strip ? line.replace(/^\t+/, "") : line) === delimiter.word) delimiter = null;
      continue;
    }
    out.push(line);
    const match = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (match) delimiter = { word: match[3] ?? "", strip: match[1] === "-" };
  }
  return out.join("\n");
}

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let begin = -1;
  let quote: string | null = null;
  const flush = (end: number) => {
    if (current) tokens.push({ text: current, start: begin, end });
    current = "";
    begin = -1;
  };
  const word = (i: number, ch: string) => {
    if (begin < 0) begin = i;
    current += ch;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (begin < 0) begin = i;
      quote = ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&") {
      flush(i);
      tokens.push({ text: two, start: i, end: i + 2 });
      i++;
    } else if (ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<")) {
      word(i, ch);
    } else if (ch === "&" && command[i + 1] === ">") {
      flush(i);
      word(i, ch);
    } else if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "(" || ch === ")") {
      flush(i);
      tokens.push({ text: ch, start: i, end: i + 1 });
    } else if (ch === " " || ch === "\t") {
      flush(i);
    } else {
      word(i, ch);
    }
  }
  flush(command.length);
  return tokens;
}

const base = (token: string): string => token.slice(token.lastIndexOf("/") + 1);
const skipFlags = (args: readonly string[]): string[] => {
  let i = 0;
  while ((args[i] ?? "").startsWith("-")) i++;
  return args.slice(i);
};
const withoutRedirects = (args: readonly string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (REDIRECT_ALONE.test(arg)) i++;
    else if (!REDIRECT.test(arg)) out.push(arg);
  }
  return out;
};
const asksInfo = (args: readonly string[], extra: readonly string[] = []): boolean => args.some((a) => INFO_FLAGS.has(a) || extra.includes(a));

// Returns null when the segment is not a check, else whether the check prints nothing on success.
function checkKind(segment: readonly string[]): { silent: boolean; run?: boolean; label?: string } | null {
  let i = 0;
  while (i < segment.length && (ASSIGNMENT.test(segment[i] ?? "") || WRAPPERS.has(segment[i] ?? ""))) i++;
  const first = segment[i];
  if (!first) return null;
  const name = base(first);
  const args = segment.slice(i + 1);
  const cliAt = name === "node" && !args.includes("--test") ? args.findIndex((a) => base(a) === "cli.mjs") : -1;
  if (name === "claude-referee" || cliAt >= 0) {
    const rest = name === "claude-referee" ? args : args.slice(cliAt + 1);
    return rest[0] === "done" && rest.some((a) => a === "--run" || a.startsWith("--run=")) ? { silent: false, run: true, label: "claude-referee done --run" } : null;
  }
  const direct = (tool: string, rest: readonly string[]): { silent: boolean } | null => {
    if (tool === "tsc" || tool === "eslint") return { silent: true };
    if (tool === "vue-tsc") return asksInfo(rest, ["-v"]) ? null : { silent: true };
    if (tool === "ruff") return ["format", "version", "server", "config", "clean"].includes(rest[0] ?? "") ? null : { silent: true };
    if (tool === "prettier") return rest.includes("--check") ? { silent: false } : null;
    if (tool === "pint") return rest.includes("--test") ? { silent: false } : null;
    if (tool === "phpstan") return !asksInfo(rest) && [undefined, "analyse"].includes(skipFlags(withoutRedirects(rest))[0]) ? { silent: false } : null;
    if (tool === "oxlint" && asksInfo(rest)) return null;
    return DIRECT_TOOLS.has(tool) ? { silent: false } : null;
  };
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    const rest = skipFlags(args);
    const sub = rest[0] ?? "";
    if (sub === "exec" || sub === "dlx") {
      const tool = skipFlags(rest.slice(1))[0];
      return tool ? direct(base(tool), skipFlags(rest.slice(1)).slice(1)) : null;
    }
    if (sub === "run" || sub === "run-script") {
      const script = skipFlags(rest.slice(1))[0] ?? "";
      return SCRIPT.test(script) || PACKAGE_SCRIPT.test(script) ? { silent: /^build(:.+)?$/.test(script) && name === "npm" } : null;
    }
    if (sub === "test") return { silent: false };
    if (name !== "npm" && (SCRIPT.test(sub) || (PACKAGE_SCRIPT.test(sub) && sub !== "ci"))) return { silent: false };
    return null;
  }
  if (name === "composer") {
    const script = skipFlags(args)[0] ?? "";
    return SCRIPT.test(script) || script === "analyse" ? { silent: false } : null;
  }
  if (name === "node") {
    const at = args.indexOf("--test");
    if (at < 0 || !args.slice(0, at).every((a) => a.startsWith("-"))) return null;
    return withoutRedirects(args.slice(at + 1)).some((a) => TEMP_PATH.test(a)) ? null : { silent: false };
  }
  if (name === "php") {
    if (args[0] === "-l") return { silent: false };
    return args[0] === "artisan" && args[1] === "test" ? { silent: false } : null;
  }
  if (name === "npx" || name === "bunx") {
    const rest = skipFlags(args);
    return rest[0] ? direct(base(rest[0]), rest.slice(1)) : null;
  }
  if (name === "python" || name === "python3") {
    if (args[0] === "-m" && ["pytest", "mypy", "ruff"].includes(args[1] ?? "")) return direct(args[1] ?? "", args.slice(2));
    return null;
  }
  if (name === "cargo") {
    const rest = args.filter((a) => !a.startsWith("+"));
    const sub = rest[0] ?? "";
    if (["test", "clippy", "build", "nextest"].includes(sub)) return { silent: false };
    return sub === "check" ? { silent: true } : null;
  }
  if (name === "go") {
    const sub = args[0] ?? "";
    if (sub === "test") return { silent: false };
    return sub === "vet" || sub === "build" ? { silent: true } : null;
  }
  if (name === "dotnet") return ["test", "build"].includes(args[0] ?? "") ? { silent: false } : null;
  if (name === "rake") return args[0] === "test" ? { silent: false } : null;
  if (name === "make") return args.some((a) => ["test", "check", "lint", "build"].includes(a)) ? { silent: false } : null;
  if (name === "mvn") return args.includes("test") ? { silent: false } : null;
  if (name === "gradle" || name === "gradlew") return args.some((a) => a === "test" || a === "check") ? { silent: false } : null;
  return direct(name, args);
}

function analyzeCommand(command: string): { silent: boolean; cmd: string; runs: number; mixed: boolean } | null {
  const plain = withoutHeredocs(command);
  const tokens = tokenize(plain);
  let found: { silent: boolean } | null = null;
  let runs = 0;
  let others = 0;
  let segment: Token[] = [];
  let before = "";
  let cmd = "";
  for (const token of [...tokens, { text: ";", start: plain.length, end: plain.length }]) {
    if (!SEPARATORS.has(token.text)) {
      segment.push(token);
      continue;
    }
    const kind = checkKind(segment.map((t) => t.text));
    if (kind) {
      found = found ? { silent: found.silent && kind.silent } : { silent: kind.silent };
      if (kind.run === true) runs++;
      else others++;
      if (cmd.length < JOINED_MAX) {
        const first = segment.find((t) => t.text !== "{");
        const text = kind.label ?? plain.slice(first?.start ?? 0, segment.at(-1)?.end ?? 0).slice(0, CMD_MAX);
        cmd = !cmd ? text : before === ";" || before === "\n" || before === "" ? `${cmd}; ${text}` : `${cmd} ${before} ${text}`;
      }
    }
    if (token.text !== "(" && token.text !== ")") before = token.text;
    segment = [];
  }
  if (!found) return null;
  const masked = tokens.some((t) => t.text === "|" || t.text === "||" || t.text === "|&" || t.text === ";");
  return { silent: found.silent && !masked, cmd: cmd.slice(0, JOINED_MAX), runs, mixed: runs > 0 && others > 0 };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n");
}

function parseLine(line: string): Entry | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as Entry) : null;
  } catch {
    return null;
  }
}

function promptText(entry: Entry | null): string | null {
  if (!entry || entry.type !== "user" || entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) return null;
  const content = entry.message?.content;
  if (Array.isArray(content) && (content as Block[]).some((b) => b && b.type === "tool_result")) return null;
  const text = textOf(content);
  const trimmed = text.trim();
  if (isNotification(entry, trimmed)) return null;
  if (!trimmed) return Array.isArray(content) && (content as Block[]).some((b) => b && b.type === "image") ? "" : null;
  if (trimmed.startsWith("<local-command-") || trimmed.startsWith("[Request interrupted")) return null;
  return text;
}

function isNotification(entry: Entry, trimmed: string): boolean {
  return entry.origin?.kind === "task-notification" || trimmed.startsWith("<task-notification>");
}

function notificationText(entry: Entry | null): string | null {
  if (!entry || entry.type !== "user" || entry.isSidechain === true || entry.isMeta === true) return null;
  const text = textOf(entry.message?.content).trim();
  return text && isNotification(entry, text) ? text : null;
}

// Every real user prompt in order with its timestamp (ISO, "" when missing); used by the weak label hint, never stored.
export function userPrompts(text: string): { ts: string; text: string }[] {
  const out: { ts: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    if (!isPromptCandidate(line)) continue;
    const entry = parseLine(line) as (Entry & { timestamp?: unknown }) | null;
    const found = promptText(entry);
    if (found !== null && typeof entry?.timestamp === "string") out.push({ ts: entry.timestamp, text: found });
  }
  return out;
}

// Every real prompt in order with the offset of its line, its timestamp ("" when missing) and text; the audit cuts the transcript there to replay each stop.
export function promptOffsets(text: string): { lineStart: number; ts: string; text: string }[] {
  const out: { lineStart: number; ts: string; text: string }[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end);
    if (isPromptCandidate(line)) {
      const entry = parseLine(line) as (Entry & { timestamp?: unknown }) | null;
      const found = promptText(entry);
      if (found !== null) out.push({ lineStart: pos, ts: typeof entry?.timestamp === "string" ? entry.timestamp : "", text: found });
    }
    pos = end + 1;
  }
  return out;
}

function isPromptCandidate(line: string): boolean {
  return USER_LINE.test(line) && !TOOL_RESULT_LINE.test(line);
}

function firstPrompt(text: string): string {
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end);
    if (isPromptCandidate(line)) {
      const found = promptText(parseLine(line));
      if (found) return found;
    }
    pos = end + 1;
  }
  return "";
}

// Offset of the line after the last real prompt (0 when none exists), the offset of that prompt's own line, plus its text.
function lastPromptEnd(text: string): { start: number; lineStart: number; prompt: string | null; uuid: string | null } {
  let end = text.length;
  while (end > 0) {
    const nl = text.lastIndexOf("\n", end - 1);
    const line = text.slice(nl + 1, end);
    if (isPromptCandidate(line)) {
      const entry = parseLine(line);
      const found = promptText(entry);
      if (found !== null) return { start: end + 1, lineStart: nl + 1, prompt: found, uuid: typeof entry?.uuid === "string" && entry.uuid ? entry.uuid : null };
    }
    end = nl;
  }
  return { start: 0, lineStart: 0, prompt: null, uuid: null };
}

function turnKey(uuid: string | null, lineStart: number, session: string): string {
  return createHash("sha256")
    .update(uuid === null ? `at:${lineStart}:${session}` : `uuid:${uuid}`)
    .digest("hex")
    .slice(0, 12);
}

export function currentTurn(text: string, session = ""): string | undefined {
  try {
    if (typeof text !== "string" || !text) return undefined;
    const { lineStart, prompt, uuid } = lastPromptEnd(text);
    return prompt === null ? undefined : turnKey(uuid, lineStart, session);
  } catch {
    return undefined;
  }
}

export function scanLength(text: string): number {
  try {
    if (typeof text !== "string" || !text) return 0;
    const { start, lineStart } = lastPromptEnd(text);
    const from = lineStart > 0 ? lastPromptEnd(text.slice(0, lineStart)).start : start;
    return Math.max(0, text.length - from);
  } catch {
    return typeof text === "string" ? text.length : 0;
  }
}

function fullResultText(content: unknown): string {
  return typeof content === "string" ? content : Array.isArray(content) ? (content as Block[]).map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n") : "";
}

function isTruncated(text: string): boolean {
  return TRUNCATED.some((re) => re.test(text));
}

// Texts Claude Code returns when it refuses a tool call before running it (seen in real transcripts, anchored at the start).
const DENIAL_TEXT = [
  /^This command requires approval/,
  /^This Bash command contains multiple operations\. The following parts? require/,
  /^Newline followed by # inside a quoted argument/,
  /^Permission for this (?:action|command) was denied/,
  /^The user doesn't want to (?:proceed with this tool use|take this action right now)/,
  /^PreToolUse:\w+ hook error/,
  /^\S+ is temporarily unavailable, so auto mode cannot determine/,
];

function isDenied(full: string, isError: boolean, denialKind: unknown): boolean {
  if (!isError) return false;
  return (typeof denialKind === "string" && denialKind !== "") || DENIAL_TEXT.some((re) => re.test(full.trimStart()));
}

const editRejected = (full: string, isError: boolean, denialKind: unknown): boolean => isError && (/^\s*<tool_use_error>/.test(full) || isDenied(full, isError, denialKind));

function statusOf(full: string, isError: boolean, silent: boolean, denialKind?: unknown): { status: CheckStatus; truncated: boolean } {
  if (isDenied(full, isError, denialKind)) return { status: "denied", truncated: false };
  const plain = stripAnsi(full);
  const truncated = isTruncated(plain);
  const status = rawStatus(plain.length > RESULT_TAIL ? plain.slice(-RESULT_TAIL) : plain, isError, silent);
  return { status: truncated && status === "passed" ? "unknown" : status, truncated };
}

// `claude-referee done --run` exits 3 unless its verdict is met. Every verdict in the output must be met, and a call made only of run segments needs one per segment (a masked or skipped one leaves it unknown);
// next to another check in the same command, a clean run does not vouch for the other check, so that case falls back to the ordinary reading once no verdict is below met.
function runStatus(full: string, isError: boolean, call: Pending, denialKind?: unknown): { status: CheckStatus; truncated: boolean } {
  if (isDenied(full, isError, denialKind)) return { status: "denied", truncated: false };
  if (isError) return { status: "failed", truncated: false };
  const verdicts = [...full.matchAll(/"verdict":"(\w+)"/g)].map((m) => m[1]);
  if (verdicts.some((v) => v !== "met")) return { status: "failed", truncated: false };
  if (call.mixed) return statusOf(full, isError, call.silent, denialKind);
  return { status: verdicts.length >= call.runs ? "passed" : "unknown", truncated: false };
}

function rawStatus(text: string, isError: boolean, silent: boolean): CheckStatus {
  const ev = parseEvidence(text);
  const bad = ev.runners.some((r) => r.failed + r.errors > 0);
  if (isError || bad || (ev.exit_code !== null && ev.exit_code !== 0)) return "failed";
  if (ev.trust === "parsed" && !ev.conflict) return "passed";
  if (ev.exit_code === 0) return "passed";
  if (silent && !FAILURE_MARKER.test(text)) return "passed";
  return "unknown";
}

interface Scan {
  edits: string[];
  calls: Pending[];
  finalMessage: string;
  lastEdit: number;
  subagentCalls: number;
  subagentReports: number;
}

function scanTurn(text: string, from: number, to: number): Scan {
  const out: Scan = { edits: [], calls: [], finalMessage: "", lastEdit: -1, subagentCalls: 0, subagentReports: 0 };
  const byId = new Map<string, Pending>();
  const editById = new Map<string, EditUse>();
  const editUses: EditUse[] = [];
  const seen = new Set<string>();
  let seq = 0;
  let pos = from;
  while (pos < to) {
    let end = text.indexOf("\n", pos);
    if (end === -1 || end > to) end = to;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (!line.trim()) continue;
    if (TOOL_RESULT_LINE.test(line)) {
      let wanted = false;
      for (const m of line.matchAll(TOOL_USE_ID)) if (byId.has(m[1] ?? "") || editById.has(m[1] ?? "")) wanted = true;
      if (!wanted) continue;
      const entry = parseLine(line);
      if (!entry || entry.isSidechain === true || !Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content as Block[]) {
        const useId = block && block.type === "tool_result" && typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const edit = editById.get(useId);
        if (edit) edit.rejected = editRejected(fullResultText(block.content), block.is_error === true, entry.toolDenialKind);
        const call = byId.get(useId);
        if (!call) continue;
        const text = fullResultText(block.content);
        const result = call.runs > 0 ? runStatus(text, block.is_error === true, call, entry.toolDenialKind) : statusOf(text, block.is_error === true, call.silent, entry.toolDenialKind);
        call.status = result.status;
        call.truncated = result.truncated;
      }
      continue;
    }
    if (line.includes("task-notification") && notificationText(parseLine(line)) !== null) {
      out.subagentReports++;
      continue;
    }
    if (!/"type"\s*:\s*"assistant"/.test(line)) continue;
    const entry = parseLine(line);
    if (!entry || entry.type !== "assistant" || entry.isSidechain === true || !Array.isArray(entry.message?.content)) continue;
    const message = textOf(entry.message.content).trim();
    if (message) out.finalMessage = message;
    for (const block of entry.message.content as Block[]) {
      if (!block || block.type !== "tool_use" || typeof block.name !== "string") continue;
      const id = typeof block.id === "string" ? block.id : "";
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      if (EDIT_TOOLS.has(block.name)) {
        const path = block.name === "NotebookEdit" ? (block.input?.notebook_path ?? block.input?.file_path) : block.input?.file_path;
        if (typeof path === "string" && path) {
          const use: EditUse = { path, seq: seq++, rejected: false };
          editUses.push(use);
          if (id) editById.set(id, use);
        }
      } else if (SUBAGENT_TOOLS.has(block.name)) {
        out.subagentCalls++;
      } else if (block.name === "Bash" && typeof block.input?.command === "string") {
        const kind = analyzeCommand(block.input.command);
        if (!kind) continue;
        const call: Pending = { cmd: kind.cmd, silent: kind.silent, runs: kind.runs, mixed: kind.mixed, seq: seq++, status: "unknown", truncated: false };
        out.calls.push(call);
        if (id) byId.set(id, call);
      }
    }
  }
  for (const use of editUses) {
    if (use.rejected) continue;
    if (!out.edits.includes(use.path)) out.edits.push(use.path);
    out.lastEdit = use.seq;
  }
  return out;
}

const passedAfterLastEdit = (scan: Scan): boolean => scan.calls.some((c) => c.seq > scan.lastEdit && c.status === "passed");

export function analyzeTranscript(text: string, session = ""): StopFacts {
  const empty: StopFacts = { task: "", finalMessage: "", edits: [], checks: [], passedCheckAfterLastEdit: false, marks: { truncatedChecks: 0, subagentCalls: 0, subagentReports: 0, stalePass: false } };
  try {
    if (typeof text !== "string" || !text) return empty;
    const task = firstPrompt(text).slice(0, TASK_MAX);
    const { start, lineStart, prompt, uuid } = lastPromptEnd(text);
    const turn = scanTurn(text, start, text.length);
    const passedCheckAfterLastEdit = turn.lastEdit >= 0 && passedAfterLastEdit(turn);
    let stalePass = false;
    if (turn.edits.length > 0 && !passedCheckAfterLastEdit && lineStart > 0) {
      const previous = lastPromptEnd(text.slice(0, lineStart));
      const before = scanTurn(text, previous.start, lineStart);
      stalePass = before.lastEdit >= 0 ? passedAfterLastEdit(before) : before.calls.some((c) => c.status === "passed");
    }
    const checks: CheckRun[] = turn.calls.map((c) => ({ cmd: c.cmd, status: c.status, ...(c.truncated ? { truncated: true } : {}) }));
    const marks = { truncatedChecks: turn.calls.filter((c) => c.truncated).length, subagentCalls: turn.subagentCalls, subagentReports: turn.subagentReports, stalePass };
    return { task, finalMessage: turn.finalMessage.slice(-FINAL_MAX), edits: turn.edits, checks, passedCheckAfterLastEdit, marks, ...(prompt === null ? {} : { turn: turnKey(uuid, lineStart, session) }) };
  } catch {
    return empty;
  }
}
