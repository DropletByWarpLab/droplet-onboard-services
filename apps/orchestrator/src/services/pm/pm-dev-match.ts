/** Match canonical work-item keys in vendor text without prefix collisions. */
export function matchedSequences(identifier: string, texts: readonly (string | null | undefined)[]): number[] {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const key = new RegExp(`\\b${escaped}-(\\d+)\\b`, "gi");
  const found = new Set<number>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(key)) {
      const sequence = Number(match[1]);
      if (Number.isSafeInteger(sequence) && sequence > 0 && String(sequence) === match[1]) found.add(sequence);
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function developmentBranchName(identifier: string, sequence: number, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return `${identifier.toLowerCase()}-${sequence}${slug ? `-${slug}` : ""}`;
}
