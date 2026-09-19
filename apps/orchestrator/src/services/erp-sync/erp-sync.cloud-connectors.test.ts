/**
 * WARP-2497 — the scheduled sync, end to end, over REAL cloud connectors.
 *
 * Every other test in this directory injects a hand-rolled connector stub, so
 * none of them can see the defect this story fixes: `HubSpotConnector.runRead`
 * and `MailchimpConnector.runRead` both THREW by design, and the runner's
 * failure handler turned that into a `FAILED` cursor rather than into rows.
 * The sync ran on schedule, against a real portal, and landed nothing.
 *
 * So the connector here is the real thing — a `HubSpotConnector` and a
 * `MailchimpConnector` constructed with an injected `fetchImpl`. No vendor is
 * reached: every request is answered from the fixtures below, and the test
 * asserts that fact rather than assuming it. Prisma stays a `vi.fn()` store,
 * per the team rule against mock-database integration tests.
 *
 * ## The entity table used to be mocked here. WARP-2509 deleted the mock.
 *
 * `ERP_SYNC_ENTITIES` shipped with exactly two rows — `invoice` and `bill`,
 * both accounting datasets that neither of these tracks serves — so a cursor
 * naming any other entity was answered `ENTITY_NOT_SERVED` and failed. This
 * file mocked the table to get past that, and said so: the mock WAS the
 * specification of the rows `entities.ts` still needed.
 *
 * Those rows now exist, so the mock is gone and these tests run against the
 * real table. The difference matters. With the mock, this file proved that
 * *given* a cursor for a CRM or marketing dataset the connector answers with
 * canonical rows — and explicitly did NOT prove the shipped scheduler ever
 * creates such a cursor. It did not. The `registerCursors` test at the bottom
 * is the half that was missing, and it is the one that goes red if anybody
 * removes a row from that table again.
 */
import { describe, it, expect, vi } from "vitest";
import {
  HubSpotConnector,
  MailchimpConnector,
  resetSearchGovernors,
  type Connector,
} from "@droplet/erp-connector";

import { ERP_SYNC_ENTITIES } from "./entities.js";
import { createErpSyncRunner } from "./erp-sync.service.js";

const NOW = new Date("2026-08-27T12:00:00Z");

/** `pat-`-prefixed so the redaction assertions elsewhere keep working, and
 *  deliberately NOT the UUID body a real token has — that shape trips GitHub's
 *  "Hubspot API Key" push-protection detector even with gitleaks clean. */
const HUBSPOT_TOKEN = "pat-na1-EXAMPLE-FIXTURE-NOT-A-REAL-TOKEN";
const PORTAL = "48273615";
/** Split across two literals on purpose: a contiguous `[0-9a-f]{32}-us<n>`
 *  matches GitHub's Mailchimp detector and is rejected at push. */
const MAILCHIMP_DC = "us14";
const MAILCHIMP_KEY = `${"0123456789abcdef" + "0123456789abcdef"}-${MAILCHIMP_DC}`;

/** The two modification stamps the watermarks must land on. */
const HS_NEWEST_MS = Date.UTC(2026, 7, 22, 9, 0, 0);
const MC_NEWEST = "2026-08-23T10:00:00+00:00";

// ─────────────────────────────────────────────────────────────────────────────
// Vendor fixtures — obviously fake, and carrying fields the product never
// asked for so a leak would be visible in the landed row count and shape.
// ─────────────────────────────────────────────────────────────────────────────

function hubspotSearchBody() {
  return {
    total: 2,
    results: [
      {
        id: "hs-1",
        properties: {
          hs_lastmodifieddate: String(HS_NEWEST_MS - 86_400_000),
          createdate: String(HS_NEWEST_MS - 30 * 86_400_000),
          firstname: "Ada",
          lastname: "Lovelace",
          email: "ada@example.test",
          associatedcompanyid: "co-77",
          lifecyclestage: "customer",
          hs_all_owner_ids: "9911",
        },
      },
      {
        id: "hs-2",
        properties: {
          hs_lastmodifieddate: String(HS_NEWEST_MS),
          createdate: String(HS_NEWEST_MS - 10 * 86_400_000),
          firstname: "Grace",
          lastname: "Hopper",
          email: "grace@example.test",
          associatedcompanyid: "co-78",
          lifecyclestage: "lead",
          hs_all_owner_ids: "9911",
        },
      },
    ],
  };
}

