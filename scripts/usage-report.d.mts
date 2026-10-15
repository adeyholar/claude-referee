// Type declarations for scripts/usage-report.mjs so tests can import it under strict TypeScript.

export interface Share { k: number; n: number; share: number | null }
export function measures(input: {
  receipts: { id: string; ts: string; command: string; verdict?: string; session_id?: string; pack?: string; outcome?: { trust?: string; evidence_lines?: number } }[];
  stops: { ts: string; session_id?: string; turn?: string; edits?: number; checks?: number }[];
  labels: { id: string; label: "right" | "wrong" }[];
  since: number;
  until?: number;
  excludeSessions?: string[];
  excludePacks?: string[];
}): {
  edit_turns_with_check: Share;
  reask_cleared: Share;
  exit_only_missing: Share & { evidence_lines_under_5: number; evidence_lines_5_or_more: number; evidence_lines_unknown: number };
  labels: Record<string, { right: number; wrong: number }>;
  excluded_by_pack: number;
};
