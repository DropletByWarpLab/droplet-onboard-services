/**
 * WARP-2549 — the landing seam.
 *
 * Every test here pins a decision that is invisible in the diff and expensive
 * to rediscover: what never lands, which column a landing must not touch, what
 * happens to money it cannot represent, and what a race does.
 */
import { describe, expect, it, vi } from "vitest";

import { landCanonicalRows, landsInCrm, NEVER_LANDED_ENTITIES } from "./land.js";

const CONNECTION = { id: "conn-1", provider: "hubspot" };
const NOW = new Date("2026-09-01T04:00:00.000Z");

/** A Prisma double whose every method is a spy, so a test can assert absence. */
function db(overrides: Record<string, Record<string, unknown>> = {}) {
  const table = (extra: Record<string, unknown> = {}) => ({
    findFirst: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async (args: { data?: Record<string, unknown> }) => ({
      id: "new-id",
      ...(args?.data ?? {}),
    })),
    ...extra,
  });
  const client = {
    user: table({ findFirst: vi.fn(async () => ({ id: "owner-1" })) }),
    contact: table(),
    contactEmail: table(),
    crmCompany: table(),
    crmCompanyContact: table(),
    crmDeal: table(),
    crmPipeline: table({
      create: vi.fn(async () => ({ id: "pipeline-1" })),
    }),
    crmPipelineStage: table({
      create: vi.fn(async () => ({ id: "stage-1" })),
    }),
  };
  for (const [name, methods] of Object.entries(overrides)) {
    Object.assign((client as Record<string, Record<string, unknown>>)[name], methods);
  }
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const land = (client: ReturnType<typeof db>, entity: string, rows: unknown[]) =>
  landCanonicalRows(client as any, { connection: CONNECTION, entity, rows, now: NOW });

describe("what never lands", () => {
  it.each(NEVER_LANDED_ENTITIES)("refuses PHI dataset %s and writes nothing", async (entity) => {
    const client = db();
    const outcome = await land(client, entity, [{ patient_id: "p1", first_name: "Ada" }]);

    expect(outcome).toEqual({ entity, landed: 0, skipped: 1, reason: "not-landed" });
    // The assertion that matters: not "it returned not-landed" but "it touched
    // nothing". A future edit that lands PHI while still reporting the refusal
    // would pass the first check and fail this one.
    expect(client.contact.create).not.toHaveBeenCalled();
    expect(client.contact.updateMany).not.toHaveBeenCalled();
    expect(client.crmCompany.create).not.toHaveBeenCalled();
  });

  it.each(["ticket", "engagement"])("does not land %s either", async (entity) => {
    const client = db();
    const outcome = await land(client, entity, [{ id: "x" }]);
    expect(outcome.reason).toBe("not-landed");
    expect(landsInCrm(entity)).toBe(false);
  });

  it("agrees with itself about which entities land", () => {
    expect(landsInCrm("company")).toBe(true);
    expect(landsInCrm("contact")).toBe(true);
    expect(landsInCrm("deal")).toBe(true);
    for (const phi of NEVER_LANDED_ENTITIES) expect(landsInCrm(phi)).toBe(false);
  });
});