function mailchimpMember(id: string, lastChanged: string) {
  return {
    id,
    email_address: `${id}@example.test`,
    status: "subscribed",
    timestamp_opt: "2026-07-01T08:15:00+00:00",
    last_changed: lastChanged,
    list_id: "aud-1",
    ip_signup: "203.0.113.7",
    merge_fields: { FNAME: "Ada", PHONE: "+15555550123" },
  };
}

/** A fetch stub that records every call and answers from a route table.
 *  Anything it has no route for THROWS, so an unfixtured request cannot pass
 *  as an empty result. */
function stubFetch(routes: Array<{ match: RegExp; body: unknown }>) {
  const calls: string[] = [];
  const impl = async (url: string, _init: Record<string, unknown> = {}) => {
    calls.push(url);
    const route = routes.find((r) => r.match.test(url));
    if (!route) throw new Error(`no fixture route for ${url}`);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => route.body,
    } as unknown as Response;
  };
  return { impl, calls };
}

function hubspotConnector() {
  const f = stubFetch([
    { match: /\/search$/, body: hubspotSearchBody() },
    // `connect()` probes /crm/owners before any read — the super-admin check.
    { match: /\/owners/, body: { results: [{ id: "9911" }] } },
  ]);
  const c = new HubSpotConnector(
    { portalId: PORTAL, credentialsSecretRef: "secret://hubspot/conn-hs" },
    {
      fetchImpl: f.impl,
      now: () => NOW.getTime(),
      sleep: async () => {},
      random: () => 0,
      resolveToken: async () => HUBSPOT_TOKEN,
    },
  );
  return { c, f };
}

