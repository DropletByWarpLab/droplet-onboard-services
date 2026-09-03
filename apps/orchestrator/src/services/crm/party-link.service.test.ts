/**
 * WARP-2562 (ADR-044) — the party-link service's own rules.
 *
 * Scope note: these tests cover the MESSAGES and the SCOPING. The XOR and the
 * confidence rule are also CHECK constraints, and `party-link.pg.test.ts`
 * proves those against a real database — a mocked Prisma cannot, and the split
 * is deliberate. Deleting the constraints from the migration leaves every test
 * in this file green, which is exactly why the other file exists.
 *
 * Prisma is hand-stubbed in the style of `contacts.service.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";

import {
  PARTY_LINK_ERRORS,
  archivePartyLink,
  createPartyLink,
  listPartyLinks,
} from "./party-link.service.js";

const ROW = {
  id: "pl1",
  contactId: "c1",
  companyId: null,
  connectionId: "conn-eagle",
  externalSystem: "eaglesoft-api",
  externalId: "4471",
  linkedBy: "MANUAL" as const,
  confidence: null,
  isArchived: false,
  archivedAt: null,
  createdById: "u1",
  createdAt: new Date("2026-08-30T00:00:00.000Z"),
};

/** A prisma stub whose contact lookup succeeds and whose uniqueness check is clear. */
function okPrisma(over: Record<string, unknown> = {}) {
  return {
    contact: { findFirst: vi.fn().mockResolvedValue({ id: "c1" }) },
    crmCompany: { findUnique: vi.fn().mockResolvedValue({ id: "co1" }) },
    // WARP-2562 — the provider is READ from the connection, never taken from
    // the caller, so every happy path needs one to exist.
    integrationConnection: {
      findUnique: vi.fn().mockResolvedValue({ id: "conn-eagle", provider: "eaglesoft-api" }),
    },
    partyLink: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([ROW]),
      create: vi.fn().mockResolvedValue(ROW),
      update: vi.fn().mockResolvedValue({ ...ROW, isArchived: true, archivedAt: new Date() }),
    },
    ...over,
  } as never;
}

describe("exactly one party", () => {
  const base = { connectionId: "conn-eagle", externalId: "4471" };

  it("refuses a link naming both a contact and a company", async () => {
    await expect(
      createPartyLink(okPrisma(), { ...base, contactId: "c1", companyId: "co1" }, "u1", "u1"),
    ).rejects.toThrow(PARTY_LINK_ERRORS.PARTY_AMBIGUOUS);
  });

  it("refuses a link naming neither", async () => {
    await expect(createPartyLink(okPrisma(), base, "u1", "u1")).rejects.toThrow(
      PARTY_LINK_ERRORS.PARTY_AMBIGUOUS,
    );
  });

  it("writes an explicit null for the side that was not given", async () => {
    // `{ contactId: "c1", companyId: undefined }` would leave companyId unset
    // rather than null, and the difference matters to the CHECK constraint.
    const prisma = okPrisma();
    await createPartyLink(prisma, { ...base, contactId: "c1" }, "u1", "u1");
    const data = (prisma as never as { partyLink: { create: ReturnType<typeof vi.fn> } }).partyLink
      .create.mock.calls[0][0].data;
    expect(data.contactId).toBe("c1");
    expect(data.companyId).toBeNull();
  });
});

