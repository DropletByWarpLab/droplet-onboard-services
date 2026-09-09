/**
 * WARP-2549 — the landing seam.
 *
 * Every test here pins a decision that is invisible in the diff and expensive
 * to rediscover: what never lands, which column a landing must not touch, what
 * happens to money it cannot represent, and what a race does.
 */
import { describe, expect, it, vi } from "vitest";

import { DATASET_NAMES } from "@droplet/shared-types";

import {
  landCanonicalRows,
  landsInCrm,
  LANDED_ENTITIES,
  NEVER_LANDED_ENTITIES,
} from "./land.js";
import { MONEY_ENTITIES } from "./land-money.js";
import { ERP_SYNC_ENTITIES } from "./entities.js";

const CONNECTION = { id: "conn-1", provider: "hubspot" };
const NOW = new Date("2026-09-01T04:00:00.000Z");

/**
 * The stage id the double hands back for a vendor stage key.
 *
 * 🔴 DERIVED FROM THE KEY, never a constant. A double that returned one id for
 * every key made `after.stageId` equal `before.stageId` in every deal fixture,
 * so the STAGE_CHANGE branch of `timelineEntryFor` could not fire — and the
 * tests that read as though they covered a stage move were passing through the
 * field-diff branch instead. Distinct ids are what make those assertions mean
 * what they say.
 */
const stageIdFor = (externalKey: string) => `stage-${externalKey}`;

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
      create: vi.fn(async (args: { data?: { externalKey?: string } }) => ({
        id: stageIdFor(args?.data?.externalKey ?? "unstaged"),
      })),
    }),
    // WARP-2750 — the timeline table. Part of `LandingDb` now, so it is part of
    // the double: a landing that could not reach it is what made every synced
    // deal read as permanently idle.
    crmActivity: table(),
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

/**
 * WARP-2836 — the classification is not total, and until this file nothing said so.
 *
 * `landsOnBox = landsInCrm || landsMoney` decides whether a tick keeps what it
 * read. A dataset in NONE of the three lists falls through to
 * `{ reason: "not-landed" }` — the SAME value a deliberate PHI refusal returns.
 * So "we decided not to keep this" and "nobody ever considered it" are
 * indistinguishable at runtime, and the two tests above cannot tell them apart
 * either: they iterate the lists, so a name in no list is invisible to both.
 *
 * The consequence is not theoretical. `landsOnBox` is evaluated at
 * `erp-sync.service.ts:600`, AFTER `readEntity` has already paged the vendor —
 * so an unclassified-but-scheduled dataset is fetched, discarded, its watermark
 * advanced past the rows, and the tick audited `"Connector synced", true`.
 * Mailchimp and Shopify keep NOTHING today; every dataset either polls is here.
 */
