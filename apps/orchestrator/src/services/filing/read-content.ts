/**
 * WARP-2730 (ADR-048) — read a source's text back out of the RAG index.
 *
 * The filing worker does NOT re-extract documents. `services/file-indexer`
 * already opened the PDF, ran the extractor chain, chunked it and wrote the
 * text to `FileContentChunk`; that is the whole point of the design being one
 * hop rather than a second pipeline. This module reads those rows back.
 *
 * Three things have to be undone first, and each one is load-bearing:
 *
 *   1. WARP-435's contextual header — every chunk is stored as
 *      `Document: {filename} / Section: {a > b}\n\n{body}`. Left on, the header
 *      repeats the FILENAME once per chunk, and filenames are PHI (WARP-1983):
 *      `J Smith perio chart.pdf` would be handed to the model 40 times over in
 *      a document whose body says nothing clinical at all.
 *   2. `CHUNK_OVERLAP_RATIO` (0.2) — consecutive chunks share a fifth of their
 *      text. Concatenated naively, a five-figure total appears twice and an
 *      invoice number appears twice, which is exactly the shape that makes a
 *      model emit two money documents for one invoice.
 *   3. Order — `ORDER BY "chunkIdx"`, because the row order Postgres returns
 *      without it is not the document's order and a contract read out of order
 *      is a contract the model gets wrong.
 *
 * 🔴 READER AUTHORIZATION. This read is keyed by `ncFileId`, which escapes
 * `resolveChunkOwnerIds` — that helper omits the `__household__` / `__dept_*`
 * sentinel owners, so an ncFileId-keyed read sees rows an owner-scoped one
 * would not. The only other ncFileId-keyed reader on the box
 * (`routes/files.ts`, pinned by `files-content.test.ts`) is safe because it
 * returns a PATH and re-authorizes against the caller's own Nextcloud token.
 * There is no equivalent here — the worker has no caller — so the CALLER of
 * this module (worker.ts) constrains which files it will claim at all, to the
 * enabling owner's own space plus `__household__`. This function therefore
 * takes the permitted owner set and filters on it: defence in depth, and the
 * place a future department grant (WARP-2026) plugs in.
 */
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/** Bounds one read. A 400-chunk document is already ~200 pages. */
export const MAX_CHUNKS = 400;

/** What we are willing to put in front of the model, in characters. */
export const MAX_TEXT_CHARS = 20_000;
const HEAD_CHARS = 14_000;
const TAIL_CHARS = 6_000;

/**
 * How far back to look for an overlap when joining two chunks. The overlap is
 * nominally 20% of the chunk, but the chunker is sentence-aware and the actual
 * shared span varies, so we search a window rather than trusting the ratio.
 */
const MAX_OVERLAP_SCAN = 2_000;

export interface SourceContent {
  text: string;
  chunkCount: number;
  /** Set when the document was longer than `MAX_TEXT_CHARS` and was folded. */
  truncated: boolean;
  /**
   * Cheap content fingerprint: chunk count plus a hash of the first and last
   * chunk. Compared BEFORE any model call — see the `extractFingerprint`
   * comment in schema.prisma for why a mere `updatedAt` bump is not a change.
   */
  fingerprint: string;
}

export type ReadContentResult =
  | { ok: true; content: SourceContent }
  | { ok: false; reason: "no_text" | "encrypted_content" };

interface ChunkRow {
  text: string;
  sensitivity: string;
}

/**
 * Strip the WARP-435 header from one chunk.
 *
 * Deliberately conservative: only a FIRST line starting with `Document:`
 * followed by a blank line is removed. `format_chunk_with_header` always emits
 * exactly that shape (`_fit_header` degrades to the bare string `"Document:"`
 * in its worst case, which this still matches), and a body line that happens
 * to begin with the word is not at position zero. Being wrong in the other
 * direction — eating a real first line — would silently delete the top of
 * every invoice, which is where the counterparty name lives.
 */
export function stripChunkHeader(chunk: string): string {
  if (!chunk.startsWith("Document:")) return chunk;
  const sep = chunk.indexOf("\n\n");
  if (sep === -1) {
    // A header and nothing else: the chunk was all header.
    return chunk.includes("\n") ? chunk.slice(chunk.indexOf("\n") + 1) : "";
  }
  return chunk.slice(sep + 2);
}

