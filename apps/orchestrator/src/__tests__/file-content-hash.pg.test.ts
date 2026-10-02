/**
 * WARP-2096 — the File registry's content hash against a REAL Postgres.
 *
 * The (ownerUserId, sha256) index is deliberately NOT unique: a second copy
 * of the same bytes is a legitimate file, so the database must accept it
 * (a unique index would 500 the upload with P2002). The duplicate lookup is
 * scoped to one owner AND one space, so another person's or another space's
 * copy is never reported (that would disclose its path).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("File content hash — real-Postgres (WARP-2096)", () => {
  let prisma: PrismaClient;
  let findSameContentCandidates: typeof import("../services/file-registry.service.js").findSameContentCandidates;
  let upsertFileRegistryEntry: typeof import("../services/file-registry.service.js").upsertFileRegistryEntry;
  // Namespaced fixtures: other pg suites share the DB and run in parallel.
  const OWNER_A = "warp2096-owner-a";
  const OWNER_B = "warp2096-owner-b";
  const SHA = "a".repeat(64);
  const BASE = 2_096_000;

  beforeAll(async () => {
    const { PrismaClient: Real } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new Real();
    await prisma.$connect();
    ({ findSameContentCandidates, upsertFileRegistryEntry } = await import(
      "../services/file-registry.service.js"
    ));
  });

  afterAll(async () => {
    await prisma.file.deleteMany({ where: { ownerUserId: { startsWith: "warp2096-" } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.file.deleteMany({ where: { ownerUserId: { startsWith: "warp2096-" } } });
  });

  const put = (ncFileId: number, ownerUserId: string, path: string, departmentId: string | null = null) =>
    upsertFileRegistryEntry(prisma, { ncFileId, ownerUserId, path, departmentId, sha256: SHA, sizeBytes: 3 });

  it("stores two copies of the same bytes — same owner and across owners — without a constraint error", async () => {
    await put(BASE + 1, OWNER_A, "/a.txt");
    await put(BASE + 2, OWNER_A, "/copy of a.txt");
    await put(BASE + 3, OWNER_B, "/b.txt");
    const rows = await prisma.file.findMany({ where: { sha256: SHA, ownerUserId: { startsWith: "warp2096-" } } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.sizeBytes === 3n)).toBe(true);
  });

  it("the lookup returns only the caller's own copies in the same space, minus the file just written", async () => {
    await put(BASE + 1, OWNER_A, "/a.txt");
    await put(BASE + 2, OWNER_A, "/new.txt");
    await put(BASE + 3, OWNER_B, "/b.txt"); // someone else's copy
    await put(BASE + 4, OWNER_A, "/Team/a.txt", "warp2096-dept"); // another space

    const hits = await findSameContentCandidates(prisma, {
      ownerUserId: OWNER_A,
      departmentId: null,
      sha256: SHA,
      excludeNcFileId: BASE + 2,
    });
    expect(hits).toEqual([{ ncFileId: BASE + 1, path: "/a.txt" }]);
  });
});