describe("WARP-2836 — every dataset is classified, or is named debt", () => {
  /**
   * 🔴 DEBT, PINNED SO IT CAN ONLY SHRINK. Not an allowlist to grow.
   *
   * These are scheduled in `ERP_SYNC_ENTITIES` and land nowhere, and unlike
   * `booking`/`employee`/`task` — which are also polled without landing, and
   * carry a written reason each in `NEVER_LANDED_ENTITIES` — no reason for
   * these exists anywhere, because nothing ever required one.
   *
   * The exemption set is deliberately SEPARATE from `NEVER_LANDED_ENTITIES`
   * rather than folded into it: merging them would let real debt hide behind a
   * list whose name claims the omission was a decision. Resolving one means
   * either building its sink or moving it to `NEVER_LANDED_ENTITIES` WITH a
   * reason — and either way it comes out of this array, which is why the
   * assertion is an exact `toEqual` and not a superset check.
   */
  const UNCLASSIFIED_SCHEDULED_DEBT = [
    "audience_member",
    "campaign",
    "customer",
    "ecommerce_order",
    "engagement",
    "order",
    "product",
    "ticket",
  ] as const;

  it("🔴 pins the eight scheduled datasets that land nowhere and say nothing about it", () => {
    // Mutation: give `order` a sink (add it to LANDED_ENTITIES/MONEY_ENTITIES)
    // or move it to NEVER_LANDED_ENTITIES → red, and the fix is to delete it
    // from the array above. That is the direction this test is built to move.
    const classified = new Set<string>([
      ...LANDED_ENTITIES,
      ...MONEY_ENTITIES,
      ...NEVER_LANDED_ENTITIES,
    ]);
    const scheduledAndUnclassified = ERP_SYNC_ENTITIES.map((e) => e.entity)
      .filter((e) => !classified.has(e))
      .sort();

    expect(
      scheduledAndUnclassified,
      "these are polled from the vendor on every tick and thrown away, with no " +
        "recorded decision that they should be — resolve one by giving it a sink " +
        "or by naming it in NEVER_LANDED_ENTITIES with a reason",
    ).toEqual([...UNCLASSIFIED_SCHEDULED_DEBT]);
  });

  it("🔴 refuses a NEW dataset name that is classified nowhere at all", () => {
    // The forward-looking half. The pin above freezes today's debt; this stops
    // tomorrow's from being added silently, which is how all eight arrived.
    //
    // Scoped to the vocabulary rather than to the sync table on purpose: a name
    // enters `DATASET_NAMES` first and is scheduled later, so gating at the
    // vocabulary catches it one step earlier — at the commit that invents it.
    //
    // Mutation: append a 27th name to DATASET_NAMES without classifying it → red.
    const classified = new Set<string>([
      ...LANDED_ENTITIES,
      ...MONEY_ENTITIES,
      ...NEVER_LANDED_ENTITIES,
      ...UNCLASSIFIED_SCHEDULED_DEBT,
    ]);
    const unknown = DATASET_NAMES.filter((n) => !classified.has(n)).sort();

    // The remainder is the READ-THROUGH-ONLY tail: real vocabulary that no
    // available provider is scheduled on, so it never reaches a landing at all.
    // Named here rather than waved past, so the next dataset to be scheduled
    // has to move out of this list into a real classification.
    expect(unknown, "unclassified dataset names — decide where each one lands").toEqual([
      "ap_summary",
      "audience",
      "balance_transaction",
      "charge",
      "payout",
      "refund",
      "subscription",
    ]);
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

  // ── WARP-2750: the timeline ────────────────────────────────────────────────
  //
  // Before this, `LandingDb` had no `crmActivity` key at all, so a synced deal
  // could not acquire a timeline row even in principle — and `listDeals({
  // idleDays })` judges idleness on the timeline, so the entire connector book
  // read as untouched forever however active it was upstream.

  /** A deal already on the box, in the shape the landing reads back. */
  const stored = (over: Record<string, unknown> = {}) => ({
    id: "deal-1",
    title: "Retainer",
    stageId: stageIdFor("appointmentscheduled"),
    amountMinor: 123450n,
    currency: "USD",
    closedAt: null,
    ...over,
  });

  it("writes a CREATED entry for a deal landing for the first time", async () => {
    const client = db();
    await land(client, "deal", [DEAL]);
    expect(client.crmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectType: "DEAL",
        dealId: "new-id",
        kind: "CREATED",
        summary: "Landed from HubSpot",
      }),
    });
  });

  it("🔴 writes NOTHING when the vendor re-sends an unchanged deal", async () => {
    // THE CASE THAT MATTERS MOST, and the one whose absence would invert this
    // ticket. A row on every pass keeps the newest activity minutes old
    // forever, so `every: { occurredAt: { lt: cutoff } }` is never true again
    // and NO connector deal is ever reported idle — the mirror of the bug we
    // are fixing, and harder to spot because an empty chase list reads as
    // "nothing needs doing".
    const client = db({
      crmDeal: {
        findFirst: vi.fn(async () => stored()),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await land(client, "deal", [DEAL]);
    expect(client.crmActivity.create).not.toHaveBeenCalled();
  });

  it("writes STAGE_CHANGE carrying the vendor's own stage word, and both stage ids", async () => {
    const client = db({
      crmDeal: {
        findFirst: vi.fn(async () => stored({ stageId: "stage-old" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await land(client, "deal", [DEAL]);
    expect(client.crmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "STAGE_CHANGE",
        summary: "HubSpot moved this to appointmentscheduled",
        fromStageId: "stage-old",
        toStageId: stageIdFor("appointmentscheduled"),
      }),
    });
  });

  it("writes SYNCED naming what moved, when the stage did not", async () => {
    const client = db({
      crmDeal: {
        findFirst: vi.fn(async () => stored({ amountMinor: 999n, title: "Old name" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await land(client, "deal", [DEAL]);
    expect(client.crmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "SYNCED", summary: "HubSpot changed name, amount" }),
    });
  });

  it("notices a close date moving on its own", async () => {
    // ON ITS OWN means the deal is ALREADY in the stage the vendor is sending,
    // so the only thing that moved is the date. Held at the same stage id
    // deliberately: with a different one this would be a stage move, and the
    // close-date arm of the diff would never be reached.
    const client = db({
      crmDeal: {
        findFirst: vi.fn(async () =>
          stored({
            stageId: stageIdFor("closedwon"),
            closedAt: new Date("2020-01-01T00:00:00.000Z"),
          }),
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await land(client, "deal", [{ ...DEAL, stage: "closedwon", closed_at: "2026-01-01" }]);
    expect(client.crmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "SYNCED", summary: "HubSpot changed close date" }),
    });
  });

  it("🔴 records the amount too when the vendor moves the stage in the SAME push", async () => {
    // The failure this ticket exists to fix, recurring inside the fix for it.
    // A vendor payload that re-prices a deal AND advances it writes BOTH
    // columns, and an early return on the stage move left the money change
    // recorded nowhere — the sync audit log is counts-only, so "why is this
    // 9,999 now" had no answer anywhere on the box. A timeline whose whole
    // thesis is admitting what it omits must not omit this.
    const client = db({
      crmDeal: {
        findFirst: vi.fn(async () =>
          stored({ stageId: "stage-old", amountMinor: 999n, title: "Retainer" }),
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await land(client, "deal", [DEAL]);

    // ONE row, not two: the stage move stays the headline (it is what
    // `activity-notify.service.ts` reads, and it is what carries the stage
    // ids), and the other changed fields are named in the same summary.
    expect(client.crmActivity.create).toHaveBeenCalledTimes(1);
    expect(client.crmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "STAGE_CHANGE",
        summary: "HubSpot moved this to appointmentscheduled and changed amount",
        fromStageId: "stage-old",
        toStageId: stageIdFor("appointmentscheduled"),
      }),
    });
  });

  it("names every field that moved alongside the stage, in diff order", async () => {
    const client = db({
      crmDeal: {
        findFirst: vi.fn(async () =>
          stored({
            stageId: "stage-old",
            title: "Old name",
            amountMinor: 999n,
            closedAt: new Date("2020-01-01T00:00:00.000Z"),
          }),
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await land(client, "deal", [DEAL]);
    expect(client.crmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "STAGE_CHANGE",
        summary:
          "HubSpot moved this to appointmentscheduled and changed name, amount, close date",
      }),
    });
  });

  it("🔴 stamps EXTERNAL provenance, never the LOCAL default", async () => {
    // `landed-purge.ts` decides whether a disconnected record may be DELETED by
    // asking whether any `origin: "LOCAL"` activity hangs off it — its test for
    // "did a human write prose here". A machine row left at the default answers
    // yes, and every synced deal on every box silently becomes archive-only.
    const client = db();
    await land(client, "deal", [DEAL]);
    const data = client.crmActivity.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.origin).toBe("EXTERNAL");
    expect(data.externalSystem).toBe("hubspot");
  });

  it("leaves externalId NULL rather than inventing a vendor id", async () => {
    // The table carries a global `@@unique([externalSystem, externalId])`.
    // NULLs are distinct in Postgres, so landed rows coexist — and the slot
    // stays free for a real vendor activity id if one is ever landed.
    const client = db();
    await land(client, "deal", [DEAL]);
    const data = client.crmActivity.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.externalId).toBeUndefined();
  });
});