/**
 * Join `next` onto `acc`, dropping the longest suffix/prefix they share.
 *
 * Longest-first so a short accidental repeat ("Total ") does not win over the
 * real overlap span. Whitespace is normalised for the COMPARISON only — the
 * chunker re-flows at sentence boundaries, so the two copies of an overlapping
 * sentence can differ by a newline — while the text kept is the original.
 */
export function joinDeOverlapped(acc: string, next: string): string {
  if (acc.length === 0) return next;
  if (next.length === 0) return acc;

  const window = Math.min(MAX_OVERLAP_SCAN, acc.length, next.length);
  const tail = acc.slice(acc.length - window);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

  for (let len = window; len >= 24; len--) {
    if (norm(tail.slice(tail.length - len)) === norm(next.slice(0, len))) {
      return acc + next.slice(len);
    }
  }
  // No overlap found (first chunk of a section, or a very short document):
  // join with a blank line so the model sees a paragraph break, not a run-on.
  return `${acc}\n\n${next}`;
}

/**
 * The fingerprint. Chunk count + sha256 over the first and last chunk BODY
 * (post-header-strip, so a Nextcloud rename does not read as a content change
 * — the header carries the filename and a rename bumps `updatedAt` too).
 */
/** Field separator inside the hash. A NUL cannot occur in extracted text, so
 *  no rearrangement of chunk bodies can forge another document's fingerprint.
 *  Built with `fromCharCode` rather than written literally: a NUL byte in
 *  source renders as a SPACE on GitHub and is invisible in every editor, so a
 *  reviewer would see `h.update(" ")` and a later edit would silently change
 *  the separator. */
const SEP = String.fromCharCode(0);

export function fingerprintChunks(bodies: string[]): string {
  const h = createHash("sha256");
  h.update(String(bodies.length));
  h.update(SEP);
  h.update(bodies[0] ?? "");
  h.update(SEP);
  h.update(bodies.length > 1 ? bodies[bodies.length - 1] : "");
  return `c${bodies.length}:${h.digest("hex").slice(0, 32)}`;
}

/** Fold an over-long document to head + tail. The counterparty is at the top
 *  and the totals are at the bottom; the middle of a 200-page contract is
 *  schedules. */
function fold(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, HEAD_CHARS)}\n\n[…]\n\n${text.slice(text.length - TAIL_CHARS)}`,
    truncated: true,
  };
}

/**
 * Read one indexed file's text.
 *
 * `permittedOwnerIds` is the allow-list described in the header — the enabling
 * owner's Nextcloud username plus `__household__`. An empty set reads nothing
 * rather than everything: a filter that degrades to "no filter" is how an
 * authorization bug ships looking like a convenience.
 */
export async function readFileContent(
  prisma: PrismaClient,
  ncFileId: number,
  permittedOwnerIds: readonly string[],
): Promise<ReadContentResult> {
  if (permittedOwnerIds.length === 0) return { ok: false, reason: "no_text" };

  const rows = await prisma.$queryRaw<ChunkRow[]>`
    SELECT "text", "sensitivity"::text AS "sensitivity"
    FROM "FileContentChunk"
    WHERE "ncFileId" = ${ncFileId}
      AND "userId" = ANY(${permittedOwnerIds as string[]})
    ORDER BY "chunkIdx" ASC
    LIMIT ${MAX_CHUNKS}
  `;

  if (rows.length === 0) return { ok: false, reason: "no_text" };

  // WARP-233: a `sensitive` chunk holds a `dcv1:` ciphertext blob, not text.
  // Today only chat-attached brain items are ever marked sensitive and those
  // carry `ncFileId = 0`, so this is a guard against a future widening rather
  // than a path in production — but extracting from base64 would produce
  // confident nonsense, and the honest answer is that we cannot read it.
  if (rows.some((r) => r.sensitivity !== "standard")) {
    return { ok: false, reason: "encrypted_content" };
  }

  const bodies = rows.map((r) => stripChunkHeader(r.text)).filter((t) => t.trim().length > 0);
  if (bodies.length === 0) return { ok: false, reason: "no_text" };

  const joined = bodies.reduce((acc, body) => joinDeOverlapped(acc, body), "");
  const { text, truncated } = fold(joined);

  return {
    ok: true,
    content: {
      text,
      chunkCount: rows.length,
      truncated,
      fingerprint: fingerprintChunks(bodies),
    },
  };
}
