/**
 * WARP-2057 — `readDocumentText` pagination against the ONE property the
 * chunk store does not promise: dense `chunkIdx` numbering.
 *
 * `chunkIdx` is unique and ordered per path, but nothing guarantees the
 * indices are 0..N-1 — re-extraction can retire indices. The PR-review
 * finding: `nextChunk` was computed as `consumedThrough + 1 < totalChunks`,
 * comparing a chunk INDEX against a chunk COUNT. With chunks at 0/100/200
 * (totalChunks = 3) a window ending at idx 100 concluded `101 < 3` = false
 * → next_chunk null → chunk 200 silently never read, while the caller was
 * told the document was exhausted and `unreadable_chunks` stayed 0. That is
 * a silent partial read — the exact failure `read_document_text` exists to
 * prevent.
 *
 * Termination must therefore come from WINDOW EXHAUSTION (the query
 * returning fewer rows than it asked for, adjusted for the char-budget
 * early stop), never from arithmetic between an index and a count.
 *
 * The paging loop below is the consumer contract in miniature: follow
 * `nextChunk` until null, and every handed-out `nextChunk` must land on a
 * real row — the tool layer treats an empty window as "past the end", so a
 * resume offset with nothing at or past it would surface as an error to
 * the model mid-read.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  readDocumentText,
  type ReadDocumentTextResult,
} from "../src/file-search.service.js";

interface FixtureRow {
  source: "nextcloud" | "brain";
  chunkIdx: number;
  pageNumber: number | null;
  brainItemId: string | null;
  text: string;
  warnings: string[] | null;
}

/** Plaintext chunk row (never enters the decrypt path). Source is "brain"
 *  on purpose: the old code fell back to a GUESSED "nextcloud" for empty
 *  windows, and a "nextcloud" fixture would mask that guess. */
function row(chunkIdx: number, text: string): FixtureRow {
  return {
    source: "brain",
    chunkIdx,
    pageNumber: null,
    brainItemId: null,
    text,
    warnings: null,
  };
}

/**
 * Prisma stub speaking exactly the two queries `readDocumentText` makes.
 * Param layout mirrors the SQL builder: the COUNT query ends with [path];
 * the window query ends with [path, startChunk, limit] — read from the
 * tail so the userId-predicate arity never matters.
 */
function prismaStub(allRows: FixtureRow[]) {
  const windows: Array<{ startChunk: number; limit: number }> = [];
  const prisma = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      if (sql.includes("COUNT")) {
        return [{ count: BigInt(allRows.length) }];
      }
      const startChunk = params[params.length - 2] as number;
      const limit = params[params.length - 1] as number;
      windows.push({ startChunk, limit });
      return [...allRows]
        .filter((r) => r.chunkIdx >= startChunk)
        .sort((a, b) => a.chunkIdx - b.chunkIdx)
        .slice(0, limit);
    }),
  } as unknown as PrismaClient;
  return { prisma, windows };
}

/** Follow `nextChunk` to exhaustion, like the tool's caller would. */
async function readWholeDocument(
  prisma: PrismaClient,
  maxChars: number,
): Promise<ReadDocumentTextResult[]> {
  const responses: ReadDocumentTextResult[] = [];
  let startChunk = 0;
  for (let hop = 0; ; hop++) {
    // A document of ≤6 chunks must never take anywhere near 10 windows —
    // a run past this is the resume-offset spin this function guards.
    expect(hop, "paging did not terminate").toBeLessThan(10);
    const res = await readDocumentText(prisma, {
      userId: "alice",
      path: "/Docs/report.pdf",
      startChunk,
      maxChars,
    });
    responses.push(res);
    if (res.nextChunk === null) return responses;
    expect(res.nextChunk).toBeGreaterThan(startChunk);
    startChunk = res.nextChunk;
  }
}

const marker = (i: number) => `<chunk-${i}>` + "x".repeat(600);

