// Type declarations for scripts/verify-release.mjs so tests can import it under strict TypeScript.

export function integrityOf(bytes: Uint8Array): string;
export function compareTrees(
  tarball: Map<string, Buffer>,
  tag: Map<string, Buffer>,
): { identical: string[]; different: string[]; only_in_tarball: string[]; only_in_tag: string[] };