describe("company", () => {
  it("creates with COMPLETE provenance", async () => {
    const client = db();
    const outcome = await land(client, "company", [
      { company_id: "c-1", name: "Northwind", domain: "northwind.test" },
    ]);

    expect(outcome).toMatchObject({ entity: "company", landed: 1, skipped: 0 });
    expect(client.crmCompany.create).toHaveBeenCalledWith({
      data: {
        name: "Northwind",
        domain: "northwind.test",
        origin: "EXTERNAL",
        connectionId: "conn-1",
        externalSystem: "hubspot",
        externalId: "c-1",
      },
    });
  });

  it("names a company the vendor did not name, recognisably", async () => {
    const client = db();
    await land(client, "company", [{ company_id: "c-2", domain: "acme.test" }]);
    expect(client.crmCompany.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "acme.test" }) }),
    );

    const noName = db();
    await land(noName, "company", [{ company_id: "c-3" }]);
    expect(noName.crmCompany.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "HubSpot c-3" }) }),
    );
  });

  it("🔴 never writes isArchived — that column is the owner's, not the vendor's", async () => {
    const client = db({ crmCompany: { updateMany: vi.fn(async () => ({ count: 1 })) } });
    await land(client, "company", [{ company_id: "c-1", name: "Northwind" }]);

    expect(client.crmCompany.create).not.toHaveBeenCalled();
    const [[args]] = client.crmCompany.updateMany.mock.calls as unknown as [[{ data: object }]];
    expect(Object.keys(args.data).sort()).toEqual(["domain", "name"]);
    // Mutation check: a landing that spread the whole record would carry these.
    expect(args.data).not.toHaveProperty("isArchived");
    expect(args.data).not.toHaveProperty("archivedAt");
  });

  it("survives a concurrent tick creating the same row", async () => {
    const conflict = Object.assign(new Error("unique"), { code: "P2002" });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const client = db({
      crmCompany: {
        updateMany,
        create: vi.fn(async () => {
          throw conflict;
        }),
      },
    });

    const outcome = await land(client, "company", [{ company_id: "c-1", name: "Northwind" }]);

    expect(outcome.landed).toBe(1);
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("rethrows anything that is not a unique violation", async () => {
    const client = db({
      crmCompany: {
        create: vi.fn(async () => {
          throw new Error("connection lost");
        }),
      },
    });
    await expect(land(client, "company", [{ company_id: "c-1", name: "N" }])).rejects.toThrow(
      "connection lost",
    );
  });

  it("skips a row the vendor did not identify", async () => {
    const client = db();
    const outcome = await land(client, "company", [{ name: "No id" }, { company_id: "  " }]);
    expect(outcome).toEqual({ entity: "company", landed: 0, skipped: 2, reason: "unidentified" });
    expect(client.crmCompany.create).not.toHaveBeenCalled();
  });
});

describe("contact", () => {
  it("refuses to land when the box has no owner, rather than guessing one", async () => {
    const client = db({ user: { findFirst: vi.fn(async () => null) } });
    const outcome = await land(client, "contact", [{ contact_id: "p-1", first_name: "Ada" }]);

    expect(outcome).toEqual({ entity: "contact", landed: 0, skipped: 1, reason: "no-owner" });
    expect(client.contact.create).not.toHaveBeenCalled();
  });

  it("scopes to the EARLIEST owner, deterministically", async () => {
    const client = db();
    await land(client, "contact", [{ contact_id: "p-1", first_name: "Ada" }]);
    expect(client.user.findFirst).toHaveBeenCalledWith({
      where: { role: "owner" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
  });

  it("falls back through name, then email, then a recognisable id", async () => {
    const named = db();
    await land(named, "contact", [
      { contact_id: "p-1", first_name: "Ada", last_name: "Lovelace", email: "ada@example.test" },
    ]);
    expect(named.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: "Ada Lovelace", userId: "owner-1" }),
      }),
    );

    const emailOnly = db();
    await land(emailOnly, "contact", [{ contact_id: "p-2", email: "grace@example.test" }]);
    expect(emailOnly.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: "grace@example.test" }),
      }),
    );

    const bare = db();
    await land(bare, "contact", [{ contact_id: "p-3" }]);
    expect(bare.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ displayName: "HubSpot p-3" }) }),
    );
  });

  it("REPLACES the vendor's addresses rather than merging them", async () => {
    const client = db({
      contact: { findFirst: vi.fn(async () => ({ id: "contact-1" })) },
    });
    await land(client, "contact", [{ contact_id: "p-1", email: "Ada@Example.Test" }]);

    expect(client.contactEmail.deleteMany).toHaveBeenCalledWith({
      where: { contactId: "contact-1" },
    });
    expect(client.contactEmail.create).toHaveBeenCalledWith({
      data: {
        contactId: "contact-1",
        address: "Ada@Example.Test",
        addressLower: "ada@example.test",
        isPrimary: true,
      },
    });
  });

  it("drops every address when the vendor now sends none", async () => {
    const client = db({ contact: { findFirst: vi.fn(async () => ({ id: "contact-1" })) } });
    await land(client, "contact", [{ contact_id: "p-1", first_name: "Ada" }]);

    expect(client.contactEmail.deleteMany).toHaveBeenCalled();
    expect(client.contactEmail.create).not.toHaveBeenCalled();
  });

  it("links to a company that has landed, and to nothing when it has not", async () => {
    const linked = db({
      contact: { findFirst: vi.fn(async () => ({ id: "contact-1" })) },
      crmCompany: { findFirst: vi.fn(async () => ({ id: "company-1" })) },
    });
    await land(linked, "contact", [{ contact_id: "p-1", company_id: "c-1" }]);
    expect(linked.crmCompanyContact.create).toHaveBeenCalledWith({
      data: { companyId: "company-1", contactId: "contact-1" },
    });

    const unlanded = db({
      contact: { findFirst: vi.fn(async () => ({ id: "contact-1" })) },
    });
    await land(unlanded, "contact", [{ contact_id: "p-1", company_id: "c-9" }]);
    expect(unlanded.crmCompanyContact.create).not.toHaveBeenCalled();
  });
});