describe("ownership", () => {
  const base = { connectionId: "conn-eagle", externalId: "4471", contactId: "c-other" };

  it("reads another owner's contact as absent, never as forbidden", async () => {
    // Same rule as contacts.service.ts, and it has to be: a 403 here would
    // confirm the contact exists to someone who should not know that.
    const prisma = okPrisma({ contact: { findFirst: vi.fn().mockResolvedValue(null) } });
    await expect(createPartyLink(prisma, base, "u1", "u1")).rejects.toThrow(
      PARTY_LINK_ERRORS.CONTACT_NOT_FOUND,
    );
  });

  it("scopes the contact lookup in the QUERY rather than checking after the fetch", async () => {
    const prisma = okPrisma();
    await createPartyLink(prisma, { ...base, contactId: "c1" }, "u1", "u1");
    const findFirst = (prisma as never as { contact: { findFirst: ReturnType<typeof vi.fn> } })
      .contact.findFirst;
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: "c1", userId: "u1" });
  });

  it("does not scope a COMPANY by owner — the CRM is business-shared", async () => {
    const prisma = okPrisma();
    await createPartyLink(
      prisma,
      { connectionId: "conn-eagle", externalId: "y", companyId: "co1" },
      "u1",
      "u1",
    );
    const findUnique = (
      prisma as never as { crmCompany: { findUnique: ReturnType<typeof vi.fn> } }
    ).crmCompany.findUnique;
    expect(findUnique.mock.calls[0][0].where).toEqual({ id: "co1" });
  });

  it("refuses to archive another owner's link, and says only that the LINK is missing", async () => {
    // Naming the contact in the error would confirm a row the caller may not
    // know exists — the same leak the 404-not-403 rule closes on reads.
    const prisma = okPrisma({
      contact: { findFirst: vi.fn().mockResolvedValue(null) },
      partyLink: { findUnique: vi.fn().mockResolvedValue(ROW), update: vi.fn() },
    });
    await expect(archivePartyLink(prisma, "pl1", "u2")).rejects.toThrow(
      PARTY_LINK_ERRORS.LINK_NOT_FOUND,
    );
  });
});

describe("confidence belongs to a MATCHED link", () => {
  const base = { connectionId: "conn-eagle", externalId: "4471", contactId: "c1" };

  it("refuses a confidence on a MANUAL link", async () => {
    await expect(
      createPartyLink(okPrisma(), { ...base, confidence: 90 }, "u1", "u1"),
    ).rejects.toThrow(PARTY_LINK_ERRORS.CONFIDENCE_NEEDS_MATCHED);
  });

  it("refuses a MATCHED link with no confidence", async () => {
    await expect(
      createPartyLink(okPrisma(), { ...base, linkedBy: "MATCHED" }, "u1", "u1"),
    ).rejects.toThrow(PARTY_LINK_ERRORS.CONFIDENCE_NEEDS_MATCHED);
  });

  it("refuses a confidence outside 0-100", async () => {
    await expect(
      createPartyLink(
        okPrisma(),
        { ...base, linkedBy: "MATCHED", confidence: 101 },
        "u1",
        "u1",
      ),
    ).rejects.toThrow(PARTY_LINK_ERRORS.CONFIDENCE_NEEDS_MATCHED);
  });

  it("accepts a MATCHED link with a confidence, and defaults linkedBy to MANUAL", async () => {
    const prisma = okPrisma();
    await createPartyLink(prisma, { ...base, linkedBy: "MATCHED", confidence: 88 }, "u1", "u1");
    const create = (prisma as never as { partyLink: { create: ReturnType<typeof vi.fn> } })
      .partyLink.create;
    expect(create.mock.calls[0][0].data.linkedBy).toBe("MATCHED");

    const plain = okPrisma();
    await createPartyLink(plain, base, "u1", "u1");
    const plainCreate = (plain as never as { partyLink: { create: ReturnType<typeof vi.fn> } })
      .partyLink.create;
    expect(plainCreate.mock.calls[0][0].data.linkedBy).toBe("MANUAL");
    expect(plainCreate.mock.calls[0][0].data.confidence).toBeNull();
  });
});

