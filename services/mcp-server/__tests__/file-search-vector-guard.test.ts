/**
 * TOOLS-09 — the pgvector literal in file-search.service is the one
 * string-interpolated SQL fragment (everything else is parameterized).
 * These tests pin the defense-in-depth guard that rejects a non-finite
 * vector BEFORE it can be joined into `'[...]'::vector`.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { searchByVector, searchHybrid } from "../src/file-search.service.js";

// Minimal prisma stub. searchByLexical calls $queryRawUnsafe directly;
// searchByVector routes its SELECT through $transaction (WARP-2524 — SET
// LOCAL hnsw.ef_search needs a transaction scope), so the stub hands the
// callback a tx client whose $queryRawUnsafe is the SAME spy: `raw` still
// sees every SQL statement either way. Returns an empty result set so the
// happy path resolves.
function prismaStub(): { client: PrismaClient; raw: Mock } {
  const raw = vi.fn(async () => [] as unknown[]);
  const client = {
    $queryRawUnsafe: raw,
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRawUnsafe: raw, $executeRawUnsafe: vi.fn(async () => 0) }),
    ),
  } as unknown as PrismaClient;
  return { client, raw };
}

const baseParams = {
  userId: "alice",
  limit: 10,
  minSimilarity: 0.3,
};

describe("searchByVector finite-vector guard (TOOLS-09)", () => {
  it("passes a valid finite vector through to the query", async () => {
    const { client, raw } = prismaStub();
    await searchByVector(client, { ...baseParams, vector: [0.1, -0.2, 0.3] });
    expect(raw).toHaveBeenCalled();
    // The interpolated literal carries the joined floats.
    const sql = raw.mock.calls[0][0] as string;
    expect(sql).toContain("[0.1,-0.2,0.3]");
  });

  it.each([
    ["NaN", [0.1, NaN, 0.3]],
    ["Infinity", [Infinity, 0.2]],
    ["-Infinity", [0.1, -Infinity]],
    ["a non-number", [0.1, "0.2" as unknown as number]],
  ])("rejects a vector containing %s without issuing SQL", async (_label, vector) => {
    const { client, raw } = prismaStub();
    await expect(
      searchByVector(client, { ...baseParams, vector: vector as number[] }),
    ).rejects.toThrow(/finite number/);
    expect(raw).not.toHaveBeenCalled();
  });

  it("rejects an empty vector", async () => {
    const { client, raw } = prismaStub();
    await expect(
      searchByVector(client, { ...baseParams, vector: [] }),
    ).rejects.toThrow(/non-empty/);
    expect(raw).not.toHaveBeenCalled();
  });
});

describe("searchHybrid enhancement-vector guard (TOOLS-09)", () => {
  it("rejects a non-finite hydeVector", async () => {
    const { client, raw } = prismaStub();
    await expect(
      searchHybrid(client, {
        userId: "alice",
        vector: [0.1, 0.2],
        query: "q",
        queryEnhancement: { hydeVector: [0.1, NaN] },
      }),
    ).rejects.toThrow(/hydeVector/);
    expect(raw).not.toHaveBeenCalled();
  });

  it("rejects a non-finite extraQueryVectors entry", async () => {
    const { client, raw } = prismaStub();
    await expect(
      searchHybrid(client, {
        userId: "alice",
        vector: [0.1, 0.2],
        query: "q",
        queryEnhancement: { extraQueryVectors: [[0.3, 0.4], [Infinity, 0.5]] },
      }),
    ).rejects.toThrow(/extraQueryVectors\[1\]/);
    expect(raw).not.toHaveBeenCalled();
  });
});