describe("deal", () => {
  const DEAL = {
    deal_id: "d-1",
    name: "Retainer",
    stage: "appointmentscheduled",
    amount: "1234.50",
    currency: "USD",
  };

  it("builds the synced pipeline once per page, and only when a deal lands", async () => {
    const empty = db();
    await land(empty, "deal", [{ name: "no id" }]);
    expect(empty.crmPipeline.create).not.toHaveBeenCalled();

    const client = db();
    await land(client, "deal", [DEAL, { ...DEAL, deal_id: "d-2" }]);
    expect(client.crmPipeline.create).toHaveBeenCalledTimes(1);
    expect(client.crmPipeline.create).toHaveBeenCalledWith({
      data: { name: "HubSpot", connectionId: "conn-1", isDefault: false },
      select: { id: true },
    });
  });

  it("keys a stage on the vendor's own value, not on its name", async () => {
    const client = db();
    await land(client, "deal", [DEAL]);
    expect(client.crmPipelineStage.create).toHaveBeenCalledWith({
      data: {
        pipelineId: "pipeline-1",
        externalKey: "appointmentscheduled",
        name: "appointmentscheduled",
        sortOrder: 0,
        kind: "OPEN",
      },
      select: { id: true },
    });
  });

  it("maps only the two stages a vendor actually names as terminal", async () => {
    for (const [stage, kind] of [
      ["closedwon", "WON"],
      ["closedlost", "LOST"],
      ["ClosedWon", "WON"],
      ["3f8a-custom-stage", "OPEN"],
    ] as const) {
      const client = db();
      await land(client, "deal", [{ ...DEAL, stage }]);
      expect(client.crmPipelineStage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ kind }) }),
      );
    }
  });

  it("converts major units with the currency's own exponent", async () => {
    const usd = db();
    await land(usd, "deal", [DEAL]);
    expect(usd.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: BigInt(123450), currency: "USD" }),
      }),
    );

    const jpy = db();
    await land(jpy, "deal", [{ ...DEAL, amount: "1000", currency: "JPY" }]);
    expect(jpy.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: BigInt(1000), currency: "JPY" }),
      }),
    );
  });

  it("lands NO amount rather than a rounded one, and drops the currency with it", async () => {
    const client = db();
    await land(client, "deal", [{ ...DEAL, amount: "1.505", currency: "USD" }]);
    expect(client.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: null, currency: null }),
      }),
    );
  });

  it("has no amount when the vendor priced it in a currency it did not name", async () => {
    const client = db();
    await land(client, "deal", [{ ...DEAL, currency: undefined }]);
    expect(client.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: null, currency: null }),
      }),
    );
  });

  it("🔴 never infers an outcome: a closed date in an unmapped stage stays OPEN", async () => {
    const client = db();
    await land(client, "deal", [
      { ...DEAL, stage: "3f8a-custom", closed_at: "2026-08-30T00:00:00.000Z" },
    ]);
    expect(client.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ closedAt: null }) }),
    );
  });

  it("dates the close when the stage says it closed", async () => {
    const client = db();
    await land(client, "deal", [
      { ...DEAL, stage: "closedwon", closed_at: "2026-08-30T00:00:00.000Z" },
    ]);
    expect(client.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ closedAt: new Date("2026-08-30T00:00:00.000Z") }),
      }),
    );
  });

  it("refuses an unparseable vendor date instead of writing Invalid Date", async () => {
    const client = db();
    await land(client, "deal", [{ ...DEAL, stage: "closedwon", closed_at: "last tuesday" }]);
    expect(client.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ closedAt: null }) }),
    );
  });

  it("attaches the customer when the company has landed", async () => {
    const client = db({ crmCompany: { findFirst: vi.fn(async () => ({ id: "company-1" })) } });
    await land(client, "deal", [{ ...DEAL, company_id: "c-1" }]);
    expect(client.crmDeal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ companyId: "company-1" }) }),
    );
  });
});
