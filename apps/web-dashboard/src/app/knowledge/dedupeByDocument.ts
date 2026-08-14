/**
 * WARP-1790 — collapse a chunk-level "Recently indexed" feed into one row per
 * document.
 *
 * The orchestrator's recent-knowledge endpoint returns `FileContentChunk`
 * rows, so a single file that chunked into N pieces arrived as N cards that
 * differ only by their snippet. QA saw "Adler Essay 2.4 IVC.rtf" four times in
 * a row and read it, reasonably, as the Droplet having indexed the same file
 * over and over — a trust problem on the one surface whose entire promise is
 * "everything your Droplet has indexed".
 *
 * A user thinks in documents, so the list shows documents. The chunk count is
 * kept and surfaced rather than discarded, which also answers the question the
 * ticket raised — whether the repeats were one document chunked many times or
 * genuine duplicate ingestion. Distinct `chunkIdx` values across the group mean
 * the former; a repeated `chunkIdx` would mean the latter and is worth an
 * alert, so `duplicateChunkIdx` reports it instead of hiding it.
 */
import type { KnowledgeChunkItem } from "@/lib/api";

export interface KnowledgeDocumentItem {
  /** The chunk chosen to represent the document (see `representativeFor`). */
  item: KnowledgeChunkItem;
  /** How many chunk rows collapsed into this document. */
  chunkCount: number;
  /**
   * True when two collapsed chunks claimed the SAME `chunkIdx`, which cannot
   * happen within one indexing pass and therefore indicates the document was
   * ingested more than once.
   */
  duplicateChunkIdx: boolean;
}

/**
 * Identity of the *document* a chunk belongs to.
 *
 * `ncFileId` / `brainItemId` are the stable server-side identifiers; `path` is
 * only a fallback for rows where neither is populated. `source` is part of the
 * key because the same path can legitimately exist in both Nextcloud and the
 * brain and those are two different documents.
 */
export function documentKey(item: KnowledgeChunkItem): string {
  if (item.source === "brain" && item.brainItemId) {
    return `brain:${item.brainItemId}`;
  }
  if (item.source === "nextcloud" && item.ncFileId) {
    return `nextcloud:${item.ncFileId}`;
  }
  return `${item.source}:path:${item.path}`;
}

/**
 * Collapse chunks to documents, preserving the input order of first
 * appearance. The feed arrives newest-first, so the first chunk seen for a
 * document is the most recently indexed one and its `indexedAt` is what the
 * day-bucketing should use.
 *
 * The representative chunk is the one with the LOWEST `chunkIdx` in the group,
 * because chunk 0 is the top of the document and reads like an opening line;
 * an arbitrary middle chunk reads like a fragment. Its `indexedAt` is
 * overwritten with the newest value in the group so bucketing stays correct.
 */
export function dedupeByDocument(
  items: KnowledgeChunkItem[],
): KnowledgeDocumentItem[] {
  const order: string[] = [];
  const groups = new Map<string, KnowledgeChunkItem[]>();

  for (const item of items) {
    const key = documentKey(item);
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    const representative = group.reduce((best, candidate) =>
      candidate.chunkIdx < best.chunkIdx ? candidate : best,
    );
    // Newest indexedAt in the group — the feed is newest-first, so that is
    // group[0], but reduce keeps this correct if the ordering ever changes.
    const newestIndexedAt = group.reduce(
      (best, c) => (c.indexedAt > best ? c.indexedAt : best),
      group[0].indexedAt,
    );
    const seen = new Set<number>();
    let duplicateChunkIdx = false;
    for (const c of group) {
      if (seen.has(c.chunkIdx)) {
        duplicateChunkIdx = true;
        break;
      }
      seen.add(c.chunkIdx);
    }

    return {
      item:
        representative.indexedAt === newestIndexedAt
          ? representative
          : { ...representative, indexedAt: newestIndexedAt },
      chunkCount: group.length,
      duplicateChunkIdx,
    };
  });
}
