import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { SHARED_DRIVE_INDEX_USER } from "@droplet/tools-core";
import { readDocumentText, searchByLexical, searchByVector } from "../src/file-search.service.js";

const path = "/Droplet/flux.pdf";
const denied = { source: null, chunks: [], totalChunks: 0, unreadableChunks: 0, nextChunk: null };

function prismaStub(id: number | null = 17) {
  const findFirst = vi.fn(async () => id === null ? null : { ncFileId: id });
  const raw = vi.fn(async (sql: string, ..._params: unknown[]) => sql.includes("COUNT") ? [{ count: 1n }] : [{
    source: "nextcloud", path, chunkIdx: 0, pageNumber: null, brainItemId: null,
    text: "Shared PDF", snippet: "Shared PDF", score: 0.8, warnings: [], metadata: null, externalFileId: id,
  }]);
  const prisma = {
    fileContentChunk: { findFirst },
    $queryRawUnsafe: raw,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRawUnsafe: raw, $executeRawUnsafe: vi.fn() })),
  } as unknown as PrismaClient;
  return { prisma, raw, findFirst };
}

describe("MCP shared-drive search identity", () => {
  it.each(["vector", "lexical"] as const)("keeps the indexed file ID through the %s arm", async (arm) => {
    const { prisma, raw } = prismaStub();
    const hits = arm === "vector" ? await searchByVector(prisma, {
      userId: "alice", additionalUserIds: [SHARED_DRIVE_INDEX_USER], vector: [0.1], limit: 5, minSimilarity: 0.1,
    }) : await searchByLexical(prisma, {
      userId: "alice", additionalUserIds: [SHARED_DRIVE_INDEX_USER], query: "flux", limit: 5,
    });
    expect(hits[0]).toHaveProperty("externalFileId", 17);
    expect(raw.mock.calls[0]![0]).toContain('CASE WHEN "userId" = \'__droplet_share__\' THEN "ncFileId" END AS "externalFileId"');
  });

  it("leaves ordinary search hit wire shape intact for a null shared ID", async () => {
    const { prisma } = prismaStub(null);
    const hits = await searchByLexical(prisma, { userId: "alice", query: "flux", limit: 5 });
    expect(hits[0]).not.toHaveProperty("externalFileId");
  });
});

describe("MCP shared-drive document reads", () => {
  it("does not expose text or counts when the caller has no credential check", async () => {
    const { prisma, raw, findFirst } = prismaStub();
    expect(await readDocumentText(prisma, {
      userId: "alice", additionalUserIds: [SHARED_DRIVE_INDEX_USER], path, startChunk: 0, maxChars: 1000,
    })).toEqual(denied);
    expect(raw).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([false, "error"] as const)("checks current identity before any count or text when denied (%s)", async (permit) => {
    const { prisma, raw, findFirst } = prismaStub();
    const authorize = vi.fn(async () => {
      if (permit === "error") throw new Error("expired credential");
      return permit;
    });
    expect(await readDocumentText(prisma, {
      userId: "alice", path, startChunk: 0, maxChars: 1000, authorizeSharedDrive: authorize,
    })).toEqual(denied);
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: SHARED_DRIVE_INDEX_USER, source: "nextcloud", path }, select: { ncFileId: true },
    });
    expect(authorize).toHaveBeenCalledWith({ path, externalFileId: 17 });
    expect(raw).not.toHaveBeenCalled();
  });

  it("reads only the authorized shared identity after current per-file access is granted", async () => {
    const { prisma, raw } = prismaStub();
    const authorize = vi.fn(async () => true);
    const result = await readDocumentText(prisma, {
      userId: "alice", additionalUserIds: ["alice-id"], path, startChunk: 0, maxChars: 1000,
      authorizeSharedDrive: authorize,
    });
    expect(result.chunks[0]?.text).toBe("Shared PDF");
    expect(result.totalChunks).toBe(1);
    expect(raw.mock.calls).toHaveLength(2);
    for (const call of raw.mock.calls) {
      expect((call as unknown[]).slice(1, 4)).toEqual([SHARED_DRIVE_INDEX_USER, path, 17]);
      expect(call[0]).toContain('"userId" = $1');
      expect(call[0]).toContain("source = 'nextcloud'");
      expect(call[0]).toContain('"ncFileId" = $3');
      expect(call[0]).not.toContain('"userId" IN');
    }
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(raw.mock.invocationCallOrder[0]!);
  });

  it.each([null, 0, -1])("denies unregistered or invalid indexed identities (%s)", async (id) => {
    const { prisma, raw } = prismaStub(id);
    const authorize = vi.fn(async () => true);
    expect(await readDocumentText(prisma, {
      userId: "alice", path, startChunk: 0, maxChars: 1000, authorizeSharedDrive: authorize,
    })).toEqual(denied);
    expect(authorize).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
  });

  it("does not read a replacement indexed after the original identity was authorized", async () => {
    const { prisma, raw } = prismaStub();
    let currentIndexedId = 17;
    raw.mockImplementation(async (sql: string, ...params: unknown[]) => {
      const identityMatches = params[2] === currentIndexedId;
      if (sql.includes("COUNT")) return [{ count: identityMatches ? 1n : 0n }];
      throw new Error("The replaced document must not reach the text query");
    });
    expect(await readDocumentText(prisma, {
      userId: "alice", additionalUserIds: ["alice-id"], path, startChunk: 0, maxChars: 1000,
      authorizeSharedDrive: async (file) => {
        expect(file.externalFileId).toBe(17);
        currentIndexedId = 18;
        return true;
      },
    })).toEqual(denied);
    expect(raw).toHaveBeenCalledTimes(1);
  });
});
