/**
 * WARP-2549 — the two rules the landing seam cannot enforce from TypeScript.
 *
 * `land.ts` writes complete provenance and scopes every reconcile to a
 * connection. That is the MESSAGE. The CHECK constraints and the
 * connection-scoped uniques are the INVARIANT, and the difference matters
 * because a data migration, a psql session, a future connector and any code
 * that does not route through `land.ts` all reach these tables without passing
 * through a single line of the service.
 *
 * Delete either CHECK from the migration and every MOCKED test in this repo
 * still passes while this file goes red. That is the whole reason it exists.
 *
 * A mocked Prisma cannot prove a database constraint, so this suite is real-
 * Postgres and gated the same way the other `*.pg.test.ts` files are.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("landed provenance is complete or refused (WARP-2549)", () => {
  let prisma: PrismaClient;
  let connectionA: string;
  let connectionB: string;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Namespaced, because the pg-gated suites share one throwaway database and
  // run in parallel — an unscoped deleteMany would eat another suite's rows.
  const OURS = { startsWith: "warp2549-" } as const;

  beforeEach(async () => {
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.contact.deleteMany({ where: { displayName: OURS } });
    await prisma.integrationConnection.deleteMany({ where: { secretRef: OURS } });

    // Two connections to the SAME vendor: the shape the old provider-scoped
    // unique got wrong, and the reason this table needed a connection column.
    const make = async (host: string) =>
      (
        await prisma.integrationConnection.create({
          data: {
            provider: "hubspot",
            status: "CONNECTED",
            host,
            databaseName: "",
            secretRef: "warp2549-secret",
          },
          select: { id: true },
        })
      ).id;
    connectionA = await make("warp2549-portal-a");
    connectionB = await make("warp2549-portal-b");
  });

  it("accepts a row whose provenance is complete", async () => {
    const company = await prisma.crmCompany.create({
      data: {
        name: "warp2549-northwind",
        origin: "EXTERNAL",
        connectionId: connectionA,
        externalSystem: "hubspot",
        externalId: "123",
      },
    });
    expect(company.connectionId).toBe(connectionA);
  });

  it("accepts a locally typed row, which carries none of it", async () => {
    const company = await prisma.crmCompany.create({ data: { name: "warp2549-local" } });
    expect(company.origin).toBe("LOCAL");
    expect(company.connectionId).toBeNull();
  });

  it("refuses an external id with no connection to attribute it to", async () => {
    // Unpurgeable and unattributable: WARP-2461's walker keys on connectionId,
    // so a row without one is invisible to every purge that will ever run.
    await expect(
      prisma.crmCompany.create({
        data: {
          name: "warp2549-orphan",
          origin: "EXTERNAL",
          externalSystem: "hubspot",
          externalId: "456",
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a connection with no external id to reconcile against", async () => {
    // Nothing can match this row on the next tick, so every tick lands another.
    await expect(
      prisma.crmCompany.create({
        data: { name: "warp2549-unkeyed", origin: "EXTERNAL", connectionId: connectionA },
      }),
    ).rejects.toThrow();
  });

  it("refuses a landed row that claims to be LOCAL", async () => {
    // `origin` is what the CRM refuses edits on. A row with an upstream and a
    // LOCAL flag would accept local edits the next sync silently overwrites.
    await expect(
      prisma.crmCompany.create({
        data: {
          name: "warp2549-mislabelled",
          origin: "LOCAL",
          connectionId: connectionA,
          externalSystem: "hubspot",
          externalId: "789",
        },
      }),
    ).rejects.toThrow();
  });

  it("🔴 lets two portals of the SAME vendor land their own object 123", async () => {
    // The defect the connection-scoped unique fixes. Under
    // `@@unique([externalSystem, externalId])` the second create is refused
    // forever, and the second portal's customer can never exist on this box.
    const base = { origin: "EXTERNAL" as const, externalSystem: "hubspot", externalId: "123" };
    await prisma.crmCompany.create({
      data: { ...base, name: "warp2549-portal-a-co", connectionId: connectionA },
    });
    const second = await prisma.crmCompany.create({
      data: { ...base, name: "warp2549-portal-b-co", connectionId: connectionB },
    });
    expect(second.connectionId).toBe(connectionB);
  });

  it("still refuses the same object twice on ONE connection", async () => {
    const base = {
      origin: "EXTERNAL" as const,
      externalSystem: "hubspot",
      externalId: "999",
      connectionId: connectionA,
    };
    await prisma.crmCompany.create({ data: { ...base, name: "warp2549-first" } });
    await expect(
      prisma.crmCompany.create({ data: { ...base, name: "warp2549-duplicate" } }),
    ).rejects.toThrow();
  });

  it("holds the same three rules on Contact", async () => {
    const owner = await prisma.user.findFirst({ select: { id: true } });
    const userId = owner?.id ?? "warp2549-no-such-user";

    await expect(
      prisma.contact.create({
        data: {
          userId,
          displayName: "warp2549-orphan",
          origin: "EXTERNAL",
          externalSystem: "hubspot",
          externalId: "c-1",
        },
      }),
    ).rejects.toThrow();

    // A CardDAV contact is EXTERNAL with no vendor pair at all, and must still
    // be creatable — it satisfies the "all three NULL" branch.
    if (owner !== null) {
      const carddav = await prisma.contact.create({
        data: { userId, displayName: "warp2549-carddav", origin: "EXTERNAL" },
      });
      expect(carddav.connectionId).toBeNull();
    }
  });

  it("will not let a connection be deleted out from under landed rows", async () => {
    // RESTRICT, deliberately. If something starts deleting connections, this
    // fails loudly rather than taking a customer's records with it.
    await prisma.crmCompany.create({
      data: {
        name: "warp2549-restrict",
        origin: "EXTERNAL",
        connectionId: connectionA,
        externalSystem: "hubspot",
        externalId: "restrict-1",
      },
    });
    await expect(
      prisma.integrationConnection.delete({ where: { id: connectionA } }),
    ).rejects.toThrow();
  });
});