describe("readDocumentText — pagination under sparse chunkIdx numbering", () => {
  it("reads a sparse-numbered document (0/100/200) to the END across windows", async () => {
    const { prisma } = prismaStub([
      row(0, marker(0)),
      row(100, marker(100)),
      row(200, marker(200)),
    ]);
    // 600-char chunks against a 1000-char budget → one chunk per window.
    const responses = await readWholeDocument(prisma, 1000);

    const text = responses.flatMap((r) => r.chunks.map((c) => c.text)).join("\n");
    expect(text).toContain("<chunk-0>");
    expect(text).toContain("<chunk-100>");
    // The finding's silent truncation: idx 100 is the last row of a window,
    // `101 < totalChunks(3)` is false, and chunk 200 was never fetched.
    expect(text).toContain("<chunk-200>");
    expect(responses.map((r) => r.chunks.map((c) => c.chunkIdx)).flat()).toEqual([
      0, 100, 200,
    ]);
    for (const r of responses) expect(r.totalChunks).toBe(3);
    expect(responses[responses.length - 1]!.nextChunk).toBeNull();
  });

  it("still terminates a DENSE document exactly at its end (no spin, no truncation)", async () => {
    const { prisma } = prismaStub([row(0, marker(0)), row(1, marker(1)), row(2, marker(2))]);
    const responses = await readWholeDocument(prisma, 1000);
    expect(responses.flatMap((r) => r.chunks.map((c) => c.chunkIdx))).toEqual([0, 1, 2]);
    expect(responses[responses.length - 1]!.nextChunk).toBeNull();
  });

  // maxChars=500 → fetch limit is ceil(500/100)+1 = 6. Six tiny chunks fill
  // the window EXACTLY at the document's end. "Window came back full" must
  // not become "hand out a resume offset with nothing at it": every
  // non-null nextChunk has to land on a real row, because the tool layer
  // reads an empty window as past-the-end and errors mid-read.
  it("a full window landing exactly on the document end never hands out a next_chunk past the last row", async () => {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => row(i, `<c${i}>tiny`));
    const { prisma } = prismaStub(rows);
    const responses = await readWholeDocument(prisma, 500);

    expect(responses.flatMap((r) => r.chunks.map((c) => c.chunkIdx))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    // Every window a caller was steered to must contain at least one row.
    for (const r of responses.slice(1)) {
      expect(r.chunks.length + r.unreadableChunks).toBeGreaterThan(0);
    }
    expect(responses[responses.length - 1]!.nextChunk).toBeNull();
  });
});

describe("readDocumentText — source is read from rows, never guessed", () => {
  it("reports the examined rows' source", async () => {
    const { prisma } = prismaStub([row(0, marker(0)), row(100, marker(100))]);
    const res = await readDocumentText(prisma, {
      userId: "alice",
      path: "/Docs/report.pdf",
      startChunk: 0,
      maxChars: 5000,
    });
    expect(res.source).toBe("brain");
  });

  it("an empty window past the last row carries NO source rather than a guessed one", async () => {
    const { prisma } = prismaStub([row(0, marker(0)), row(100, marker(100)), row(200, marker(200))]);
    const res = await readDocumentText(prisma, {
      userId: "alice",
      path: "/Docs/report.pdf",
      startChunk: 250, // sparse numbering: past the last real row
      maxChars: 1000,
    });
    expect(res.chunks).toEqual([]);
    expect(res.nextChunk).toBeNull();
    expect(res.totalChunks).toBe(3);
    // The review nit: this used to be `rows[0]?.source ?? "nextcloud"` — a
    // guess. Derived state is never guessed; absence must be honest.
    expect(res.source).toBeNull();
  });

  it("a not-indexed path (zero chunks anywhere) carries NO source", async () => {
    const { prisma } = prismaStub([]);
    const res = await readDocumentText(prisma, {
      userId: "alice",
      path: "/Docs/missing.pdf",
      startChunk: 0,
      maxChars: 1000,
    });
    expect(res.totalChunks).toBe(0);
    expect(res.source).toBeNull();
  });
});
