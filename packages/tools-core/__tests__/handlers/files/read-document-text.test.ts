// WARP-2057 — read_document_text.
//
// The behaviours under test are the ones that decide whether a compiled
// report is trustworthy: a partial read must be self-evidently partial,
// and a file with no extracted text must NOT look like an empty document.

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getTool } from "../../../src/index.js";
import type { ToolContext } from "../../../src/types.js";

type ReadFn = NonNullable<ToolContext["readDocumentText"]>;

// `userId` rides in an options object rather than as a defaulted
// positional: a default parameter also fires for an EXPLICIT `undefined`,
// so `makeCtx(read, undefined)` would have silently kept "alice" and the
// auth test would have exercised the authenticated path instead.
function makeCtx(
  readDocumentText?: ReadFn | ReturnType<typeof vi.fn>,
  { userId }: { userId?: string } = { userId: "alice" },
): ToolContext {
  return {
    prisma: {} as PrismaClient,
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    readDocumentText: readDocumentText as ReadFn | undefined,
    userId,
    signal: new AbortController().signal,
  };
}

function chunk(idx: number, text: string, pageNumber: number | null = null) {
  return { chunkIdx: idx, pageNumber, text, warnings: [] as string[] };
}

const tool = getTool("read_document_text")!;

describe("read_document_text — contract", () => {
  it("is registered as a read-tier tool needing no confirmation", () => {
    expect(tool.requiresWrite).toBe(false);
    expect(tool.requiresConfirmation).toBe(false);
  });

  it("joins chunks in order and reports next_chunk=null when exhausted", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "nextcloud",
      chunks: [chunk(0, "first"), chunk(1, "second")],
      totalChunks: 2,
      unreadableChunks: 0,
    });
    const res = await tool.handler({ path: "/Docs/quote.pdf" }, makeCtx(read));
    expect(res.ok).toBe(true);
    const data = (res as { ok: true; data: Record<string, unknown> }).data;
    expect(data.text).toBe("first\nsecond");
    expect(data.next_chunk).toBeNull();
    expect(data.total_chunks).toBe(2);
    expect(read).toHaveBeenCalledWith({
      path: "/Docs/quote.pdf",
      startChunk: 0,
      maxChars: 12000,
    });
  });

  // The single most important behaviour here. A model that cannot tell
  // "that is the whole document" from "that is the first 8%" will
  // summarize the first 8% as though it were the whole thing.
  it("reports next_chunk as a number when text remains", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "nextcloud",
      chunks: [chunk(0, "page one"), chunk(1, "page two")],
      totalChunks: 9,
      unreadableChunks: 0,
    });
    const res = await tool.handler({ path: "/Docs/long.pdf" }, makeCtx(read));
    const data = (res as { ok: true; data: Record<string, unknown> }).data;
    expect(data.next_chunk).toBe(2);
    expect(data.total_chunks).toBe(9);
  });

  it("resumes from start_chunk and still terminates at the end", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "nextcloud",
      chunks: [chunk(7, "tail")],
      totalChunks: 8,
      unreadableChunks: 0,
    });
    const res = await tool.handler(
      { path: "/Docs/long.pdf", start_chunk: 7 },
      makeCtx(read),
    );
    const data = (res as { ok: true; data: Record<string, unknown> }).data;
    expect(data.next_chunk).toBeNull();
    expect(data.start_chunk).toBe(7);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ startChunk: 7 }),
    );
  });

  // A silently-skipped extraction is invisible from the outside: 118 of
  // 321 files on the live box have no chunks. Returning "" here would
  // have the model write a confident report about nothing.
  it("fails loudly with NOT_INDEXED rather than returning an empty document", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "nextcloud",
      chunks: [],
      totalChunks: 0,
      unreadableChunks: 0,
    });
    const res = await tool.handler({ path: "/Docs/scan.pdf" }, makeCtx(read));
    expect(res.ok).toBe(false);
    const e = res as { ok: false; error: { code: string; message: string } };
    expect(e.error.code).toBe("NOT_INDEXED");
    // The message has to tell the model how to recover, not just that it failed.
    expect(e.error.message).toContain("/Docs/scan.pdf");
    expect(e.error.message).toMatch(/search_content|re-upload|indexing/);
  });

  it("surfaces page numbers, deduped extraction warnings, and unreadable chunks", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "brain",
      chunks: [
        { chunkIdx: 0, pageNumber: 3, text: "a", warnings: ["low_confidence_ocr_page_3"] },
        { chunkIdx: 1, pageNumber: 3, text: "b", warnings: ["low_confidence_ocr_page_3"] },
        { chunkIdx: 2, pageNumber: 4, text: "c", warnings: [] },
      ],
      totalChunks: 3,
      unreadableChunks: 2,
    });
    const res = await tool.handler({ path: "/Docs/scan.pdf" }, makeCtx(read));
    const data = (res as { ok: true; data: Record<string, unknown> }).data;
    expect(data.source).toBe("brain");
    expect(data.pages).toEqual([3, 4]);
    expect(data.extraction_warnings).toEqual(["low_confidence_ocr_page_3"]);
    expect(data.unreadable_chunks).toBe(2);
  });

  it("omits the optional keys entirely when there is nothing to report", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "nextcloud",
      chunks: [chunk(0, "plain")],
      totalChunks: 1,
      unreadableChunks: 0,
    });
    const res = await tool.handler({ path: "/Docs/a.txt" }, makeCtx(read));
    const data = (res as { ok: true; data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("pages");
    expect(data).not.toHaveProperty("extraction_warnings");
    expect(data).not.toHaveProperty("unreadable_chunks");
  });
});

