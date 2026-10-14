// Maintainer check, not shipped: runs the real `ui` server on synthetic data and drives headless Firefox over WebDriver BiDi (no driver download).
// Usage: node --experimental-strip-types scripts/check-ui-firefox.mjs <light|dark> [--out <dir>] ; FIREFOX=<path> overrides the binary. Exit 0 only if every check passes.
// --out keeps screenshots (flow, queue, overview, 375 px). The favicon console error (img-src 'none') is counted and reported, not failed: the policy stays strict.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2];
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
if (mode !== "light" && mode !== "dark") {
  console.log(JSON.stringify({ ok: false, error: "usage: node --experimental-strip-types scripts/check-ui-firefox.mjs <light|dark> [--out <dir>]" }));
  process.exit(1);
}
const { startUi } = await import(join(root, "src/ui/server.ts"));
const { appendStop } = await import(join(root, "src/engine/stopgate/stops.ts"));
const { appendReceipt } = await import(join(root, "src/engine/receipts.ts"));
const { writeCache } = await import(join(root, "src/engine/cache.ts"));
const { projectId } = await import(join(root, "src/engine/datadir.ts"));

if (out) mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "ui-firefox-"));
const dir = (name) => { const d = join(scratch, name); mkdirSync(d); return d; };
const dataDir = dir("data");
const cwd = dir("cwd");
const home = dir("home");
const profile = dir("profile");
const downloads = dir("downloads");
const project = projectId(cwd);
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
const stop = (id, ts, extra = {}) => ({ id, ts, session_id: "sess-ui", project, mode: "shadow", edits: 2, checks: 1, ms: 800, decision: { claims_done: 0.9, claims_verified: 0.1, verification_applies: 1, outcome: {}, would_block: true }, task_excerpt: `add a page ${XSS}`, final_excerpt: `done ${XSS}`, ...extra });
appendStop(dataDir, stop("sone", "2026-09-29T09:06:00.000Z"));
appendStop(dataDir, stop("stwo", "2026-09-29T09:16:00.000Z"));
appendStop(dataDir, stop("sthree", "2026-09-29T09:26:00.000Z", { decision: { claims_done: 0.2, claims_verified: 0.1, verification_applies: 1, outcome: {}, would_block: false } }));
const key = "a".repeat(64);
writeCache(dataDir, key, { ts: Date.parse("2026-09-30T11:00:00Z"), model: "jev-1.13.0", inputTokens: 1234, answers: { c1: { type: "noul", noul: 0.98 } } });
const receipt = (id, ts, extra = {}) => ({ id, ts, command: "done", project, requests: 1, cached: 0, input_tokens: 100, cost_usd: 0.00001, ms: 500, ...extra });
appendReceipt(dataDir, receipt("rA", "2026-09-30T11:00:00.000Z", { verdict: "met", pack: "generic", model: "jev-1.13.0", input_tokens: 1234, ms: 820, cache_keys: [key], session_id: "abcdef1234567" }));
appendReceipt(dataDir, receipt("rB", "2026-09-30T10:00:00.000Z", { command: "claims", verdict: "supported" }));
const ui = await startUi({ dataDir, cwd, home, env: { HOME: home }, now: () => Date.parse("2026-09-30T12:00:00Z") });

