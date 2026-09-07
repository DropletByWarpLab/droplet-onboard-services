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
import {
  StripeConnector,
  STRIPE_PROVIDER,
  RestProfileConnector,
  restProfileFor,
  SQUARE_PROVIDER,
} from "@droplet/erp-connector";
import { TOOLS, CLOUD_QUERY_DATASETS } from "@droplet/tools-core";
import { createErpService, CLOUD_DATASET_READS } from "./erp.service.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import { selectAdvertisedTools } from "./tool-selection.service.js";
import { providerDescriptors } from "@droplet/shared-types";

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

/** One Square `PaymentRefund`, shaped as ListPaymentRefunds documents it. */
const SQUARE_REFUND_PAGE = {
  refunds: [
    {
      id: "rf_1",
      created_at: "2026-08-19T09:00:00Z",
      updated_at: "2026-08-20T09:30:00Z",
      payment_id: "pay_7",
      amount_money: { amount: 2_500, currency: "USD" },
      status: "COMPLETED",
      reason: "Customer returned item",
    },
  ],
};

/** The REAL Square profile through the REAL REST connector, transport stubbed. */
function serviceWithConnectedSquare() {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const body = url.includes("/v2/refunds") ? SQUARE_REFUND_PAGE : { refunds: [] };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null } as unknown as Headers,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  };
  const row = {
    id: "conn-square-1",
    provider: SQUARE_PROVIDER,
    status: "CONNECTED",
    host: null,
    port: null,
    databaseName: null,
    secretRef: null,
    writeEnabled: false,
    providerConfig: null,
    providerTokensEnc: null,
  };
  const prisma = {
    integrationConnection: { findFirst: vi.fn(async () => ({ ...row })) },
    erpAuditLog: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
  };
  const svc = createErpService(prisma as never, {
    connectorFor: () =>
      new RestProfileConnector(
        restProfileFor(SQUARE_PROVIDER)!,
        { provider: SQUARE_PROVIDER },
        { fetchImpl: impl as never, resolveCredentials: async () => ({ accessToken: "t" }) },
      ),
  });
  return { svc, calls };
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

  it("🔴 every cloud and rest provider has at least one dataset the model can ask about", () => {
    // WARP-2832. The gate that was missing, and the omission it would have
    // caught is a real one: Cal.com shipped on WARP-2707 serving `appointment`
    // alone — a name in NEITHER `CLOUD_DATASET_READS` nor `CLOUD_QUERY_DATASETS`
    // — so a customer could connect it, watch the card go green, and never
    // reach a single booking from any surface on the box.
    //
    // Nothing went red, and the assertion above is why: it gates the two lists
    // against EACH OTHER, and they agreed perfectly while both lagged the
    // vocabulary. Neither is typed `DatasetName`, so they can lag it forever,
    // in lockstep, with every test green.
    //
    // Mutation: drop `booking` from CLOUD_DATASET_READS → red, naming calcom.
    const askable = new Set(Object.keys(CLOUD_DATASET_READS));
    const dark = providerDescriptors()
      .filter((d) => d.track === "cloud" || d.track === "rest")
      .filter((d) => d.catalog?.availability === "available")
      .filter((d) => !d.datasets.some((name) => askable.has(name)))
      .map((d) => d.id);
    expect(dark, "these providers ship an available card the assistant cannot query").toEqual([]);
  });

  it("🔴 EVERY dataset an available provider declares can be asked for", () => {
    // WARP-2833. The assertion above was deliberately weak — "at least one
    // askable dataset per provider" — and its own comment recorded why:
    // "Deliberately NOT 'every declared dataset is reachable' — that is false
    // today and knowingly so". It was true when written, for Stripe, whose
    // `refund`/`payout`/`balance_transaction`/`subscription` have no connector
    // behind them.
    //
    // 🔴 It stopped being a defensible weakening the moment a provider shipped
    // that DOES serve those datasets, and nothing noticed, because a per-
    // provider "≥1" gate passes on one wired dataset out of three. What it let
    // through, all of it fully built on both sides and reachable from nowhere:
    //
    //   audience  Brevo + Klaviyo — canonical projection, delta clause, and
    //             `get_audiences` in read-queries.ts. TWO available cards.
    //   refund    Square — a real `updated_at` filter, and the dataset whose
    //   payout    status moves AFTER creation, so it is the one a poll must see.
    //
    // The weaker gate is kept above rather than replaced: it names the failing
    // PROVIDER, which is the sentence an owner cares about ("Cal.com does
    // nothing"), while this one names the failing DATASET. A regression that
    // strands one dataset of three trips only this test; one that strands a
    // whole connector trips both, and the pair reads as a diagnosis.
    //
    // Mutation: drop `refund` from CLOUD_DATASET_READS → red, naming square/refund.
    const askable = new Set(Object.keys(CLOUD_DATASET_READS));
    const unreachable = providerDescriptors()
      .filter((d) => d.track === "cloud" || d.track === "rest")
      .filter((d) => d.catalog?.availability === "available")
      .flatMap((d) => d.datasets.filter((name) => !askable.has(name)).map((name) => `${d.id}/${name}`));
    expect(
      [...new Set(unreachable)].sort(),
      "a shipped connector produces these rows and no surface on the box can ask for them",
    ).toEqual([]);
  });

  it("refuses a dataset outside the enum instead of answering it empty", async () => {
    // `balance_transaction` is real vocabulary with a real read query
    // (`get_processing_fees`) and no available provider declares it.
    // Answering "no processing fees" would be a confident false statement
    // about money; the honest answer is that the question cannot be asked yet.
    //
    // 🔴 This case was `refund` until WARP-2833, and the swap is the finding
    // rather than a fixture detail. The original comment read "no shipped
    // cloud track serves it" — TRUE of a Stripe-only product, and falsified in
    // this same repo the day Square shipped serving `refund` and `payout`.
    // Nothing went red, because a test whose premise dies keeps passing: it
    // went on proving that an unwired dataset is refused, while the reason it
    // was unwired had evaporated. When this fixture next needs swapping,
    // that is the signal to wire the dataset, not to find another unwired one.
    //
    // Mutation: make queryDataset fall through to runReadOrBlocked on an
    // unknown dataset → red (it would resolve to a NOT_CONFIGURED empty).
    const { svc, fetch } = serviceWithConnectedStripe();
    await expect(
      svc.queryDataset({ dataset: "balance_transaction", params: {} }, OWNER),
    ).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it("🔴 WARP-2833 — a connected Square answers a refund question, from Square", async () => {
    // The list-agreement tests above prove the vocabulary lines up. This one
    // proves the wiring carries a request all the way to the vendor and a
    // canonical row all the way back, which is the claim that actually failed
    // before this ticket: `refund` was in the vocabulary, had a read query,
    // had a connector that served it, and resolved to NOTHING because two
    // orchestrator-side lists had never heard of it.
    //
    // Asserted on the CALLS, not just the rows — the house pattern. A test
    // that only checks the returned array is green against a connector that
    // fabricates one.
    //
    // Mutation: remove `refund` from CLOUD_DATASET_READS → `queryDataset`
    // throws `unknown dataset "refund"` and this goes red before any fetch.
    const { svc, calls } = serviceWithConnectedSquare();

    const res = await svc.queryDataset({ dataset: "refund", params: {} }, OWNER);

    // The dataset picked the provider — no vendor argument exists anywhere in
    // the tool, the route or the service.
    expect(res.provider).toBe(SQUARE_PROVIDER);
    expect(res.connected).toBe(true);
    expect(calls.some((u) => u.includes("/v2/refunds"))).toBe(true);
    // Square's host, and only Square's. Mutation: point the profile's baseUrl
    // elsewhere → red here as well as in square-profile.test.ts.
    for (const url of calls) expect(new URL(url).hostname).toBe("connect.squareup.com");

    // The canonical projection, including the minor-units conversion the
    // profile declares: 2500 USD cents → 25. A refund that reports 2500 is
    // the money bug this column's `transform` exists to prevent.
    expect(res.rows).toEqual([
      {
        refund_id: "rf_1",
        // Canonicalised to a full ISO instant by the track, not passed through.
        created_at: "2026-08-19T09:00:00.000Z",
        charge_id: "pay_7",
        amount: 25,
        currency: "USD",
        status: "COMPLETED",
        reason: "Customer returned item",
        updated_at: "2026-08-20T09:30:00.000Z",
      },
    ]);
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
