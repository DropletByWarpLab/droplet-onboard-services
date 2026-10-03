/**
 * WARP-3425 — the File registry reconcile against a REAL Postgres.
 *
 * The unit suite pins the decision rule with a stub; this pins the database
 * half: the `FileRegistryStatus` migration, the row states, which index rows go
 * with a missing file (watcher chunks and the status row, never brain-memory
 * chunks), and that the duplicate-upload lookup ignores missing rows. Nextcloud
 * is the injected existence check: this lane has no Nextcloud database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("File registry reconcile — real-Postgres (WARP-3425)", () => {
  let prisma: PrismaClient;
  let registry: typeof import("../services/file-registry.service.js");
  // Namespaced fixtures: other pg suites share the DB.
  const OWNER = "warp3425-owner";
  const SHA = "b".repeat(64);
  const LIVE = 3_425_001;
  const GONE = 3_425_002;
  const NOT_FOUND = new Set([GONE]);

  async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "FileContentChunk" WHERE "userId" LIKE 'warp3425-%'`);
    await prisma.fileIndexStatus.deleteMany({ where: { userId: { startsWith: "warp3425-" } } });
    await prisma.file.deleteMany({ where: { ownerUserId: { startsWith: "warp3425-" } } });
  }

  async function chunk(ncFileId: number, chunkIdx: number, source: "nextcloud" | "brain") {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "FileContentChunk" ("userId", "ncFileId", "path", "chunkIdx", "text", "embedding", "source")
       VALUES ($1, $2, $3, $4, 'text', array_fill(0.1::real, ARRAY[384])::vector, $5::"FileContentSource")`,
      OWNER,
      ncFileId,
      `/f-${ncFileId}.txt`,
      chunkIdx,
      source,
    );
  }

  /** One full pass over the registry, whatever else other suites left in it.
   *  Every id is present in "Nextcloud" except the ones in NOT_FOUND. */
  async function sweep(notFound: Set<number> = NOT_FOUND) {
    registry.__resetRegistryCursorForTests();
    const exists = async (ids: number[]) => new Set(ids.filter((id) => !notFound.has(id)));
    for (;;) {
      const r = await registry.reconcileFileRegistry(prisma, exists);
      if (r.checked < registry.REGISTRY_SWEEP_BATCH) return;
    }
  }

  const status = async (ncFileId: number) =>
    (await prisma.file.findUnique({ where: { ncFileId }, select: { status: true } }))?.status;

  beforeAll(async () => {
    const { PrismaClient: Real } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new Real();
    await prisma.$connect();
    registry = await import("../services/file-registry.service.js");
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    for (const [ncFileId, path] of [
      [LIVE, "/Household/Live test Q3/file-1.txt"],
      [GONE, "/Household/Live test Q3/Minutes.docx"],
    ] as const) {
      await registry.upsertFileRegistryEntry(prisma, {
        ncFileId,
        ownerUserId: OWNER,
        path,
        departmentId: null,
        sha256: SHA,
        sizeBytes: 3,
      });
      await prisma.fileIndexStatus.create({
        data: { userId: OWNER, path: `/f-${ncFileId}.txt`, ncFileId, status: "ready" },
      });
      await chunk(ncFileId, 0, "nextcloud");
    }
    // A brain-memory chunk that happens to share the id (synthetic ids are
    // not Nextcloud ids): it must survive.
    await chunk(GONE, 1, "brain");
  });

  it("a new row is live; a row Nextcloud no longer has goes missing and takes its search index with it", async () => {
    expect(await status(GONE)).toBe("live");

    await sweep();

    expect(await status(GONE)).toBe("missing");
    expect(await status(LIVE)).toBe("live");
    const left = await prisma.fileContentChunk.findMany({
      where: { userId: OWNER },
      select: { ncFileId: true, source: true },
      orderBy: { ncFileId: "asc" },
    });
    expect(left).toEqual([
      { ncFileId: LIVE, source: "nextcloud" },
      { ncFileId: GONE, source: "brain" },
    ]);
    const statuses = await prisma.fileIndexStatus.findMany({ where: { userId: OWNER }, select: { ncFileId: true } });
    expect(statuses).toEqual([{ ncFileId: LIVE }]);
  });

  it("the duplicate-upload lookup skips a missing row; an upload of the id makes it live again", async () => {
    await sweep();
    const lookup = () =>
      registry.findSameContentCandidates(prisma, {
        ownerUserId: OWNER,
        departmentId: null,
        sha256: SHA,
        excludeNcFileId: null,
      });
    expect((await lookup()).map((c) => c.ncFileId)).toEqual([LIVE]);

    await registry.upsertFileRegistryEntry(prisma, {
      ncFileId: GONE,
      ownerUserId: OWNER,
      path: "/Household/Live test Q3/Minutes.docx",
      departmentId: null,
      sha256: SHA,
      sizeBytes: 3,
    });
    expect(await status(GONE)).toBe("live");
  });

  it("an id that comes back in Nextcloud (a restore) is live again on the next sweep", async () => {
    await sweep();
    expect(await status(GONE)).toBe("missing");
    await sweep(new Set());
    expect(await status(GONE)).toBe("live");
  });
});
