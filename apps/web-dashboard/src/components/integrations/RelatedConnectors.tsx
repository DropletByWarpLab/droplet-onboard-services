"use client";

import type { ConnectorDirectoryEntry } from "@/lib/api";
import { DirectoryCard } from "./DirectoryCards";
import { isYours } from "./directory-model";

/**
 * WARP-3965 — "Related connectors": the box names up to four ids (same category,
 * not connected, never the connector itself). An id the directory does not list
 * is dropped rather than drawn as an empty card.
 */
export function RelatedConnectors({
  ids,
  all,
  canManage,
}: {
  ids: readonly string[];
  all: readonly ConnectorDirectoryEntry[];
  canManage: boolean;
}) {
  const related = ids
    .map((id) => all.find((e) => e.id === id))
    .filter((e): e is ConnectorDirectoryEntry => e !== undefined);
  if (related.length === 0) return null;
  return (
    <section aria-label="Related connectors">
      <h2 className="type-title-3" style={{ marginBottom: 8 }}>Related connectors</h2>
      <div className="grid c2">
        {related.map((e) => (
          <DirectoryCard key={e.id} entry={e} yours={isYours(e, canManage)} />
        ))}
      </div>
    </section>
  );
}
