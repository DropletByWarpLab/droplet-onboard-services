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
  const base = { externalSystem: "eaglesoft-api", externalId: "4471" };

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
  const base = { externalSystem: "eaglesoft-api", externalId: "4471", contactId: "c-other" };

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
      { externalSystem: "x", externalId: "y", companyId: "co1" },
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
  const base = { externalSystem: "eaglesoft-api", externalId: "4471", contactId: "c1" };

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
        { externalSystem: "eaglesoft-api", externalId: "4471", contactId: "c1" },
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
