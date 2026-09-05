/**
 * WARP-2582 - the two migrations, against a real Postgres.
 *
 * A mocked Prisma accepts `kind: "customer"` whether or not the enum value
 * exists, and accepts a duplicate insert whether or not the unique index does.
 * So the only place these two migrations are actually PROVEN is here. Gated
 * the same way every other `*.pg.test.ts` file is.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("ContextPin business kinds (WARP-2582)", () => {
  let prisma: PrismaClient;
  let sessionId: string;

  beforeAll(async () => {
    const { PrismaClient: Real } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new Real();
    await prisma.$connect();
    const s = await prisma.chatSession.create({ data: { userId: "warp2580-pg" } });
    sessionId = s.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.chatSession.deleteMany({ where: { userId: "warp2580-pg" } });
    await prisma.$disconnect();
  });

  it("accepts all four new enum values", async () => {
    for (const kind of ["customer", "deal", "project", "work_item"] as const) {
      const row = await prisma.contextPin.create({
        data: { sessionId, kind, ref: `ref-${kind}` },
      });
      expect(row.kind).toBe(kind);
    }
  });

  it("rejects a second pin of the same (session, kind, ref) with P2002", async () => {
    await prisma.contextPin.create({
      data: { sessionId, kind: "customer", ref: "dupe-target" },
    });
    // The record-drawer action makes this exact insert one click, and a
    // duplicate costs the system prompt the same line on every turn forever.
    await expect(
      prisma.contextPin.create({
        data: { sessionId, kind: "customer", ref: "dupe-target" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("still allows the same ref under a DIFFERENT kind", async () => {
    await prisma.contextPin.create({ data: { sessionId, kind: "deal", ref: "shared-ref" } });
    const second = await prisma.contextPin.create({
      data: { sessionId, kind: "project", ref: "shared-ref" },
    });
    expect(second.id).toBeTruthy();
  });

  it("deleting the session still cascades every pin away", async () => {
    const s = await prisma.chatSession.create({ data: { userId: "warp2580-pg" } });
    await prisma.contextPin.create({ data: { sessionId: s.id, kind: "customer", ref: "x" } });
    await prisma.chatSession.delete({ where: { id: s.id } });
    expect(await prisma.contextPin.count({ where: { sessionId: s.id } })).toBe(0);
  });
});
