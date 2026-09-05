/**
 * WARP-2497 — the acceptance test, end to end.
 *
 * The ticket's first acceptance criterion is a single sentence with three
 * independent failure modes behind it:
 *
 *   "With a Stripe connection CONNECTED, the turn 'what did we bill last week'
 *    selects a tool that returns rows from the synced `charge` dataset;
 *    asserted end to end with injected fetch, no vendor reached."
 *
 * Each half was verifiable on its own before this file existed, and each half
 * passing proved nothing about the story:
 *
 *   • SELECTION could be green while the tool was registered in a domain the
 *     chat pool excludes — the state `erp` was in, and the reason this ticket
 *     exists at all. A selection unit test with a hand-built pool cannot see
 *     that; this one uses the REAL chat pool.
 *   • The READ could be green while no rule ever advertised the tool, which is
 *     the same defect one layer down: `STRIPE_DATASETS` served `charge`, the
 *     read query existed, and the assistant still could not reach either.
 *
 * So the two are asserted in ONE test, in order, against one another's real
 * artefacts. `no vendor reached` is asserted positively rather than assumed:
 * the connector is built with an injected `fetchImpl`, every call it makes is
 * recorded, and the assertions are about the CALLS — the house pattern from
 * `quickbooks-online.test.ts`, because "the budget guard and the capability
 * check are both promises about requests that must NOT happen".
 */

// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.

import { describe, it, expect, vi } from "vitest";
import { StripeConnector, STRIPE_PROVIDER } from "@droplet/erp-connector";
import { TOOLS, CLOUD_QUERY_DATASETS } from "@droplet/tools-core";
import { createErpService, CLOUD_DATASET_READS } from "./erp.service.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import { selectAdvertisedTools } from "./tool-selection.service.js";

const OWNER = { id: "user-owner", role: "owner" as const };
const TOOL = "cloud_query_dataset";

/** August 2026, the "last week" the assertions below are written against. */
const FROM = "2026-08-17T00:00:00Z";
const TO = "2026-08-24T00:00:00Z";

/**
 * A Stripe restricted key, composed at runtime from parts.
 *
 * NEVER as one literal: GitHub's push protection is a SECOND secret gate that
 * repo config cannot allowlist, it has a Stripe detector, and a realistic
 * contiguous key shape in a test fixture is rejected at `git push` even with
 * gitleaks clean (WARP-2379 learned this the hard way).
 */
const KEY = ["rk", "test", "EXAMPLEFIXTURENOTAREALKEY"].join("_");

/** The `/v1/charges` page a merchant's account would return for that window. */
const CHARGE_PAGE = {
  has_more: false,
  data: [
    {
      id: "ch_2",
      created: Math.floor(Date.UTC(2026, 7, 21) / 1000),
      customer: "cus_9",
      amount: 12_500,
      amount_refunded: 0,
      currency: "usd",
      status: "succeeded",
    },
    {
      id: "ch_1",
      created: Math.floor(Date.UTC(2026, 7, 18) / 1000),
      customer: "cus_4",
      amount: 4_000,
      amount_refunded: 1_000,
      currency: "usd",
      status: "succeeded",
    },
  ],
};

/** Records every request the connector makes and answers it from a fixture.
 *  Injected, never a global patch: a globally-patched fetch would still be
 *  green if some other code path reached the network. */
function stubFetch() {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const body = url.includes("/v1/charges") ? CHARGE_PAGE : { data: [] };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  };
  return { impl, calls };
}

function serviceWithConnectedStripe() {
  const fetch = stubFetch();
  const row = {
    id: "conn-stripe-1",
    provider: STRIPE_PROVIDER,
    status: "CONNECTED",
    host: null,
    port: null,
    databaseName: null,
    secretRef: "secret://stripe/acct_1Fixture",
    writeEnabled: false,
    providerConfig: null,
    providerTokensEnc: null,
  };
  const auditLog: Array<Record<string, unknown>> = [];
  const prisma = {
    integrationConnection: {
      // The service asks for a CONNECTED row among the providers whose
      // descriptor serves the dataset, then falls back to any row. Both
      // shapes resolve to this one Stripe row.
      findFirst: vi.fn(async () => ({ ...row })),
    },
    erpAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditLog.push(data);
        return { id: `a-${auditLog.length}`, ...data };
      }),
    },
  };
  const svc = createErpService(prisma as never, {
    // The REAL connector, with only its transport replaced.
    connectorFor: () =>
      new StripeConnector(
        { credentialsSecretRef: row.secretRef },
        { fetchImpl: fetch.impl, resolveApiKey: async () => KEY },
      ),
  });
  return { svc, fetch, auditLog };
}

