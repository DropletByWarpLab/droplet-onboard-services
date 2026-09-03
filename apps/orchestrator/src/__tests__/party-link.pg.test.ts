/**
 * WARP-2562 (ADR-044) — the three PartyLink invariants that only a real
 * database can hold.
 *
 * The service checks the XOR and the confidence rule too, and those checks are
 * tested with a mocked Prisma next door. This file exists because a service
 * check is a MESSAGE and the constraint is the INVARIANT: a connector, a data
 * migration, a psql session, or the landing seam of WARP-2549 all write this
 * table without passing through `party-link.service.ts`.
 *
 * The mutation that makes the difference visible: delete
 * `PartyLink_party_exactly_one` from the migration. Every mocked test still
 * passes. These go red.
 *
 * Real-Postgres and gated exactly like the other `*.pg.test.ts` suites.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PartyLink invariants live in the database (WARP-2562)", () => {
  let prisma: PrismaClient;

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

  // Namespaced like the sibling suites: the pg-gated files share one throwaway
  // DB and run in parallel, so an unscoped deleteMany() would eat another
  // suite's rows.
  const OURS = { startsWith: "warp2562-" } as const;

  beforeEach(async () => {
    // Links first — they FK to both parties, and a failed run must not leave a
    // row whose party we are about to delete.
    await prisma.partyLink.deleteMany({ where: { externalSystem: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.contact.deleteMany({ where: { displayName: OURS } });
    // AFTER the links: the connection FK is RESTRICT, so a leftover link
    // would block this delete — which is the constraint doing its job, and
    // the reason the order here is not arbitrary.
    await prisma.integrationConnection.deleteMany({ where: { provider: OURS } });
  });

  async function aContact(suffix = "1"): Promise<string> {
    const row = await prisma.contact.create({
      data: { displayName: `warp2562-person-${suffix}`, userId: `warp2562-owner-${suffix}` },
    });
    return row.id;
  }

  async function aCompany(suffix = "1"): Promise<string> {
    const row = await prisma.crmCompany.create({ data: { name: `warp2562-co-${suffix}` } });
    return row.id;
  }

  /**
   * A connection to link against. `provider` is namespaced like everything
   * else here, and two calls with the SAME provider give two connections on
   * one vendor — the two-portal shape the connection-scoped unique exists for.
   */
  async function aConnection(suffix: string, provider = "warp2562-vendor"): Promise<string> {
    const row = await prisma.integrationConnection.create({
      data: {
        provider,
        host: `warp2562-host-${suffix}`,
        databaseName: `warp2562-db-${suffix}`,
        secretRef: `warp2562-secret-${suffix}`,
      },
    });
    return row.id;
  }

  describe("exactly one party", () => {
    it("refuses a link that names BOTH a contact and a company", async () => {
      const contactId = await aContact();
      const companyId = await aCompany();
      const connectionId = await aConnection("both");
      await expect(
        prisma.partyLink.create({
          data: {
            contactId,
            companyId,
            connectionId,
            externalSystem: "warp2562-vendor",
            externalId: "both",
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses a link that names NEITHER — a pointer with nothing on this side", async () => {
      const connectionId = await aConnection("neither");
      await expect(
        prisma.partyLink.create({
          data: { connectionId, externalSystem: "warp2562-vendor", externalId: "neither" },
        }),
      ).rejects.toThrow();
    });

    it("accepts a contact-only link and a company-only link", async () => {
      const contactId = await aContact();
      const companyId = await aCompany();
      const connectionId = await aConnection("accepts");
      await prisma.partyLink.create({
        data: { contactId, connectionId, externalSystem: "warp2562-vendor", externalId: "c-1" },
      });
      await prisma.partyLink.create({
        data: { companyId, connectionId, externalSystem: "warp2562-vendor", externalId: "co-1" },
      });
      expect(await prisma.partyLink.count({ where: { externalSystem: OURS } })).toBe(2);
    });
  });

  describe("one upstream record, one party", () => {
    it("refuses a second link to the same (system, id) from a DIFFERENT party", async () => {
      // The case a per-party unique index would miss, and the one that
      // matters: two parties each claiming patient #4471 is a contradiction,
      // not a second opinion.
      const first = await aContact("a");
      const second = await aContact("b");
      const connectionId = await aConnection("eagle", "warp2562-eaglesoft");
      await prisma.partyLink.create({
        data: { contactId: first, connectionId, externalSystem: "warp2562-eaglesoft", externalId: "4471" },
      });
      await expect(
        prisma.partyLink.create({
          data: { contactId: second, connectionId, externalSystem: "warp2562-eaglesoft", externalId: "4471" },
        }),
      ).rejects.toThrow();
    });

    it("lets one party hold links across several upstreams", async () => {
      const contactId = await aContact();
      const eaglesoft = await aConnection("e", "warp2562-eaglesoft");
      const stripe = await aConnection("s", "warp2562-stripe");
      const hubspot = await aConnection("h", "warp2562-hubspot");
      await prisma.partyLink.create({
        data: { contactId, connectionId: eaglesoft, externalSystem: "warp2562-eaglesoft", externalId: "4471" },
      });
      await prisma.partyLink.create({
        data: { contactId, connectionId: stripe, externalSystem: "warp2562-stripe", externalId: "cus_9f2" },
      });
      await prisma.partyLink.create({
        data: { contactId, connectionId: hubspot, externalSystem: "warp2562-hubspot", externalId: "1234" },
      });
      // The whole reason this is a join table and not the unique
      // (externalSystem, externalId) pair already on Contact.
      expect(await prisma.partyLink.count({ where: { contactId } })).toBe(3);
    });
  });

  describe("confidence belongs to a MATCHED link", () => {
    it("refuses a confidence on a MANUAL link — a number nobody computed", async () => {
      const contactId = await aContact();
      const connectionId = await aConnection("confidence");
      await expect(
        prisma.partyLink.create({
          data: {
            contactId,
            connectionId,
            externalSystem: "warp2562-vendor",
            externalId: "manual-with-confidence",
            linkedBy: "MANUAL",
            confidence: 90,
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses a MATCHED link with no confidence — it hides how sure the matcher was", async () => {
      const contactId = await aContact();
      const connectionId = await aConnection("confidence");
      await expect(
        prisma.partyLink.create({
          data: {
            contactId,
            connectionId,
            externalSystem: "warp2562-vendor",
            externalId: "matched-no-confidence",
            linkedBy: "MATCHED",
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses a confidence outside 0-100", async () => {
      const contactId = await aContact();
      const connectionId = await aConnection("confidence");
      await expect(
        prisma.partyLink.create({
          data: {
            contactId,
            connectionId,
            externalSystem: "warp2562-vendor",
            externalId: "over",
            linkedBy: "MATCHED",
            confidence: 101,
          },
        }),
      ).rejects.toThrow();
    });

    it("accepts a MATCHED link with a confidence in range", async () => {
      const contactId = await aContact();
      const connectionId = await aConnection("matched-ok");
      const row = await prisma.partyLink.create({
        data: {
          contactId,
          connectionId,
          externalSystem: "warp2562-vendor",
          externalId: "ok",
          linkedBy: "MATCHED",
          confidence: 88,
        },
      });
      expect(row.confidence).toBe(88);
    });
  });

  describe("deleting a party takes its links and nothing else", () => {
    it("cascades from the contact, and leaves another party's links alone", async () => {
      const doomed = await aContact("doomed");
      const survivor = await aCompany("survivor");
      const connectionId = await aConnection("cascade");
      await prisma.partyLink.create({
        data: { contactId: doomed, connectionId, externalSystem: "warp2562-vendor", externalId: "gone" },
      });
      await prisma.partyLink.create({
        data: { companyId: survivor, connectionId, externalSystem: "warp2562-vendor", externalId: "kept" },
      });

      await prisma.contact.delete({ where: { id: doomed } });

      // Unlike CrmActivity, nothing a human authored dies here: the row was a
      // pointer, and the upstream record it pointed at is untouched.
      expect(await prisma.partyLink.count({ where: { externalId: "gone" } })).toBe(0);
      expect(await prisma.partyLink.count({ where: { externalId: "kept" } })).toBe(1);
    });
  });

  describe("PmProject.companyId", () => {
    it("survives the customer being deleted — the job still happened", async () => {
      const companyId = await aCompany("client");
      const workspace = await prisma.pmWorkspace.create({
        data: { name: "warp2562-ws", slug: `warp2562-ws-${Date.now()}` },
      });
      const project = await prisma.pmProject.create({
        data: {
          workspaceId: workspace.id,
          name: "warp2562-project",
          identifier: "W2562",
          companyId,
        },
      });

      await prisma.crmCompany.delete({ where: { id: companyId } });

      // SetNull, not Cascade. Mutation: make the relation Cascade → the
      // project disappears and this read returns null.
      const after = await prisma.pmProject.findUnique({ where: { id: project.id } });
      expect(after).not.toBeNull();
      expect(after?.companyId).toBeNull();

      await prisma.pmProject.delete({ where: { id: project.id } });
      await prisma.pmWorkspace.delete({ where: { id: workspace.id } });
    });
  });
  /**
   * WARP-2562 review — the unique is scoped to a CONNECTION, not a provider.
   *
   * The original index was `(externalSystem, externalId)`. On a box with one
   * connection per vendor that reads identically; on a box with two HubSpot
   * portals it is wrong, and wrong in the direction that cannot be worked
   * around from the UI.
   */
  describe("two connections on one provider", () => {
    it("each hold the same upstream id, because those are different records", async () => {
      // HubSpot object ids are PORTAL-scoped, so portal A's `123` and portal
      // B's `123` are two unrelated customers.
      //
      // MUTATION: restore `PartyLink_externalSystem_externalId_key` → the
      // second create is refused, and the second portal's customer can never
      // be linked at all.
      const north = await aConnection("north", "warp2562-hubspot");
      const south = await aConnection("south", "warp2562-hubspot");
      const a = await aCompany("a");
      const b = await aCompany("b");

      await prisma.partyLink.create({
        data: { companyId: a, connectionId: north, externalSystem: "warp2562-hubspot", externalId: "123" },
      });
      await prisma.partyLink.create({
        data: { companyId: b, connectionId: south, externalSystem: "warp2562-hubspot", externalId: "123" },
      });

      expect(await prisma.partyLink.count({ where: { externalSystem: OURS } })).toBe(2);
    });

    it("still refuse a second link to the same record in the SAME connection", async () => {
      // The rule the scoping must not lose. One upstream record, one party.
      const north = await aConnection("north", "warp2562-hubspot");
      const a = await aCompany("a");
      const b = await aCompany("b");

      await prisma.partyLink.create({
        data: { companyId: a, connectionId: north, externalSystem: "warp2562-hubspot", externalId: "123" },
      });
      await expect(
        prisma.partyLink.create({
          data: { companyId: b, connectionId: north, externalSystem: "warp2562-hubspot", externalId: "123" },
        }),
      ).rejects.toThrow();
    });

    it("keeps a connection from being deleted out from under its links", async () => {
      // RESTRICT, not CASCADE. Nothing deletes an IntegrationConnection today
      // — disconnect flips it to DISABLED in place — so this fires only if
      // something new starts to, and at that point the links must be purged
      // deliberately rather than swept away.
      //
      // MUTATION: make the FK CASCADE → the delete succeeds and a human's
      // confirmed matches vanish with no audit and no decision.
      const connectionId = await aConnection("restrict");
      const companyId = await aCompany("r");
      await prisma.partyLink.create({
        data: { companyId, connectionId, externalSystem: "warp2562-vendor", externalId: "keep" },
      });

      await expect(
        prisma.integrationConnection.delete({ where: { id: connectionId } }),
      ).rejects.toThrow();

      expect(await prisma.partyLink.count({ where: { connectionId } })).toBe(1);
    });
  });
});