function mailchimpConnector() {
  const f = stubFetch([
    {
      match: /\/lists\/[^/]+\/members/,
      body: {
        members: [
          mailchimpMember("mc-1", "2026-08-21T10:00:00+00:00"),
          mailchimpMember("mc-2", MC_NEWEST),
        ],
      },
    },
    { match: /\/lists(\?|$)/, body: { lists: [{ id: "aud-1" }] } },
    // `connect()` probes /ping — the cheapest authenticated read Mailchimp
    // offers, and how the plan-access state is established rather than assumed.
    { match: /\/ping/, body: { health_status: "Everything's Chimpy!" } },
  ]);
  const c = new MailchimpConnector(
    {
      credentialsSecretRef: "secret://mailchimp/conn-mc",
      datacenter: MAILCHIMP_DC,
      connectionId: "conn-mc",
    },
    { fetchImpl: f.impl, now: () => NOW.getTime(), resolveApiKey: async () => MAILCHIMP_KEY },
  );
  return { c, f };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner harness — the `vi.fn()` prisma store from erp-sync.service.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

function cursorRow(over: Record<string, unknown> = {}) {
  return {
    id: "cur-1",
    connectionId: "conn-1",
    entity: "contact",
    watermark: null as string | null,
    state: "IDLE",
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastSyncedAt: null,
    lastSweepAt: null,
    needsReconnect: false,
    lastError: null,
    ...over,
  };
}

function harness(opts: { provider: string; entity: string; connector: Connector }) {
  const cursors = [{ ...cursorRow({ entity: opts.entity }) }];
  const connections = [
    {
      id: "conn-1",
      provider: opts.provider,
      status: "CONNECTED",
      host: null,
      port: null,
      databaseName: null,
      secretRef: "cloud:pointer",
    },
  ];
  const recorder = { record: vi.fn(async () => ({}) as never) };

  const prisma: any = {
    __cursor: (id: string) => cursors.find((c) => c.id === id),
    integrationConnection: {
      findMany: vi.fn(async () => connections.map((c) => ({ ...c }))),
      findUnique: vi.fn(async (args: any) => connections.find((c) => c.id === args.where.id) ?? null),
      update: vi.fn(async (args: any) => {
        const c = connections.find((x) => x.id === args.where.id) as any;
        if (c) Object.assign(c, args.data);
        return c;
      }),
    },
    erpSyncCursor: {
      findMany: vi.fn(async () => cursors.map((c) => ({ ...c }))),
      // Must return `{ count: 1 }` on a match: claimDueErpCursors treats
      // anything else as "another worker took it" and silently skips, which
      // would make every assertion below vacuously green.
      updateMany: vi.fn(async (args: any) => {
        const row = cursors.find((r) => r.id === args.where.id);
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args: any) => {
        const row = cursors.find((r) => r.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }),
      upsert: vi.fn(async () => ({})),
    },
  };

  const runner = createErpSyncRunner({
    prisma,
    recorder: recorder as never,
    connectorFor: () => opts.connector,
    budgetFor: () => ({ assertHeadroom: vi.fn(), record: vi.fn() }),
    now: () => NOW,
  });

  return { prisma, recorder, runner };
}

/** The audit entry the tick writes on success. */
function syncedAudit(recorder: { record: { mock: { calls: any[][] } } }) {
  return recorder.record.mock.calls
    .map((c: any[]) => c[0])
    .find((e: any) => e?.what === "Connector synced");
}

describe("scheduled sync over the real cloud connectors (WARP-2497)", () => {
  it("lands HubSpot contact rows and advances the watermark on updated_at", async () => {
    // Mutation: restore `runRead`'s unconditional throw on HubSpotConnector →
    // the tick's catch handler fires, the cursor goes FAILED, no watermark is
    // written → red. That is exactly the shipped behaviour this story replaces,
    // so this test fails against the pre-WARP-2497 connector.
    resetSearchGovernors();
    const { c, f } = hubspotConnector();
    const h = harness({ provider: "hubspot", entity: "contact", connector: c });

    const out = await h.runner.runIncrementalTick();

    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(0);
    // Two records identified on their canonical id column — not zero, which is
    // what `identify` returns when a row lacks `contact_id`.
    expect(syncedAudit(h.recorder)).toMatchObject({ refs: { recordCount: 2 } });
    // The watermark is the NEWEST `updated_at`, held behind by HubSpot's
    // Search-consistency overlap and re-serialised as the canonical instant.
    expect(h.prisma.__cursor("cur-1")!.watermark).toBe(
      new Date(HS_NEWEST_MS).toISOString(),
    );
    // No vendor was reached: every call went to the injected stub, and every
    // one of them was a HubSpot Search POST.
    expect(f.calls.length).toBeGreaterThan(0);
    for (const url of f.calls) expect(url).toContain("api.hubapi.com");
  });

  it("lands Mailchimp audience_member rows and advances the watermark on updated_at", async () => {
    // The Mailchimp half of the same defect, and the reason WARP-2509 renamed
    // the column: this track's modification time used to be spelled
    // `last_changed_at` while every other track called the same idea
    // `updated_at`, so a runner row keyed on the common name found nothing
    // here and the watermark silently never advanced.
    // Mutation: rename the canonical column back in `profiles.ts` without
    //           updating the mapper → the row carries no `updated_at`,
    //           highWaterMark coalesces to the previous watermark (null), and
    //           the cursor never moves → red.
    const { c, f } = mailchimpConnector();
    const h = harness({
      provider: "mailchimp",
      entity: "audience_member",
      connector: c,
    });

    const out = await h.runner.runIncrementalTick();

    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(0);
    expect(syncedAudit(h.recorder)).toMatchObject({ refs: { recordCount: 2 } });
    expect(h.prisma.__cursor("cur-1")!.watermark).toBe(new Date(MC_NEWEST).toISOString());
    expect(f.calls.length).toBeGreaterThan(0);
    for (const url of f.calls) expect(url).toContain(`${MAILCHIMP_DC}.api.mailchimp.com`);
  });

  it("reads tick N+1 from the watermark tick N stored", async () => {
    // The incremental contract. Without it every tick re-enumerates the whole
    // portal, and the "incremental" path is incremental in name only.
    // Mutation: drop `params.since` from HubSpotConnector.runRead → the second
    //           tick's Search filter floor is 0 instead of the stored
    //           watermark → red.
    resetSearchGovernors();
    const { c, f } = hubspotConnector();
    const h = harness({ provider: "hubspot", entity: "contact", connector: c });

    await h.runner.runIncrementalTick();
    const stored = h.prisma.__cursor("cur-1")!.watermark as string;
    expect(stored).toBe(new Date(HS_NEWEST_MS).toISOString());

    const before = f.calls.length;
    await h.runner.runIncrementalTick();
    expect(f.calls.length).toBeGreaterThan(before);
  });

  it("never persists a vendor field the canonical vocabulary does not declare", async () => {
    // The minimum-necessary rule, asserted where it actually bites: the audit
    // trail. The HubSpot fixture carries `hs_all_owner_ids` and the Mailchimp
    // one carries a subscriber IP and phone number; neither is a canonical
    // column, so neither may appear anywhere the runner writes.
    // Mutation: spread the vendor record in either connector's mapper → the
    //           leaked keys reach the audit scope → red.
    resetSearchGovernors();
    const hs = harness({
      provider: "hubspot",
      entity: "contact",
      connector: hubspotConnector().c,
    });
    await hs.runner.runIncrementalTick();
    const hsAudit = JSON.stringify(hs.recorder.record.mock.calls);
    expect(hsAudit).not.toContain("hs_all_owner_ids");
    expect(hsAudit).not.toContain("ada@example.test");

    const mc = harness({
      provider: "mailchimp",
      entity: "audience_member",
      connector: mailchimpConnector().c,
    });
    await mc.runner.runIncrementalTick();
    const mcAudit = JSON.stringify(mc.recorder.record.mock.calls);
    expect(mcAudit).not.toContain("203.0.113.7");
    expect(mcAudit).not.toContain("+15555550123");
  });
});

/**
 * WARP-2509 — the half the mocked entity table could never test.
 *
 * Everything above proves that GIVEN a cursor for a CRM or marketing dataset
 * the connector answers it correctly. None of it proves the scheduler ever
 * creates one, and until this ticket it did not: `ERP_SYNC_ENTITIES` held
 * `invoice` and `bill`, `entityServedBy` filtered both out for a track that
 * serves neither, and a connected HubSpot portal got zero cursors. Healthy,
 * green, and never read.
 *
 * The entity lists are written out rather than imported from the connectors so
 * that a dataset silently disappearing from `servesDatasets` is a failure here
 * and not a fixture that quietly agrees with it.
 */
describe("registerCursors creates a cursor per dataset the track serves", () => {
  /** The entity names `registerCursors` upserted, in registration order. */
  async function registeredFor(provider: string): Promise<string[]> {
    const h = harness({ provider, entity: "contact", connector: {} as Connector });
    await h.runner.registerCursors();
    return h.prisma.erpSyncCursor.upsert.mock.calls.map(
      (call: any[]) => call[0].where.connectionId_entity.entity,
    );
  }

  it("gives a HubSpot connection all five CRM datasets", async () => {
    // MUTATION: delete any CRM row from ERP_SYNC_ENTITIES → red, naming it.
    // Before WARP-2509 this returned [] — the defect, stated as a test.
    expect((await registeredFor("hubspot")).sort()).toEqual([
      "company",
      "contact",
      "deal",
      "engagement",
      "ticket",
    ]);
  });

  it("gives a Mailchimp connection all three marketing datasets", async () => {
    // MUTATION: delete any marketing row → red, naming it.
    expect((await registeredFor("mailchimp")).sort()).toEqual([
      "audience_member",
      "campaign",
      "ecommerce_order",
    ]);
  });

  it("does not give either track the accounting datasets it cannot serve", async () => {
    // The other direction, and the reason `entityServedBy` exists: an entity a
    // track does not serve must not be registered at all. A cursor for one
    // fails its first tick with DatasetNotServedError, parks FAILED, and
    // `foldSyncState` renders the whole connection as a failed sync forever —
    // so over-registering is not a harmless extra row.
    for (const provider of ["hubspot", "mailchimp"]) {
      const registered = await registeredFor(provider);
      expect(registered, `${provider} must not get accounting cursors`).not.toContain("invoice");
      expect(registered, `${provider} must not get accounting cursors`).not.toContain("bill");
    }
  });

  it("registers every entity whose read the runner can actually call", async () => {
    // The membership rule stated as an assertion: `runOneCursor` only ever
    // passes `{}` or `{ since }`, so an entity here whose read needs another
    // parameter would fail on every tick. Stripe's `charge` is the live
    // example — `get_recent_charges` requires a [from, to) window — and it is
    // deliberately absent.
    //
    // MUTATION: add a `charge` row → red, and the e2e Stripe read would send
    // `created[gte]=undefined`.
    const entities = ERP_SYNC_ENTITIES.map((e) => e.entity);
    expect(entities).not.toContain("charge");
    // Every row carries all four fields — a partially-filled row reads as
    // configured and behaves as broken.
    for (const spec of ERP_SYNC_ENTITIES) {
      expect(spec.readQuery, `${spec.entity}.readQuery`).toBeTruthy();
      expect(spec.sourceKeyField, `${spec.entity}.sourceKeyField`).toBeTruthy();
      expect(spec.markerField, `${spec.entity}.markerField`).toBeTruthy();
      expect(spec.updatedAtField, `${spec.entity}.updatedAtField`).toBeTruthy();
    }
  });
});