describe("WARP-2497 — 'what did we bill last week', end to end", () => {
  it("selects the cloud reader from the REAL chat pool and returns charge rows, without reaching Stripe", async () => {
    // ── 1. SELECTION, against the shipping pool ──────────────────────────
    //
    // Mutation: delete the `domains: ["cloud"]` rule from
    // tool-selection.service.ts, OR add "cloud_query_dataset" to
    // EXCLUDED_FROM_CHAT_TOOLS → red here. Those are the two independent ways
    // this tool could ship registered-but-unreachable, and both are covered
    // because the pool is derived, not hand-written.
    const chatPool = Array.from(TOOLS.keys()).filter((n) => !EXCLUDED_FROM_CHAT_TOOLS.has(n));
    expect(chatPool, "the tool must be in chat scope at all").toContain(TOOL);

    const { advertised, matchedDomains } = selectAdvertisedTools({
      mode: "domains",
      userMessage: "what did we bill last week",
      pool: chatPool,
      // EMPTY — continuity must not be what carries this. A fresh turn is the
      // case the ticket is about.
      conversationToolNames: [],
    });
    expect(matchedDomains).toContain("cloud");
    expect(advertised).toContain(TOOL);

    // ── 2. EXECUTION, through the real connector on an injected fetch ────
    //
    // Mutation: drop "charge" from STRIPE_DATASETS → red with
    // DATASET_NOT_SERVED. Mutation: remove the `get_recent_charges` case from
    // StripeConnector.runRead → red (`read is not served`).
    const { svc, fetch, auditLog } = serviceWithConnectedStripe();
    const res = await svc.queryDataset({ dataset: "charge", params: { from: FROM, to: TO } }, OWNER);

    expect(res.connected).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.provider).toBe(STRIPE_PROVIDER);
    // Newest first, mapped onto the canonical `charge` columns, minor units
    // converted. Mutation: drop the majorUnits() call → red (12500 vs 125).
    expect(res.rows).toEqual([
      {
        charge_id: "ch_2",
        created_at: "2026-08-21T00:00:00.000Z",
        customer_id: "cus_9",
        amount: 125,
        amount_refunded: 0,
        currency: "usd",
        status: "succeeded",
      },
      {
        charge_id: "ch_1",
        created_at: "2026-08-18T00:00:00.000Z",
        customer_id: "cus_4",
        amount: 40,
        amount_refunded: 10,
        currency: "usd",
        status: "succeeded",
      },
    ]);

    // ── 3. NO VENDOR REACHED ─────────────────────────────────────────────
    //
    // Asserted on the CALLS, not on the result: a test that only checked the
    // rows would pass just as happily if the connector had also dialled out.
    // Every URL must be one the injected impl answered, and every one must be
    // Stripe's registered host — never a redirect target or a second origin.
    expect(fetch.calls.length).toBeGreaterThan(0);
    for (const url of fetch.calls) {
      expect(new URL(url).hostname).toBe("api.stripe.com");
    }
    expect(fetch.calls.some((u) => u.includes("/v1/charges"))).toBe(true);
    // The window went to Stripe rather than being applied after paging.
    // Mutation: delete the `created[gte]`/`created[lt]` entries → red.
    const charges = new URL(fetch.calls.find((u) => u.includes("/v1/charges"))!);
    expect(charges.searchParams.get("created[gte]")).toBe(
      String(Math.floor(Date.parse(FROM) / 1000)),
    );

    // ── 4. The audit row proves the access without copying the data ──────
    //
    // Mutation: audit `params` instead of `Object.keys(params)` → red.
    const audit = auditLog.at(-1)!;
    expect(audit.action).toBe("read:dataset:charge");
    expect(audit.actor).toBe(OWNER.id);
    expect((audit.scope as { paramKeys: string[] }).paramKeys).toEqual(["from", "to"]);
    expect(JSON.stringify(audit.scope)).not.toContain("cus_9");
  });

  it("keeps the tool's dataset enum and the service's read table in agreement", () => {
    // The cross-package drift gate. `@droplet/tools-core` cannot import
    // `@droplet/erp-connector` (it is server-only surface that must not reach
    // the dashboard bundle), so the tool's enum is a MIRROR of
    // CLOUD_DATASET_READS' keys rather than a derivation. A mirror that
    // nothing checks is two vocabularies waiting to split: a dataset added to
    // the enum but not the table 400s at runtime, and one added to the table
    // but not the enum is unreachable — the exact bug this ticket fixed.
    //
    // Mutation: add a key to CLOUD_DATASET_READS (or a value to the tool's
    // enum) without the other → red.
    expect([...CLOUD_QUERY_DATASETS].sort()).toEqual(Object.keys(CLOUD_DATASET_READS).sort());
  });

  it("refuses a dataset outside the enum instead of answering it empty", async () => {
    // `refund` is real vocabulary with a real read query, and no shipped cloud
    // track serves it. Answering "no refunds" would be a confident false
    // statement about money; the honest answer is that the question cannot be
    // asked yet.
    // Mutation: make queryDataset fall through to runReadOrBlocked on an
    // unknown dataset → red (it would resolve to a NOT_CONFIGURED empty).
    const { svc, fetch } = serviceWithConnectedStripe();
    await expect(svc.queryDataset({ dataset: "refund", params: {} }, OWNER)).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses a non-admin caller before any connection is resolved", async () => {
    // Business records are admin-tier. Mutation: widen
    // CLOUD_DATASET_READ_ROLES to include "family" → red.
    const { svc, fetch } = serviceWithConnectedStripe();
    await expect(
      svc.queryDataset({ dataset: "charge", params: {} }, { id: "u-2", role: "family" }),
    ).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });
});
