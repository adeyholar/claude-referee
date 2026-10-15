// Per-request answer cache in cache/<sha256>.json, 30 days by default.
// The key keeps question order, so the written and reversed option orders never share an entry.
// A TYPESAFE_BASE_URL other than the default joins the key; default-endpoint keys are unchanged.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Answer } from "./client.ts";

export interface CachedReply {
  readonly ts: number;
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly inputTokens: number;
}

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function cacheKey(parts: { pack: string; packVersion: string; model: string; questions: unknown; state: unknown; endpoint?: string | undefined }): string {
  const base = [parts.pack, parts.packVersion, parts.model, parts.questions, parts.state];
  return sha256(JSON.stringify(parts.endpoint ? [...base, parts.endpoint] : base));
}

export function readCache(dataDir: string, key: string, now: number, ttlMs: number): CachedReply | null {
  try {
    const entry = JSON.parse(readFileSync(join(dataDir, "cache", `${key}.json`), "utf8")) as CachedReply;
    return now - entry.ts <= ttlMs ? entry : null;
  } catch {
    return null;
  }
}

export function writeCache(dataDir: string, key: string, entry: CachedReply): boolean {
  try {
    const dir = join(dataDir, "cache");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}