describe("one upstream record, one party", () => {
  it("reports an existing claim as a conflict rather than creating a second", async () => {
    const prisma = okPrisma({
      contact: { findFirst: vi.fn().mockResolvedValue({ id: "c1" }) },
      partyLink: {
        findUnique: vi.fn().mockResolvedValue({ id: "already" }),
        create: vi.fn(),
      },
    });
    await expect(
      createPartyLink(
        prisma,
        { connectionId: "conn-eagle", externalId: "4471", contactId: "c1" },
        "u1",
        "u1",
      ),
    ).rejects.toThrow(PARTY_LINK_ERRORS.ALREADY_LINKED);
    expect(
      (prisma as never as { partyLink: { create: ReturnType<typeof vi.fn> } }).partyLink.create,
    ).not.toHaveBeenCalled();
  });
});

describe("listing and unlinking", () => {
  it("hides archived links by default, and includes them on request", async () => {
    const prisma = okPrisma();
    const findMany = (prisma as never as { partyLink: { findMany: ReturnType<typeof vi.fn> } })
      .partyLink.findMany;

    await listPartyLinks(prisma, { contactId: "c1" }, "u1");
    expect(findMany.mock.calls[0][0].where.isArchived).toBe(false);

    await listPartyLinks(prisma, { contactId: "c1" }, "u1", true);
    expect(findMany.mock.calls[1][0].where.isArchived).toBeUndefined();
  });

  /** `okPrisma()`'s findUnique answers the CREATE path's uniqueness probe with
   *  null; archive uses the same method to LOAD the row, so it needs its own
   *  stub. */
  const archivable = () =>
    okPrisma({
      partyLink: {
        findUnique: vi.fn().mockResolvedValue(ROW),
        update: vi.fn().mockResolvedValue(ROW),
      },
    });

  it("archives rather than deletes, and stamps when", async () => {
    // A hard delete would silently free the upstream id for a different
    // party, with no record that it had ever been claimed.
    const prisma = archivable();
    await archivePartyLink(prisma, "pl1", "u1");
    const update = (prisma as never as { partyLink: { update: ReturnType<typeof vi.fn> } })
      .partyLink.update;
    expect(update.mock.calls[0][0].data.isArchived).toBe(true);
    expect(update.mock.calls[0][0].data.archivedAt).toBeInstanceOf(Date);
  });

  it("un-archives through the same route, clearing the timestamp", async () => {
    const prisma = archivable();
    await archivePartyLink(prisma, "pl1", "u1", false);
    const update = (prisma as never as { partyLink: { update: ReturnType<typeof vi.fn> } })
      .partyLink.update;
    expect(update.mock.calls[0][0].data.isArchived).toBe(false);
    expect(update.mock.calls[0][0].data.archivedAt).toBeNull();
  });
});

/**
 * WARP-2562 review — a link belongs to a CONNECTION, not to a provider.
 *
 * The original shape keyed on `(externalSystem, externalId)` and took the
 * provider from the request body. Two defects fell out of that, and neither
 * was visible on a box with one connection per vendor:
 *
 *   1. HubSpot object ids are PORTAL-scoped. Under a provider-scoped unique,
 *      the second portal's object `123` collides with the first portal's
 *      object `123` — two unrelated customers, and the second is refused as
 *      "already linked" to somebody else's party, permanently.
 *   2. WARP-2461's purge walker keys on `connectionId`, and its own mutation
 *      test proves that scoping a purge by provider destroys the sibling
 *      connection's data. A link table with no `connectionId` cannot be purged
 *      correctly at all.
 */