const prefs = { "layout.css.prefers-color-scheme.content-override": mode === "dark" ? 0 : 1, "browser.download.folderList": 2, "browser.download.dir": downloads, "browser.download.useDownloadDir": true, "browser.download.always_ask_before_handling_new_types": false };
writeFileSync(join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));
const ff = spawn(process.env.FIREFOX ?? "firefox", ["--headless", "--remote-debugging-port=0", "--profile", profile, "--no-remote", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const endpoint = await new Promise((resolve) => {
  let text = "";
  ff.stderr.on("data", (c) => { text += c; const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(text); if (m) resolve(m[1]); });
  ff.on("error", () => resolve(null));
  setTimeout(() => resolve(null), 30000).unref();
});
const finish = async (code) => { ff.kill(); await ui.close(); rmSync(scratch, { recursive: true, force: true }); process.exit(code); };
if (!endpoint) {
  console.log(JSON.stringify({ ok: false, error: "firefox did not report a WebDriver BiDi endpoint (is it installed? set FIREFOX=<path>)" }));
  await finish(1);
}
const ws = new WebSocket(`${endpoint}/session`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const logs = [];
const prompts = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.type === "error" ? p.rej(new Error(`${m.error}: ${m.message}`)) : p.res(m.result); }
  else if (m.method === "log.entryAdded") logs.push({ level: m.params.level, text: String(m.params.text).slice(0, 200) });
  else if (m.method === "browsingContext.userPromptOpened") prompts.push(m.params.type);
};
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
const session = await send("session.new", { capabilities: {} });
await send("session.subscribe", { events: ["log.entryAdded", "browsingContext.userPromptOpened"] });
const context = (await send("browsingContext.getTree", {})).contexts[0].context;
const evalJs = async (expression, ownership = "none") => {
  const r = await send("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: ownership });
  if (r.type !== "success") throw new Error(String(r.exceptionDetails?.text ?? "script error").slice(0, 300));
  return r.result;
};
const json = async (expression) => JSON.parse((await evalJs(`JSON.stringify(${expression})`)).value);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); };
const waitFor = async (expression, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await json(`Boolean(${expression})`)) return true; } catch {} await sleep(150); } return false; };
const press = (k) => send("input.performActions", { context, actions: [{ type: "key", id: "kb", actions: [{ type: "keyDown", value: k }, { type: "keyUp", value: k }] }] });
const clickNode = async (expression) => {
  const sharedId = (await evalJs(expression, "root")).sharedId;
  if (!sharedId) throw new Error(`nothing to click: ${expression}`);
  await send("input.performActions", { context, actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: 0, y: 0, origin: { type: "element", element: { sharedId } } }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
};
const clickText = (text) => clickNode(`[...document.querySelectorAll("button")].find((b) => b.textContent.startsWith(${JSON.stringify(text)}))`);
const shot = async (name) => { if (out) writeFileSync(join(out, `${mode}-${name}.png`), Buffer.from((await send("browsingContext.captureScreenshot", { context, origin: "viewport" })).data, "base64")); };
const fits = () => json("document.documentElement.scrollWidth <= window.innerWidth");

try {
  await send("browsingContext.setViewport", { context, viewport: { width: 1100, height: 800 }, devicePixelRatio: 1 });
  await send("browsingContext.navigate", { context, url: ui.urlWithToken, wait: "complete" });
  check("flow tab loads with events", await waitFor(`document.querySelectorAll("main details").length >= 1`));
  check("five tabs", (await json(`document.querySelectorAll("#tabs button").length`)) === 5);
  check("token left the URL", (await json(`location.hash === "" && !location.href.includes("#t=")`)) === true);
  check(`prefers-color-scheme is ${mode}`, (await json(`matchMedia("(prefers-color-scheme: dark)").matches`)) === (mode === "dark"));
  await shot("flow");
  await clickNode(`document.querySelector("main details summary")`);
  check("click opens Jev's answers table", await waitFor(`document.querySelector("main details")?.open && document.querySelector("main details table")`));
  await shot("flow-open");
  await clickText("Labelling queue");
  check("queue lists two stops", await waitFor(`document.querySelector("main h2")?.textContent.includes(": 2")`));
  check("excerpts are text, nothing injected", (await json(`document.querySelectorAll("main img, main script").length === 0 && window.__xss === undefined`)) === true);
  check("markup shows as text", (await json(`document.querySelector("main pre").textContent.includes("<img src=x")`)) === true);
  await shot("queue");
  await press("s");
  check("S skips to stop 2 of 2", await waitFor(`document.querySelector("main .card")?.getAttribute("aria-label") === "Stop 2 of 2"`));
  await press("b");
  check("B goes back to stop 1 of 2", await waitFor(`document.querySelector("main .card")?.getAttribute("aria-label") === "Stop 1 of 2"`));
  await press("r");
  check("R labels right, one left", await waitFor(`document.querySelector("main h2")?.textContent.includes(": 1") && document.getElementById("status").textContent.includes("labelled right")`));
  await clickText("Wrong");
  check("click labels wrong, queue empty", await waitFor(`document.querySelector("main")?.textContent.includes("Nothing to label")`));
  const labels = existsSync(join(dataDir, "labels.jsonl")) ? readFileSync(join(dataDir, "labels.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).label).sort() : [];
  check("labels.jsonl holds right and wrong", labels.join() === "right,wrong", labels);
  await clickText("Overview");
  check("overview renders tables", await waitFor(`document.querySelectorAll("main table").length >= 2`));
  await shot("overview");
  await clickText("Privacy");
  check("privacy renders tables", await waitFor(`document.querySelectorAll("main table").length >= 2`));
  await clickText("Export");
  check("three export buttons", await waitFor(`document.querySelectorAll("main button").length === 3`));
  await clickText("Stops");
  const files = await (async () => { const end = Date.now() + 6000; while (Date.now() < end) { const f = readdirSync(downloads).filter((n) => !n.endsWith(".part")); if (f.length) return f; await sleep(200); } return []; })();
  check("export file downloaded", files.length >= 1, files);
  await clickText("Flow");
  await waitFor(`document.querySelectorAll("main details").length >= 1`);
  await send("browsingContext.setViewport", { context, viewport: { width: 375, height: 800 }, devicePixelRatio: 1 });
  await sleep(400);
  check("375 px: no horizontal overflow (flow)", (await fits()) === true);
  await shot("flow-375");
  await clickText("Overview");
  await waitFor(`document.querySelectorAll("main table").length >= 2`);
  check("375 px: no horizontal overflow (overview)", (await fits()) === true);
  await shot("overview-375");
  check("no alert or prompt opened", prompts.length === 0, prompts);
  const favicon = logs.filter((l) => /favicon\.ico/.test(l.text)).length;
  const bad = logs.filter((l) => (l.level === "error" || /content-security-policy/i.test(l.text)) && !/favicon\.ico/.test(l.text));
  check("no other console errors or CSP violations", bad.length === 0, bad.slice(0, 3));
  check(`favicon console errors counted, not failed: ${favicon}`, true);
} catch (error) {
  check("run completed", false, String(error instanceof Error ? error.message : error).slice(0, 300));
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ ok: failed.length === 0, mode, firefox: session.capabilities.browserVersion, checks: results.length, failed: failed.length, results }));
ws.close();
await finish(failed.length ? 1 : 0);
