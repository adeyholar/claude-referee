// Docs watcher: hashes TypeSafe's models.md, api.md, llms.txt and the Jev jaggedness page and compares them with docs-watch.json. Run weekly in CI, no key needed.
// llms.txt also records its link paths, so a change names the added and removed pages (a snapshot without paths still compares by hash).
// Exit 1 when a page changed or can't be fetched; --update records the current hashes. The SDK changelog versions only print ::notice:: lines and never fail.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = "https://docs.typesafe.ai/";
export const PAGES = ["models.md", "api.md", "llms.txt", "model-jaggedness/jev-1.13.md"];
export const SDK_CHANGELOGS = { python: "sdk/python/changelog.md", javascript: "sdk/javascript/changelog.md" };
const FILE = fileURLToPath(new URL("../docs-watch.json", import.meta.url));

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function facts(page, text) {
  if (page === "models.md") return { rate_limits: (text.match(/^.*Rate limits.*\|.*$/m) ?? [""])[0].trim(), models: [...new Set(text.match(/jev-[0-9][\w.]*/g) ?? [])].sort() };
  if (page === "llms.txt") return { links: (text.match(/^- \[/gm) ?? []).length, paths: [...text.matchAll(/^- \[[^\]]*\]\(([^)\s]+)\)/gm)].map((m) => m[1].replace(BASE, "")).sort() };
  if (page === "model-jaggedness/jev-1.13.md") return { reviewed: (text.match(/Last reviewed (\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null };
  return {};
}

export function latestRelease(text) {
  const m = text.match(/v(\d+\.\d+\.\d+)\s*\((\d{4}-\d{2}-\d{2})\)/);
  return m ? { version: m[1], date: m[2] } : null;
}

export function infoNotes(recorded, current) {
  const notes = [];
  for (const name of Object.keys(SDK_CHANGELOGS)) {
    const was = recorded?.[name] ?? null;
    const now = current?.[name] ?? null;
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    notes.push(now ? `TypeSafe ${name} SDK is now ${now.version} (${now.date}), was ${was ? `${was.version} (${was.date})` : "unrecorded"}. Read its changelog: ${BASE}${SDK_CHANGELOGS[name]}` : `TypeSafe ${name} SDK changelog could not be read.`);
  }
  return notes;
}

export function compare(recorded, current) {
  const changed = [];
  for (const page of PAGES) {
    if (recorded[page]?.sha256 === current[page]?.sha256) continue;
    const was = recorded[page]?.facts ?? null;
    const now = current[page]?.facts ?? null;
    if (!Array.isArray(was?.paths) || !Array.isArray(now?.paths)) {
      changed.push({ page, was, now });
      continue;
    }
    const { paths: wasPaths, ...wasFacts } = was;
    const { paths: nowPaths, ...nowFacts } = now;
    changed.push({ page, was: wasFacts, now: nowFacts, added: nowPaths.filter((p) => !wasPaths.includes(p)), removed: wasPaths.filter((p) => !nowPaths.includes(p)) });
  }
  return changed;
}

async function fetchAll() {
  const out = {};
  for (const page of PAGES) {
    const res = await fetch(BASE + page, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${page}: HTTP ${res.status}`);
    const text = await res.text();
    out[page] = { sha256: sha256(text), facts: facts(page, text) };
  }
  out.info = {};
  for (const [name, page] of Object.entries(SDK_CHANGELOGS)) {
    try {
      const res = await fetch(BASE + page, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
      out.info[name] = res.ok ? latestRelease(await res.text()) : null;
    } catch {
      out.info[name] = null;
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = await fetchAll();
  if (process.argv.includes("--update")) {
    writeFileSync(FILE, JSON.stringify(current, null, 2) + "\n");
    console.log("docs-watch.json updated");
  } else {
    const recorded = JSON.parse(readFileSync(FILE, "utf8"));
    for (const note of infoNotes(recorded.info, current.info)) console.log(`::notice::${note}`);
    const changed = compare(recorded, current);
    if (changed.length === 0) console.log("TypeSafe docs unchanged");
    else {
      console.log(JSON.stringify(changed, null, 2));
      console.log("Changed pages above. Read them, update docs and the thresholds if needed, then run: node scripts/docs-watch.mjs --update");
      process.exitCode = 1;
    }
  }
}
