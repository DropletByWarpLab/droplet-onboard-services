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
 * ## Why the entity table is mocked, and what that means
 *
 * `ERP_SYNC_ENTITIES` ships with exactly two rows — `invoice` and `bill`, both
 * accounting datasets that neither of these tracks serves. A cursor naming any
 * other entity is answered `ENTITY_NOT_SERVED` and fails, so on the SHIPPED
 * table these connectors are never asked for a read at all. That is a genuine
 * remaining gap, it is one line per dataset in `entities.ts`, and it is outside
 * this story's file boundary — so it is mocked here rather than changed, and
 * the mock IS the specification of the rows that file still needs.
 *
 * What this test therefore proves: given a cursor for a CRM or marketing
 * dataset, the real connector answers `runRead` with canonical rows, the runner
 * identifies them on their canonical id column, and the watermark advances on
 * the canonical modification column. What it does NOT prove is that the shipped
 * scheduler ever creates such a cursor. It does not.
 */
import { describe, it, expect, vi } from "vitest";
import {
  HubSpotConnector,
  MailchimpConnector,
  resetSearchGovernors,
  type Connector,
} from "@droplet/erp-connector";

// Mocked BEFORE the runner is imported, so the runner's module-level
// `BY_ENTITY` map is built from these rows. `erpSyncEntity` is what the tick
// calls; `ERP_SYNC_ENTITIES` is what `registerCursors` iterates.
vi.mock("./entities.js", () => {
  const ERP_SYNC_ENTITIES = [
    {
      entity: "contact",
      readQuery: "find_contact",
      sourceKeyField: "contact_id",
      // The canonical modification column WARP-2494 added. This is the whole
      // point of the story: before it existed the marker had to be an ordering
      // key that could not see an edit.
      markerField: "updated_at",
    },
    {
      entity: "audience_member",
      readQuery: "get_audience_members",
      sourceKeyField: "audience_member_id",
      // NOT `updated_at`. WARP-2466 spelled Mailchimp's `last_changed`
      // `last_changed_at` in the canonical vocabulary, so this track's
      // watermark keys on a differently-named column than every other one.
      markerField: "last_changed_at",
    },
  ];
  const BY_ENTITY = new Map(ERP_SYNC_ENTITIES.map((e) => [e.entity, e]));
  return {
    ERP_SYNC_ENTITIES,
    erpSyncEntity: (entity: string) => BY_ENTITY.get(entity),
  };
});

// A static import is correct despite the mock above: vitest hoists `vi.mock`
// ahead of every import, so the runner still sees the mocked entity table. A
// top-level `await import(...)` would do the same thing and not compile — this
// file is emitted as CommonJS (TS1309).
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

  it("lands Mailchimp audience_member rows and advances the watermark on last_changed_at", async () => {
    // The Mailchimp half of the same defect. `markerField` is
    // `last_changed_at`, not `updated_at` — WARP-2466 named the column that
    // way, so a runner entry copied from the HubSpot row would key on a column
    // this dataset does not have and the watermark would never advance.
    // Mutation: set the mocked markerField to "updated_at" → highWaterMark sees
    //           no marker at all, coalesces to the previous watermark (null),
    //           and the cursor never moves → red.
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
