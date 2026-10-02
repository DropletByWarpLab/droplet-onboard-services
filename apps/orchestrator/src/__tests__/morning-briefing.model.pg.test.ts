/**
 * WARP-2267 — MorningBriefing guarantees only a real database can prove: the
 * (userId, forDate) unique that the sweep's claim relies on, the enum
 * defaults, and the cascade on user delete.
 *
 * Gated the same way the other *.pg.test.ts files are.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("MorningBriefing — database guarantees (WARP-2267)", () => {
  let prisma: PrismaClient;
  const username = `warp2267-${Date.now()}`;
  let userId = "";
  const forDate = new Date("2026-09-22T00:00:00.000Z");

  beforeAll(async () => {
    const { PrismaClient: Real } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new Real();
    await prisma.$connect();
    const u = await prisma.user.create({
      data: { username, displayName: "Briefing test", passwordHash: "x", role: "family" },
    });
    userId = u.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username } });
    await prisma.$disconnect();
  });

  it("defaults every status column to its explicit enum value", async () => {
    const b = await prisma.morningBriefing.create({ data: { userId, forDate } });
    expect(b).toMatchObject({
      status: "pending",
      artKind: "ascii",
      photoStatus: "none",
      triggeredBy: "scheduler",
    });
  });

  it("refuses a second row for the same (userId, forDate) with P2002", async () => {
    await expect(prisma.morningBriefing.create({ data: { userId, forDate } })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("cascades on user delete", async () => {
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.morningBriefing.count({ where: { userId } })).toBe(0);
  });
});
