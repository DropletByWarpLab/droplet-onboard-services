/**
 * WARP-2018/2032 — the contact write path's normalization and ownership rules.
 * Prisma is hand-stubbed in the style of `pm.service.counts.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";

import {
  CONTACT_ERRORS,
  createContact,
  deriveDisplayName,
  listContacts,
  normalizeEmail,
  normalizePhone,
  updateContact,
} from "./contacts.service.js";

describe("normalization", () => {
  it("derives the lookup form of an address rather than trusting the caller", () => {
    // `addressLower` is the index and the dedupe key. If it came from the
    // request body, a caller could send address="A@x.com" with
    // addressLower="zzz" and be invisible to every lookup.
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("strips only the tel: scheme from a phone number", () => {
    // Humans format numbers in ways no normalizer improves, and rewriting them
    // loses the extension syntax people actually dial.
    expect(normalizePhone("tel:+1 (415) 555-0100;ext=42")).toBe("+1 (415) 555-0100;ext=42");
    expect(normalizePhone("TEL:555-0100")).toBe("555-0100");
    expect(normalizePhone("  +44 20 7946 0958 ")).toBe("+44 20 7946 0958");
  });
});

describe("deriveDisplayName", () => {
  it("builds a name from the parts instead of rejecting the input", () => {
    // "First name and nothing else" is a real contact. The schema needs a
    // displayName; the API should not make the human supply it twice.
    expect(deriveDisplayName({ givenName: "Ada" })).toBe("Ada");
    expect(deriveDisplayName({ givenName: "Ada", familyName: "Lovelace" })).toBe("Ada Lovelace");
    expect(deriveDisplayName({ familyName: "Lovelace" })).toBe("Lovelace");
  });

  it("prefers an explicit name over anything derived", () => {
    expect(
      deriveDisplayName({ displayName: "Countess Lovelace", givenName: "Ada", familyName: "L" }),
    ).toBe("Countess Lovelace");
  });

  it("falls back to organization, then to the first email", () => {
    // A row with no name at all renders as a blank line in the list — worse
    // than an ugly one.
    expect(deriveDisplayName({ organization: "Analytical Engines Ltd" })).toBe(
      "Analytical Engines Ltd",
    );
    expect(deriveDisplayName({ emails: [{ address: "ada@example.com" }] })).toBe(
      "ada@example.com",
    );
    expect(deriveDisplayName({})).toBeNull();
    // Whitespace is not a name.
    expect(deriveDisplayName({ displayName: "   ", givenName: "  " })).toBeNull();
  });
});

describe("createContact", () => {
  const created = {
    id: "c1",
    origin: "LOCAL",
    sourceId: null,
    externalSystem: null,
    externalId: null,
    displayName: "Ada Lovelace",
    givenName: "Ada",
    familyName: "Lovelace",
    organization: null,
    jobTitle: null,
    note: null,
    birthday: null,
    emails: [],
    phones: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("marks the first entry primary when the caller marked none", async () => {
    // A list with no primary renders with no headline address; a list with
    // three renders arbitrarily. Both are decided here, once.
    const create = vi.fn().mockResolvedValue(created);
    const prisma = { contact: { create } } as never;

    await createContact(prisma, "u1", {
      givenName: "Ada",
      familyName: "Lovelace",
      emails: [{ address: "a@x.com" }, { address: "b@x.com" }],
      phones: [{ number: "tel:555-0100" }, { number: "555-0101" }],
    });

    const data = create.mock.calls[0][0].data;
    expect(data.emails.create.map((e: { isPrimary: boolean }) => e.isPrimary)).toEqual([
      true,
      false,
    ]);
    expect(data.phones.create.map((p: { isPrimary: boolean }) => p.isPrimary)).toEqual([
      true,
      false,
    ]);
    // And the tel: scheme is gone by the time it reaches the column.
    expect(data.phones.create[0].number).toBe("555-0100");
  });

  it("keeps exactly one primary when the caller marked several", async () => {
    const create = vi.fn().mockResolvedValue(created);
    const prisma = { contact: { create } } as never;

    await createContact(prisma, "u1", {
      givenName: "Ada",
      emails: [
        { address: "a@x.com", isPrimary: true },
        { address: "b@x.com", isPrimary: true },
      ],
    });

    const flags = create.mock.calls[0][0].data.emails.create.map(
      (e: { isPrimary: boolean }) => e.isPrimary,
    );
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(flags[0]).toBe(true);
  });

  it("refuses the same address twice on one contact", async () => {
    // Two rows differing only by case would both be written, then both match
    // every lookup — a duplicate that looks like a bug in search.
    const prisma = { contact: { create: vi.fn() } } as never;
    await expect(
      createContact(prisma, "u1", {
        givenName: "Ada",
        emails: [{ address: "a@x.com" }, { address: "A@X.com" }],
      }),
    ).rejects.toThrow(CONTACT_ERRORS.DUPLICATE_EMAIL);
  });

  it("writes the derived lowercase form alongside the address as typed", async () => {
    const create = vi.fn().mockResolvedValue(created);
    const prisma = { contact: { create } } as never;
    await createContact(prisma, "u1", {
      givenName: "Ada",
      emails: [{ address: " Ada@Example.COM " }],
    });
    const email = create.mock.calls[0][0].data.emails.create[0];
    expect(email.address).toBe("Ada@Example.COM");
    expect(email.addressLower).toBe("ada@example.com");
  });
});

describe("ownership and external rows", () => {
  it("reads another owner's contact as absent, never as forbidden", async () => {
    // A 403 would confirm the id exists. Scoping the QUERY by userId — rather
    // than fetching then checking — is what makes that impossible to forget.
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { contact: { findFirst } } as never;

    await expect(updateContact(prisma, "u1", "c-other", { note: "x" })).rejects.toThrow(
      CONTACT_ERRORS.CONTACT_NOT_FOUND,
    );
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: "c-other", userId: "u1" });
  });

  it("refuses to edit a row a sync source owns", async () => {
    // The next sync would revert the edit. Refusing up front is the difference
    // between "no" and "yes, briefly".
    const prisma = {
      contact: {
        findFirst: async () => ({
          id: "c1",
          origin: "EXTERNAL",
          sourceId: "src1",
          emails: [],
          phones: [],
        }),
      },
    } as never;

    await expect(updateContact(prisma, "u1", "c1", { note: "x" })).rejects.toThrow(
      CONTACT_ERRORS.CONTACT_IS_EXTERNAL,
    );
  });

  it("decides EXTERNAL from origin, not from having a source", async () => {
    // A cloud connector's contact is EXTERNAL with no address-book source at
    // all. Testing `sourceId !== null` would let it be edited.
    const prisma = {
      contact: {
        findFirst: async () => ({
          id: "c1",
          origin: "EXTERNAL",
          sourceId: null,
          externalSystem: "m365",
          emails: [],
          phones: [],
        }),
      },
    } as never;

    await expect(updateContact(prisma, "u1", "c1", { note: "x" })).rejects.toThrow(
      CONTACT_ERRORS.CONTACT_IS_EXTERNAL,
    );
  });
});

describe("listContacts", () => {
  it("searches email against the indexed lowercase column", async () => {
    // Matching `address` would miss `Ada@Example.com` for a query of `ada@` and
    // would not use the index either.
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { contact: { findMany, count: async () => 0 } } as never;

    await listContacts(prisma, "u1", { query: "ADA@Example" });
    const or = findMany.mock.calls[0][0].where.OR;
    expect(or[2].emails.some.addressLower.contains).toBe("ada@example");
  });

  it("always scopes by owner, with or without a query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { contact: { findMany, count: async () => 0 } } as never;

    await listContacts(prisma, "u1", {});
    expect(findMany.mock.calls[0][0].where.userId).toBe("u1");
    await listContacts(prisma, "u1", { query: "ada" });
    expect(findMany.mock.calls[1][0].where.userId).toBe("u1");
  });

  it("clamps page size instead of trusting it", async () => {
    // An unclamped per_page is a one-request way to ask for the whole table.
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { contact: { findMany, count: async () => 0 } } as never;

    await listContacts(prisma, "u1", { perPage: 100000 });
    expect(findMany.mock.calls[0][0].take).toBe(200);
    await listContacts(prisma, "u1", { perPage: 0 });
    expect(findMany.mock.calls[1][0].take).toBe(1);
  });
});