describe("WARP-2562 — links are scoped to a connection", () => {
  /** Two connections on ONE provider — the shape the old key could not model. */
  function twoPortals(clashOn: { connectionId: string; externalId: string } | null) {
    const create = vi.fn().mockResolvedValue(ROW);
    type ClashLookup = {
      where: { connectionId_externalId?: { connectionId: string; externalId: string } };
    };
    const findUnique = vi.fn().mockImplementation(async (args: ClashLookup) => {
      const where = args.where.connectionId_externalId;
      if (!clashOn || !where) return null;
      return where.connectionId === clashOn.connectionId && where.externalId === clashOn.externalId
        ? { id: "existing" }
        : null;
    });
    return {
      prisma: {
        contact: { findFirst: vi.fn().mockResolvedValue({ id: "c1" }) },
        crmCompany: { findUnique: vi.fn().mockResolvedValue({ id: "co1" }) },
        integrationConnection: {
          findUnique: vi.fn().mockImplementation(async (args: { where: { id: string } }) => {
            const id = args.where.id;
            return id === "conn-north" || id === "conn-south"
              ? { id, provider: "hubspot" }
              : null;
          }),
        },
        partyLink: { findUnique, create, findMany: vi.fn(), update: vi.fn() },
      } as never,
      create,
    };
  }

  it("lets two portals on one provider link the same upstream id", async () => {
    // MUTATION: put the unique back on (externalSystem, externalId) and this
    // second link is refused as ALREADY_LINKED — the customer becomes
    // unlinkable on whichever portal was connected second.
    const { prisma, create } = twoPortals({ connectionId: "conn-north", externalId: "123" });

    await createPartyLink(
      prisma,
      { connectionId: "conn-south", externalId: "123", companyId: "co1" },
      "u1",
      "u1",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.connectionId).toBe("conn-south");
  });

  it("still refuses a second link to the same record in the SAME connection", async () => {
    // The rule the scoping must not lose: one upstream record, one party.
    const { prisma } = twoPortals({ connectionId: "conn-north", externalId: "123" });

    await expect(
      createPartyLink(
        prisma,
        { connectionId: "conn-north", externalId: "123", companyId: "co1" },
        "u1",
        "u1",
      ),
    ).rejects.toThrow(PARTY_LINK_ERRORS.ALREADY_LINKED);
  });

  it("derives the provider from the connection instead of trusting the caller", async () => {
    // MUTATION: take `externalSystem` from the input again → a link can claim
    // a vendor its own connection contradicts, and no reader can tell which
    // half is true. The caller here cannot express a provider at all.
    const { prisma, create } = twoPortals(null);

    await createPartyLink(
      prisma,
      { connectionId: "conn-north", externalId: "123", companyId: "co1" },
      "u1",
      "u1",
    );
    expect(create.mock.calls[0][0].data.externalSystem).toBe("hubspot");
  });

  it("404s on a connection that does not exist, before any uniqueness check", async () => {
    // Ordering matters: a bad connection id used to reach the create and come
    // back as a foreign-key 500, or as a confusing "already linked".
    const { prisma } = twoPortals(null);

    await expect(
      createPartyLink(
        prisma,
        { connectionId: "conn-gone", externalId: "123", companyId: "co1" },
        "u1",
        "u1",
      ),
    ).rejects.toThrow(PARTY_LINK_ERRORS.CONNECTION_NOT_FOUND);
  });
});

/**
 * WARP-2562 review — archiving a link must FREE its `(connection, externalId)`
 * slot.
 *
 * The shipped shape held the slot forever. `PartyLink_connectionId_externalId_key`
 * covered every row regardless of `isArchived`, and the create-time probe used
 * `findUnique` on that key — which cannot express `isArchived`, because the
 * key does not contain it. So:
 *
 *   link Contact A to record #4471 → archive it as wrong → every later attempt
 *   to link the CORRECT Contact B to #4471 is a permanent 409.
 *
 * The only exposed recovery was to un-archive, which restores the WRONG link.
 * That makes `archivePartyLink` a trap rather than an undo, and it is why the
 * unique is now PARTIAL (`WHERE "isArchived" = false`).
 */
