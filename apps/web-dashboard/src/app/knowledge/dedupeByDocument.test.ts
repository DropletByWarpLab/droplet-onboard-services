/**
 * WARP-1790 — chunk feed collapses to one row per document.
 *
 * QA's screenshot: "Adler Essay 2.4 IVC.rtf" four times in a row in
 * Knowledge → Recently indexed, the cards differing only by an internal
 * chunk snippet.
 */
import { describe, it, expect } from "vitest";
import { dedupeByDocument, documentKey } from "./dedupeByDocument";
import type { KnowledgeChunkItem } from "@/lib/api";

function chunk(over: Partial<KnowledgeChunkItem> = {}): KnowledgeChunkItem {
  return {
    id: Math.random().toString(36).slice(2),
    ncFileId: 4210,
    path: "/admin/files/private/Adler Essay 2.4 IVC.rtf",
    chunkIdx: 0,
    snippet: "…",
    indexedAt: "2026-08-06T10:00:00.000Z",
    source: "nextcloud",
    brainItemId: null,
    pageNumber: null,
    ...over,
  };
}

describe("dedupeByDocument", () => {
  it("collapses one document's chunks into a single row", () => {
    // The exact shape from the ticket: one file, four chunks.
    const feed = [
      chunk({ chunkIdx: 3, snippet: "\\lsdpriority47 List Ta…" }),
      chunk({ chunkIdx: 2, snippet: "\\lsdpriority46 List Ta…" }),
      chunk({ chunkIdx: 1, snippet: "…middle…" }),
      chunk({ chunkIdx: 0, snippet: "Adler argues that reading is an active art." }),
    ];
    const docs = dedupeByDocument(feed);

    expect(docs).toHaveLength(1);
    expect(docs[0].chunkCount).toBe(4);
    // Chunk 0 represents the document — it reads like an opening line rather
    // than a fragment from the middle.
    expect(docs[0].item.snippet).toBe(
      "Adler argues that reading is an active art.",
    );
    expect(docs[0].duplicateChunkIdx).toBe(false);
  });

  it("keeps genuinely different documents apart", () => {
    const docs = dedupeByDocument([
      chunk({ ncFileId: 1, path: "/a.txt" }),
      chunk({ ncFileId: 2, path: "/b.txt" }),
      chunk({ ncFileId: 1, path: "/a.txt", chunkIdx: 1 }),
    ]);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.chunkCount)).toEqual([2, 1]);
  });

  it("does not merge the same path across different sources", () => {
    // The same filename can legitimately exist in Nextcloud and in the brain.
    const docs = dedupeByDocument([
      chunk({ source: "nextcloud", ncFileId: 7, path: "/notes.md" }),
      chunk({
        source: "brain",
        ncFileId: 0,
        brainItemId: "brain-7",
        path: "/notes.md",
      }),
    ]);
    expect(docs).toHaveLength(2);
  });

  it("preserves newest-first ordering by first appearance", () => {
    const docs = dedupeByDocument([
      chunk({ ncFileId: 1, path: "/newest.txt", indexedAt: "2026-08-06T12:00:00.000Z" }),
      chunk({ ncFileId: 2, path: "/older.txt", indexedAt: "2026-08-05T12:00:00.000Z" }),
    ]);
    expect(docs.map((d) => d.item.path)).toEqual(["/newest.txt", "/older.txt"]);
  });

  it("buckets a document by its NEWEST chunk, not the representative's date", () => {
    // Chunk 0 is the representative but carries the older timestamp; the
    // document should still bucket as recently indexed.
    const docs = dedupeByDocument([
      chunk({ chunkIdx: 1, indexedAt: "2026-08-06T12:00:00.000Z" }),
      chunk({ chunkIdx: 0, indexedAt: "2026-08-01T09:00:00.000Z" }),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].item.chunkIdx).toBe(0);
    expect(docs[0].item.indexedAt).toBe("2026-08-06T12:00:00.000Z");
  });

  it("flags a repeated chunkIdx as real duplicate ingestion", () => {
    // One indexing pass cannot emit chunk 0 twice, so this is the case the
    // ticket asked us to distinguish rather than silently collapse.
    const docs = dedupeByDocument([
      chunk({ chunkIdx: 0, snippet: "first pass" }),
      chunk({ chunkIdx: 0, snippet: "second pass" }),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].duplicateChunkIdx).toBe(true);
    expect(docs[0].chunkCount).toBe(2);
  });

  it("falls back to the path when no server-side id is populated", () => {
    expect(documentKey(chunk({ ncFileId: 0, path: "/x.txt" }))).toBe(
      "nextcloud:path:/x.txt",
    );
  });

  it("returns an empty list for an empty feed", () => {
    expect(dedupeByDocument([])).toEqual([]);
  });
});