describe("read_document_text — guards", () => {
  it("requires authentication before touching the shim", async () => {
    const read = vi.fn();
    const res = await tool.handler({ path: "/Docs/a.pdf" }, makeCtx(read, {}));
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: { code: string } }).error.code).toBe(
      "AUTH_REQUIRED",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("returns DOCUMENT_READ_UNAVAILABLE when the shim is unwired", async () => {
    const res = await tool.handler({ path: "/Docs/a.pdf" }, makeCtx(undefined));
    expect((res as { ok: false; error: { code: string } }).error.code).toBe(
      "DOCUMENT_READ_UNAVAILABLE",
    );
  });

  it("rejects a missing path, negative start_chunk, and undersized max_chars", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "nextcloud",
      chunks: [],
      totalChunks: 1,
      unreadableChunks: 0,
    });
    for (const args of [
      {},
      { path: "   " },
      { path: "/a.pdf", start_chunk: -1 },
      { path: "/a.pdf", start_chunk: 1.5 },
      { path: "/a.pdf", max_chars: 10 },
    ]) {
      const res = await tool.handler(args, makeCtx(read));
      expect((res as { ok: false; error: { code: string } }).error.code).toBe(
        "INVALID_ARGS",
      );
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("clamps max_chars to the ceiling instead of honouring an oversized ask", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "nextcloud",
      chunks: [chunk(0, "x")],
      totalChunks: 1,
      unreadableChunks: 0,
    });
    await tool.handler({ path: "/a.pdf", max_chars: 999999 }, makeCtx(read));
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ maxChars: 50000 }),
    );
  });

  it("rejects a start_chunk past the end with a message naming the real length", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "nextcloud",
      chunks: [],
      totalChunks: 4,
      unreadableChunks: 0,
    });
    const res = await tool.handler(
      { path: "/a.pdf", start_chunk: 99 },
      makeCtx(read),
    );
    const e = res as { ok: false; error: { code: string; message: string } };
    expect(e.error.code).toBe("INVALID_ARGS");
    expect(e.error.message).toContain("4");
  });

  it("maps a throwing shim to DOCUMENT_READ_FAILED", async () => {
    const read = vi.fn().mockRejectedValue(new Error("db down"));
    const res = await tool.handler({ path: "/a.pdf" }, makeCtx(read));
    expect((res as { ok: false; error: { code: string } }).error.code).toBe(
      "DOCUMENT_READ_FAILED",
    );
  });
});