describe("WARP-2562 review — an archived link does not hold the slot", () => {
  interface Slot {
    id: string;
    connectionId: string;
    externalId: string;
    isArchived: boolean;
  }
  interface KeyedWhere {
    where: { connectionId_externalId: { connectionId: string; externalId: string } };
  }
  interface FlatWhere {
    where: { connectionId?: string; externalId?: string; isArchived?: boolean };
  }

  /**
   * A party-link double whose two lookup methods behave the way Prisma's do,
   * because the difference between them IS the defect:
   *
   *   · `findUnique` on the compound key matches the PAIR and nothing else. It
   *     has no way to take `isArchived` — so an archived row answers a
   *     uniqueness probe as though it were a live claim.
   *   · `findFirst` applies every predicate it is handed, so it can be asked
   *     the question actually being asked: is this slot claimed by a link that
   *     is still LIVE?
   *
   * A stub that answered both identically would go green either way, and the
   * defect would survive the test.
   */
  function linkPrisma(rows: Slot[]) {
    const create = vi.fn().mockResolvedValue(ROW);
    const update = vi.fn().mockResolvedValue(ROW);
    const findUnique = vi.fn(async (args: KeyedWhere) => {
      const key = args.where.connectionId_externalId;
      if (!key) return null;
      return (
        rows.find((r) => r.connectionId === key.connectionId && r.externalId === key.externalId) ??
        null
      );
    });
    const findFirst = vi.fn(async (args: FlatWhere) => {
      const w = args.where;
      return (
        rows.find(
          (r) =>
            (w.connectionId === undefined || r.connectionId === w.connectionId) &&
            (w.externalId === undefined || r.externalId === w.externalId) &&
            (w.isArchived === undefined || r.isArchived === w.isArchived),
        ) ?? null
      );
    });
    return {
      prisma: {
        contact: { findFirst: vi.fn().mockResolvedValue({ id: "c1" }) },
        crmCompany: { findUnique: vi.fn().mockResolvedValue({ id: "co1" }) },
        integrationConnection: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ id: "conn-eagle", provider: "eaglesoft-api", status: "CONNECTED" }),
        },
        partyLink: { findUnique, findFirst, create, update, findMany: vi.fn() },
      } as never,
      create,
      findFirst,
    };
  }

  const base = { connectionId: "conn-eagle", externalId: "4471", contactId: "c1" };

  it("lets the CORRECT party claim a record whose wrong link was archived", async () => {
    // MUTATION: drop the `isArchived: false` filter from the clash check and
    // this is a 409 forever — the customer becomes unlinkable on the only
    // party they actually belong to.
    const { prisma, create } = linkPrisma([
      { id: "wrong", connectionId: "conn-eagle", externalId: "4471", isArchived: true },
    ]);

    await createPartyLink(prisma, base, "u1", "u1");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.externalId).toBe("4471");
  });

  it("still refuses when the existing claim is LIVE", async () => {
    // The rule the scoping must not lose. One upstream record, one party.
    const { prisma, create } = linkPrisma([
      { id: "live", connectionId: "conn-eagle", externalId: "4471", isArchived: false },
    ]);

    await expect(createPartyLink(prisma, base, "u1", "u1")).rejects.toThrow(
      PARTY_LINK_ERRORS.ALREADY_LINKED,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("asks whether the slot is claimed by a link that is still live", async () => {
    // Pinned as the QUERY, not only as an outcome: a probe that fetched the
    // row and filtered in JavaScript afterwards would pass both tests above
    // and still disagree with the partial index under a race.
    const { prisma, findFirst } = linkPrisma([]);

    await createPartyLink(prisma, base, "u1", "u1");

    expect(findFirst.mock.calls[0][0].where).toEqual({
      connectionId: "conn-eagle",
      externalId: "4471",
      isArchived: false,
    });
  });

  it("refuses to un-archive a link whose slot a live one has since taken", async () => {
    // The dual of freeing the slot, and a hazard the old always-blocking
    // unique could not produce: un-archiving is now a write that can collide.
    // Without this check the partial index raises a bare P2002 at any caller
    // that is not the route.
    const { prisma } = linkPrisma([
      { id: "live", connectionId: "conn-eagle", externalId: "4471", isArchived: false },
    ]);
    const partyLink = (prisma as never as { partyLink: { findUnique: ReturnType<typeof vi.fn> } })
      .partyLink;
    partyLink.findUnique = vi
      .fn()
      .mockResolvedValue({ ...ROW, id: "pl1", isArchived: true, archivedAt: new Date() });

    await expect(archivePartyLink(prisma, "pl1", "u1", false)).rejects.toThrow(
      PARTY_LINK_ERRORS.ALREADY_LINKED,
    );
  });
});

/**
 * WARP-2562 review — a link needs a connection that can still be FETCHED from.
 *
 * The row is a pointer whose entire value is that its detail is read live
 * through the connector. `disconnect()` sets `status: "DISABLED"` and purges
 * `apiCredentialsEnc` and `providerTokensEnc` in the same write, so a link
 * made against a DISABLED connection points at a record nothing on this box
 * can read — and the create path selected only `id` and `provider`, so a stale
 * browser tab could make one.
 *
 * The allow-list is explicit and enum-valued, in the shape of
 * `POLLABLE_CONNECTION_STATUSES` in `erp-sync/cursor.service.ts`, and is
 * deliberately WIDER than that one: linking is a human act writing a local
 * row, not a metered vendor call on a schedule.
 */
describe("WARP-2562 review — linking against a connection that cannot be read", () => {
  function withStatus(status: string) {
    const create = vi.fn().mockResolvedValue(ROW);
    const findUnique = vi.fn().mockResolvedValue({
      id: "conn-eagle",
      provider: "eaglesoft-api",
      status,
    });
    return {
      prisma: {
        contact: { findFirst: vi.fn().mockResolvedValue({ id: "c1" }) },
        crmCompany: { findUnique: vi.fn().mockResolvedValue({ id: "co1" }) },
        integrationConnection: { findUnique },
        partyLink: {
          findUnique: vi.fn().mockResolvedValue(null),
          findFirst: vi.fn().mockResolvedValue(null),
          create,
          findMany: vi.fn(),
          update: vi.fn(),
        },
      } as never,
      create,
      connectionLookup: findUnique,
    };
  }

  const base = { connectionId: "conn-eagle", externalId: "4471", contactId: "c1" };

  it("refuses a DISABLED connection — disconnect purged both credentials", async () => {
    // MUTATION: drop the status check and this create succeeds, leaving a
    // pointer whose detail no code on this box can fetch.
    const { prisma, create } = withStatus("DISABLED");

    await expect(createPartyLink(prisma, base, "u1", "u1")).rejects.toThrow(
      PARTY_LINK_ERRORS.CONNECTION_NOT_ACTIVE,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["NOT_CONFIGURED", "PROVISIONING", "NEEDS_RECONNECT", "ERROR", "DISABLED"])(
    "refuses %s, which holds no credential a fetch could spend",
    async (status) => {
      const { prisma } = withStatus(status);
      await expect(createPartyLink(prisma, base, "u1", "u1")).rejects.toThrow(
        PARTY_LINK_ERRORS.CONNECTION_NOT_ACTIVE,
      );
    },
  );

  it.each(["CONNECTED", "DEGRADED", "DRIFT_LOCKED"])(
    "allows %s, which still holds a working credential",
    async (status) => {
      // DEGRADED is an explicitly transient sync failure, and DRIFT_LOCKED
      // freezes WRITES only — a party link is a local row and its detail is a
      // READ. Refusing either would block linking for a state the owner has
      // nothing to do about.
      const { prisma, create } = withStatus(status);
      await createPartyLink(prisma, base, "u1", "u1");
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it("reads the status COLUMN rather than inferring it from a missing credential", async () => {
    // WARP-884 shape: state comes from the enum column, never from which
    // flavour of null a reader happens to be holding.
    const { prisma, connectionLookup } = withStatus("CONNECTED");
    await createPartyLink(prisma, base, "u1", "u1");
    expect(connectionLookup.mock.calls[0][0].select).toMatchObject({ status: true });
  });
});
