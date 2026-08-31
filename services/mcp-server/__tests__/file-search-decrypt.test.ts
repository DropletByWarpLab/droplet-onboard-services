/**
 * WARP-242 — decrypt-on-read + crypto-shred for the mcp-server's
 * search_content pipeline (the twin of the orchestrator's
 * file-search.service coverage; this process serves the LLM tool path,
 * so ciphertext must never reach a tool result).
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { searchByVector, CHUNK_SNIPPET_CHARS } from "../src/file-search.service.js";
import {
  encryptColumn,
  deriveDocKek,
  generateDek,
  wrapDek,
  __setColumnCryptoKeyForTest,
} from "../src/column-crypto.service.js";

__setColumnCryptoKeyForTest(Buffer.alloc(32, 42).toString("base64"));

type DekRow = { keyId: string; version: number; wrappedDek: string };

/**
 * WARP-2524: `searchByVector` now issues `SET LOCAL hnsw.ef_search` inside an
 * interactive transaction (mirroring the orchestrator's WARP-2193 fix), so
 * the stub models `$transaction` by handing the callback a tx client whose
 * `$queryRawUnsafe` is the same spy. Where the statements run is pinned by
 * file-search-ef-search.test.ts; here only the row plumbing matters.
 */
function prismaStub(chunkRows: unknown[], dekRows: DekRow[]) {
  const raw = vi.fn(async () => chunkRows);
  return {
    $queryRawUnsafe: raw,
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRawUnsafe: raw, $executeRawUnsafe: vi.fn(async () => 0) }),
    ),
    documentEncryptionKey: {
      findMany: vi.fn(async ({ where: { keyId } }: any) =>
        dekRows.filter((r) => (keyId.in as string[]).includes(r.keyId)),
      ),
    },
  } as unknown as PrismaClient;
}

function encRow(itemId: string, blob: string) {
  return {
    source: "brain",
    path: `/brain/${itemId}`,
    chunkIdx: 0,
    pageNumber: null,
    brainItemId: itemId,
    metadata: null,
    snippet: blob,
    score: 0.9,
  };
}

const baseParams = { userId: "alice", vector: [1, 0, 0], limit: 10, minSimilarity: 0 };

describe("WARP-242 decrypt-on-read (mcp-server twin)", () => {
  it("decrypts encrypted brain hits and truncates to the snippet width", async () => {
    const dek = generateDek();
    const dekRows = [
      { keyId: "brain:item1", version: 1, wrappedDek: wrapDek(deriveDocKek(), dek, "brain:item1") },
    ];
    const long = "attachment secret ".repeat(40);
    const prisma = prismaStub(
      [encRow("item1", encryptColumn(dek, long, "brain:item1"))],
      dekRows,
    );
    const hits = await searchByVector(prisma, baseParams);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet.startsWith("attachment secret")).toBe(true);
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(CHUNK_SNIPPET_CHARS);
  });

  it("CRYPTO-SHRED: drops hits whose DEK row is gone instead of surfacing ciphertext", async () => {
    const dek = generateDek();
    const prisma = prismaStub(
      [
        encRow("shredded", encryptColumn(dek, "deleted content", "brain:shredded")),
        { ...encRow("x", "plaintext hit"), brainItemId: null, source: "nextcloud" },
      ],
      [], // no DEK rows at all — the document was crypto-shredded
    );
    const hits = await searchByVector(prisma, baseParams);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toBe("plaintext hit");
  });

  it("plaintext-only result sets never touch the DEK table", async () => {
    // Deliberately NO documentEncryptionKey on this stub — reaching for the
    // DEK table would throw, which is the assertion.
    const raw = vi.fn(async () => [
      { ...encRow("x", "plain"), brainItemId: null, source: "nextcloud" },
    ]);
    const prisma = {
      $queryRawUnsafe: raw,
      $transaction: vi.fn(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ $queryRawUnsafe: raw, $executeRawUnsafe: vi.fn(async () => 0) }),
      ),
    } as unknown as PrismaClient;
    const hits = await searchByVector(prisma, baseParams);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toBe("plain");
  });
});
