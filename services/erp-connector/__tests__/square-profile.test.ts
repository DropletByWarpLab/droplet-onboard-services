/**
 * WARP-2707 / ADR-046 — Square's VENDOR FACTS, pinned against Square's own
 * documentation.
 *
 * ## Why this file is mandatory rather than nice to have
 *
 * ADR-046's Consequences section names the class of failure the declarative
 * track buys with its leverage: *"A declarative profile is easier to get wrong
 * quietly than code is. A wrong watermark parameter is one string. Mitigation:
 * the parameter names are pinned by tests that cite the vendor page, exactly as
 * `graph-resources.test.ts` does for Microsoft Graph."* This is that file for
 * Square, and `rest-track.test.ts` cannot stand in for it: that suite proves the
 * connector does what a profile SAYS, which is exactly the question that stays
 * green when the profile says the wrong thing.
 *
 * The failure mode is the Graph one, verbatim. Square does not reject an
 * unrecognised query parameter — `GET /v2/payments` answers 200 and returns the
 * seller's whole payment history — so a mistyped `updated_at_begin_time` is a
 * full scan on every tick, reported as an incremental read, on every seller at
 * once. And `RestProfileConnector.introspect()` cannot see it: its fingerprint
 * hashes the DATASETS and their canonical columns, not the paths or the
 * parameter spellings (its own docstring says so). Only this file can.
 *
 * ## The pages every claim below was checked against (2026-09-07)
 *
 *  • ListPayments        https://developer.squareup.com/reference/square/payments-api/list-payments
 *  • ListPaymentRefunds  https://developer.squareup.com/reference/square/refunds-api/list-payment-refunds
 *  • ListPayouts         https://developer.squareup.com/reference/square/payouts-api/list-payouts
 *  • ListLocations       https://developer.squareup.com/reference/square/locations-api/list-locations
 *  • Versioning          https://developer.squareup.com/docs/build-basics/versioning-overview
 *
 * ## The rule every test here obeys
 *
 * 🔴 **Facts are asserted from the OUTGOING REQUEST, not from the profile
 * object.** Reading `SQUARE_PROFILE.datasets[0].path` back out and comparing it
 * to a string proves the file contains what the file contains. These tests run
 * the REAL profile through a REAL `RestProfileConnector` with an injected
 * fetch, and assert on the URL and headers that actually left — so a connector
 * that drops the version header, forgets the watermark, or pages on the wrong
 * parameter goes red here even though the profile is untouched.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import { providerDescriptor } from "@droplet/shared-types";

import { RestProfileConnector, UnsafeBaseUrlError } from "../src/rest/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { authPlaceholders } from "../src/rest/profile.js";
import { restProfileFor } from "../src/rest/profiles.js";
import {
  SQUARE_API_ORIGIN,
  SQUARE_API_VERSION,
  SQUARE_PROFILE,
  SQUARE_PROVIDER,
} from "../src/rest/vendors/square.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A recording fetch stub — the same shape `rest-track.test.ts` uses, and
 * duplicated rather than imported ON PURPOSE: importing it from that file would
 * execute that file's whole suite as a side effect of loading this one, and a
 * suite that runs another suite reports failures against the wrong file.
 *
 * Every test asserts on `calls`, not only on what the connector returned.
 */
function stubFetch(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const page = pages[Math.min(n, pages.length - 1)]!;
    n += 1;
    const status = page.status ?? 200;
    const headers = page.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } as unknown as Headers,
      json: async () => page.body,
      text: async () => JSON.stringify(page.body),
    } as unknown as Response;
  };
  return { impl: impl as never, calls };
}

/** A production access token's stand-in. Never shape-validated — see the descriptor. */
const ACCESS_TOKEN = "test-access-token";

/** The REAL profile, through the REAL connector. Nothing here is a fixture profile. */
function connectorWith(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const { impl, calls } = stubFetch(pages);
  const connector = new RestProfileConnector(
    SQUARE_PROFILE,
    { provider: SQUARE_PROVIDER },
    { fetchImpl: impl, resolveCredentials: async () => ({ accessToken: ACCESS_TOKEN }) },
  );
  return { connector, calls };
}

/** The watermark instant every read below passes, and what it must appear as. */
const SINCE = "2026-09-01T00:00:00Z";
const SINCE_ISO = "2026-09-01T00:00:00.000Z";

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const rowsOf = (rows: unknown[]) => rows as Record<string, unknown>[];

/** One Square `Payment`, shaped as ListPayments documents it. */
const PAYMENT = {
  id: "pay_1",
  created_at: "2026-09-02T10:00:00Z",
  updated_at: "2026-09-03T11:00:00Z",
  customer_id: "cust_1",
  amount_money: { amount: 1250, currency: "USD" },
  // NOTE: no `currency` of its own. The profile reads the currency for BOTH
  // money columns from `amount_money`, and the projection test pins that.
  refunded_money: { amount: 250 },
  status: "COMPLETED",
};

// ── identity, custody and the descriptor ────────────────────────────────────

describe("Square — the profile the track actually dispatches", () => {
  it("is the profile restProfileFor('square') returns, not a copy", () => {
    // Mutation: register a second Square profile in `profiles.ts` and this whole
    // file starts testing a file nothing ships.
    expect(restProfileFor(SQUARE_PROVIDER)).toBe(SQUARE_PROFILE);
  });

  it("dials ONE STATIC HOST, and it is the host the descriptor registers for egress", () => {
    // 🔴 The drift that matters: `egressHosts` is what `check-egress-allowlist.py`
    // and `allowed-egress.yaml` agree on, and the origin below is what the box
    // actually dials. Nothing else compares the two. Square has no region code,
    // no seller subdomain and no self-hosted option, so this is a `kind: egress`
    // entry the static scanner can read — a `kind: dynamic` guard is deliberately
    // NOT in play here.
    // Mutation: point the profile at `connect.squareupsandbox.com` -> red.
    expect(SQUARE_PROFILE.baseUrl).toEqual({ kind: "static", origin: SQUARE_API_ORIGIN });
    expect(SQUARE_API_ORIGIN).toBe("https://connect.squareup.com");
    expect(providerDescriptor(SQUARE_PROVIDER)!.egressHosts).toEqual(["connect.squareup.com"]);
  });

  it("🔴 serves EXACTLY the datasets the descriptor advertises", () => {
    // The descriptor is what the hub, the scheduler (`entityServedBy`) and the
    // dashboard read; the profile is what the connector reads. A drift between
    // them is the class of bug the descriptor exists to prevent: a hub tile
    // offering `invoice` on a connection that raises DatasetNotServedError the
    // first time the model asks for one.
    // Compared as SETS: ordering carries no meaning in either place (hub order is
    // `catalog.order`), membership carries all of it.
    const served = SQUARE_PROFILE.datasets.map((d) => d.dataset);
    expect([...served].sort()).toEqual([...providerDescriptor(SQUARE_PROVIDER)!.datasets].sort());
    expect([...served].sort()).toEqual(["charge", "payout", "refund"]);
  });

  it("🔴 serves ONLY the money story — the other five Square datasets stay absent", () => {
    // Square's catalog reaches eight canonical datasets. Each omission below is a
    // decision with a reason recorded in `vendors/square.ts`, and this test is
    // what makes adding one a deliberate act rather than a one-line append:
    //   order       — listing is POST /v2/orders/search with the watermark inside
    //                 a JSON request body; this track issues GETs.
    //   invoice     — GET /v2/invoices REQUIRES a location_id (a fan-out a profile
    //                 cannot express) and the Invoice object has no total field,
    //                 so canonical `amount` is unreachable in principle.
    //   product     — four of nine columns need three other mechanisms, including
    //                 a POST inventory batch-retrieve and an ITEM_VARIATION join.
    //   customer    — GET /v2/customers has NO time filter of any kind, so every
    //                 sync would be a full scan of the seller's customer book.
    //   appointment — the canonical vocabulary is the dental one (patient_id,
    //                 operatory_id). A Square customer is not a patient. That is
    //                 Romain's vocabulary call, not a mapping detail.
    // Mutation: append any of these to `datasets` without answering its question
    // -> red here AND red on the descriptor comparison above.
    const served = new Set<string>(SQUARE_PROFILE.datasets.map((d) => d.dataset));
    for (const absent of ["order", "invoice", "product", "customer", "appointment"]) {
      expect(served.has(absent), `${absent} must stay unserved until its blocker is answered`).toBe(false);
      expect(providerDescriptor(SQUARE_PROVIDER)!.datasets).not.toContain(absent);
    }
    expect(served.size).toBe(3);
  });

  it("🔴 declares NO credential-field pattern, and the absence is the point", () => {
    // The `EAAA` prefix and the ~64-character length are repeated all over the
    // internet and appear on NO Square documentation page — the corroboration is
    // a forum thread and an OAuth sample. A regex anchored on an undocumented
    // shape is a FALSE REJECTION that blocks a paying seller at the paste box,
    // for zero security gain: the only thing that proves a token is Square
    // answering `GET /v2/locations` with it, which `connect()` already does.
    // Mutation: add `pattern: "^EAAA"` from a blog post -> red.
    const fields = providerDescriptor(SQUARE_PROVIDER)!.credentialFields;
    expect(fields.map((f) => f.name)).toEqual(["accessToken"]);
    for (const field of fields) expect(field.pattern).toBeUndefined();
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.required).toBe(true);
  });

  it("names its credential placeholder EXACTLY as the descriptor names the field", () => {
    // These two are wired together at runtime by nothing but this string: the
    // orchestrator stores the field under the descriptor's name, the connector
    // looks it up by the template's placeholder. Rename either alone and every
    // Square connection refuses with "the stored credential has no accessToken"
    // — at first read, on a schedule, where nobody is watching.
    expect(authPlaceholders(SQUARE_PROFILE.auth)).toEqual(["accessToken"]);
    expect(providerDescriptor(SQUARE_PROVIDER)!.credentialFields.map((f) => f.name)).toEqual(
      authPlaceholders(SQUARE_PROFILE.auth),
    );
  });

  it("declares NO rate ceiling, in the profile and in the descriptor alike", () => {
    // Square publishes no ceiling AND no rate-limit response headers; its
    // documented behaviour is to answer RATE_LIMITED when it decides to. A number
    // here would be a policy wearing a fact's clothes — the same reasoning that
    // leaves Dentrix Ascend without one. The connector reacts to the 429 it is
    // given instead.
    // Mutation: invent `minRequestIntervalMs: 500` -> red, and a reviewer is
    // asked where the number came from.
    expect(SQUARE_PROFILE.minRequestIntervalMs).toBeUndefined();
    expect(providerDescriptor(SQUARE_PROVIDER)!.rateLimit).toBeUndefined();
  });
});

// ── the headers that actually leave the box ─────────────────────────────────

describe("Square — auth and the version header, read off the wire", () => {
  it("sends Authorization: Bearer <token> — the literal name and the literal template", async () => {
    const { connector, calls } = connectorWith([{ body: { payments: [] } }]);
    await connector.runRead("get_recent_charges", { since: SINCE });

    // The template, and then the value it produced. Square is one of the few
    // vendors on ADR-046 §2's six-shape table where the naive guess is right —
    // Linear takes the token with NO scheme, Zoho needs `Zoho-oauthtoken`, and
    // both 401 on `Bearer`. Pinned here so "they're all Bearer" never becomes a
    // shared default.
    expect(SQUARE_PROFILE.auth).toEqual({
      headerName: "Authorization",
      valueTemplate: "Bearer {{accessToken}}",
    });
    expect(headersOf(calls[0]!.init).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("🔴 sends Square-Version on EVERY request, pinned to a dated version", async () => {
    // Omitting it does NOT 400. Square serves the seller's APPLICATION default
    // version — whatever was current when they created the application — so an
    // unversioned request returns a shape this profile was not written against,
    // silently, and DIFFERENTLY PER SELLER. That is unreproducible by
    // construction: it works on the developer's account and not on a customer's.
    // Mutation: drop `constantHeaders`, or move the header into one dataset's
    // `query` -> red on both calls below.
    const { connector, calls } = connectorWith([{ body: { payments: [] } }]);
    await connector.connect();
    await connector.runRead("get_recent_charges", { since: SINCE });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(headersOf(call.init)["Square-Version"]).toBe(SQUARE_API_VERSION);
    }
    // The value is a real Square release (2026-08-19), and the scheme is Square's
    // own YYYY-MM-DD. Shape-pinned so a bare "2" or a semver-looking string
    // cannot be dropped in without a second look.
    expect(SQUARE_API_VERSION).toBe("2026-08-19");
    expect(SQUARE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SQUARE_PROFILE.constantHeaders).toEqual({ "Square-Version": SQUARE_API_VERSION });
  });

  it("probes GET /v2/locations on BOTH connect() and health()", async () => {
    // 🔴 Resolving the credential locally is not a connection: a revoked token
    // resolves perfectly and fails on the first scheduled read, hours later.
    // `/v2/locations` is Square's cheapest authenticated read — no parameters,
    // NOT paginated, a handful of rows for any seller — so a 401 on it is
    // unambiguous evidence about the TOKEN rather than about one product's
    // permissions.
    // Mutation: point probePath at `/v2/payments` and a seller with no payments
    // still "connects", while every health check pages the seller's money.
    const { connector, calls } = connectorWith([{ body: { locations: [] } }]);
    await connector.connect();
    await connector.health();

    expect(SQUARE_PROFILE.probePath).toBe("/v2/locations");
    expect(calls.map((c) => c.url)).toEqual([
      "https://connect.squareup.com/v2/locations",
      "https://connect.squareup.com/v2/locations",
    ]);
    // Neither probe carries a watermark or a paging parameter: this endpoint
    // documents none, and sending one would be inventing a contract.
    for (const call of calls) expect(new URL(call.url).search).toBe("");
  });

  it("sends NO limit parameter, though Square's own default is the page size we assume", async () => {
    // Square: the default value of 100 "is also the maximum allowed value. If the
    // provided value is greater than 100, it is ignored". So a `limit` here would
    // buy nothing on these three endpoints — and `GET /v2/catalog/list`, which a
    // future dataset would use, accepts no `limit` at all, so making it a habit
    // sends a parameter that endpoint does not document.
    //
    // Asserted from the OUTGOING REQUEST only. This test used to close with
    // `expect(SQUARE_PAGE_SIZE).toBe(100)` — a module constant compared to its
    // own definition, which no change to this connector or this profile can
    // make fail, over a constant the profile never read. It is gone; the fact
    // lives in the comment on the paging rules in `vendors/square.ts`.
    // Mutation: add `limit` to any dataset's `query` -> red.
    const { connector, calls } = connectorWith([{ body: { payments: [] } }]);
    await connector.runRead("get_recent_charges", { since: SINCE });
    for (const call of calls) {
      expect(new URL(call.url).searchParams.has("limit"), call.url).toBe(false);
    }
  });
});

// ── per-dataset endpoint facts, read off the wire ───────────────────────────

describe("Square charge — GET /v2/payments", () => {
  it("🔴 filters on updated_at_begin_time, sorts on UPDATED_AT, and pages on cursor", async () => {
    const { connector, calls } = connectorWith([
      { body: { payments: [{ ...PAYMENT, id: "pay_1" }], cursor: "CUR1", refunds: [{ id: "decoy" }] } },
      { body: { payments: [{ ...PAYMENT, id: "pay_2" }] } },
    ]);
    const rows = rowsOf(await connector.runRead("get_recent_charges", { since: SINCE }));

    const first = new URL(calls[0]!.url);
    expect(first.host).toBe("connect.squareup.com");
    expect(first.pathname).toBe("/v2/payments");
    // The watermark. Square documents this range as "determined using the
    // `updated_at` field for each Payment" — a genuine last-modified filter.
    // Mutation: spell it `updated_at_begin` or `begin_time` -> Square IGNORES the
    // unknown parameter, answers 200 with the seller's whole history, and the
    // sync reports a complete incremental read. Nothing else catches that.
    expect(first.searchParams.get("updated_at_begin_time")).toBe(SINCE_ISO);
    // 🔴 And NOT `begin_time`, which Square also accepts here and which filters on
    // CREATION time. Both are valid parameters; only one is a watermark.
    expect(first.searchParams.has("begin_time")).toBe(false);
    // `sort_field=UPDATED_AT` is REQUIRED alongside the filter, not a nicety:
    // Square's default is CREATED_AT, so paging would advance on a different
    // field than the watermark narrows, and a row updated mid-walk can be skipped
    // or repeated.
    expect(first.searchParams.get("sort_field")).toBe("UPDATED_AT");
    expect(first.searchParams.get("sort_order")).toBe("ASC");

    // Page two: the cursor Square returned, on the parameter Square names, with
    // the watermark and the sort still attached.
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("cursor")).toBe("CUR1");
    expect(second.searchParams.get("updated_at_begin_time")).toBe(SINCE_ISO);
    expect(second.searchParams.get("sort_field")).toBe("UPDATED_AT");
    expect(calls).toHaveLength(2);

    // rowsPath is `payments`. The decoy `refunds` array on page one is what makes
    // this an assertion rather than a coincidence: a profile that read the wrong
    // key would return the decoy, not zero rows.
    expect(rows.map((r) => r.charge_id)).toEqual(["pay_1", "pay_2"]);
  });

  it("🔴 declares the watermark COMPLETE — updated_at_begin_time is a real last-modified filter", () => {
    // True because Square filters on the row's own `updated_at`, not on
    // creation: an edit after the window opened still comes back.
    //
    // ⚠ `complete` is a RECORDED FACT, not a control. Nothing reads it — the
    // reconciliation sweep's cadence is uniform, and neither vendor is swept
    // at all today because `charge`/`refund`/`payout` are not in
    // `ERP_SYNC_ENTITIES`. See `RestWatermark.complete`, which says so, and the
    // orchestrator test that pins it.
    // Mutation: flip it to false -> red HERE, and nowhere else. That is the
    // whole of its current effect, and saying otherwise (as this comment used
    // to) invents a sweeper decision that does not happen.
    const charge = SQUARE_PROFILE.datasets.find((d) => d.dataset === "charge")!;
    expect(charge.watermark).toEqual({
      name: "updated_at_begin_time",
      location: "query",
      format: "iso",
      complete: true,
    });
    expect(charge.pagination).toEqual({ kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" });
    expect(charge.rowsPath).toBe("payments");
  });

  it("🔴 converts money from MINOR UNITS using the ROW'S OWN currency — USD 1250 is 12.50", async () => {
    // THE highest-value assertion in this file. `amount_money.amount` is an
    // integer in the currency's minor unit; a canonical money column is the major
    // unit. Passing it through reports every USD payment at 100x, and
    // `charge.amount` feeds the money questions the model answers.
    // Mutation: drop the `minor-units` transform -> 1250 lands as 1250 dollars.
    const { connector } = connectorWith([{ body: { payments: [PAYMENT] } }]);
    const row = rowsOf(await connector.runRead("get_recent_charges", { since: SINCE }))[0]!;

    expect(row.amount).toBe(12.5);
    expect(row.currency).toBe("USD");
    // `refunded_money` carries no currency in this fixture, and the profile reads
    // BOTH money columns' currency from `amount_money.currency` — the charge's own
    // currency is the only defensible exponent for its refund.
    // Mutation: read `refunded_money.currency` -> undefined currency ->
    // `fromMinorUnits` refuses -> `amount_refunded` silently becomes undefined.
    expect(row.amount_refunded).toBe(2.5);
  });

  it("🔴 JPY 1250 is 1250, not 12.50 — the exponent comes from ISO 4217, not from /100", async () => {
    // A hardcoded `/100` is wrong for every zero-exponent currency. ¥1250 in
    // Square's `amount` IS ¥1250: Square's money model is "the smallest
    // denomination of the currency", and the yen has no smaller denomination.
    // Mutation: `value / 100` -> a Japanese seller's revenue is reported at 1% of
    // its real size, and every figure still looks plausible.
    const { connector } = connectorWith([
      {
        body: {
          payments: [
            { ...PAYMENT, amount_money: { amount: 1250, currency: "JPY" }, refunded_money: { amount: 250 } },
          ],
        },
      },
    ]);
    const row = rowsOf(await connector.runRead("get_recent_charges", { since: SINCE }))[0]!;
    expect(row.amount).toBe(1250);
    expect(row.currency).toBe("JPY");
    expect(row.amount_refunded).toBe(250);
  });
});

describe("Square refund — GET /v2/refunds", () => {
  it("filters on updated_at_begin_time, reads rows from refunds, and maps charge_id from payment_id", async () => {
    const { connector, calls } = connectorWith([
      {
        body: {
          refunds: [
            {
              id: "ref_1",
              payment_id: "pay_1",
              created_at: "2026-09-02T12:00:00Z",
              updated_at: "2026-09-03T09:00:00Z",
              amount_money: { amount: 500, currency: "USD" },
              status: "COMPLETED",
              reason: "Requested by customer",
            },
          ],
          // Decoy: proves `rowsPath` is read, not guessed.
          payments: [{ id: "decoy" }],
        },
      },
    ]);
    const row = rowsOf(await connector.runRead("get_refunds", { since: SINCE }))[0]!;

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/refunds");
    expect(url.searchParams.get("updated_at_begin_time")).toBe(SINCE_ISO);
    expect(url.searchParams.has("begin_time")).toBe(false);
    expect(url.searchParams.get("sort_field")).toBe("UPDATED_AT");
    expect(url.searchParams.get("sort_order")).toBe("ASC");

    expect(row.refund_id).toBe("ref_1");
    // 🔴 `payment_id`, not `charge_id`: Square has no "charge". Mapping the wrong
    // key leaves every refund unattached to the payment it reverses.
    expect(row.charge_id).toBe("pay_1");
    expect(row.amount).toBe(5);
    expect(row.status).toBe("COMPLETED");
    expect(row.reason).toBe("Requested by customer");
  });

  it("🔴 declares the watermark COMPLETE — a refund's status MOVES after creation", () => {
    // This is the dataset where completeness matters most: a refund goes PENDING
    // -> COMPLETED after it is created, so a creation-time filter would freeze
    // every refund at PENDING in the box forever, and the row would look fresh
    // because the sync kept succeeding.
    const refund = SQUARE_PROFILE.datasets.find((d) => d.dataset === "refund")!;
    expect(refund.watermark).toEqual({
      name: "updated_at_begin_time",
      location: "query",
      format: "iso",
      complete: true,
    });
    expect(refund.pagination).toEqual({ kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" });
    expect(refund.rowsPath).toBe("refunds");
  });
});

describe("Square payout — GET /v2/payouts", () => {
  it("🔴 filters on begin_time, which Square defines as CREATION time", async () => {
    // Square: "The timestamp for the beginning of the payout creation time".
    // There is no `updated_at_begin_time` on this endpoint — the whole parameter
    // list is location_id, status, begin_time, end_time, sort_order, cursor,
    // limit — so this is the ADR-046 §2 Postmark case verbatim.
    // Mutation: send `updated_at_begin_time` here -> Square ignores it, the read
    // is a FULL SCAN of a year of payouts, and it reports as incremental.
    const { connector, calls } = connectorWith([
      {
        body: {
          payouts: [
            {
              id: "po_1",
              created_at: "2026-09-02T00:00:00Z",
              updated_at: "2026-09-04T00:00:00Z",
              arrival_date: "2026-09-05",
              amount_money: { amount: 125_000, currency: "USD" },
              status: "PAID",
            },
          ],
        },
      },
    ]);
    const row = rowsOf(await connector.runRead("get_payouts", { since: SINCE }))[0]!;

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/payouts");
    expect(url.searchParams.get("begin_time")).toBe(SINCE_ISO);
    expect(url.searchParams.has("updated_at_begin_time")).toBe(false);
    // No sort parameters: `sort_field` is not offered on this endpoint, and the
    // charge/refund pair's `sort_field=UPDATED_AT` must not be copied across.
    expect(url.searchParams.has("sort_field")).toBe(false);
    expect(row.payout_id).toBe("po_1");
    expect(row.amount).toBe(1250);
  });

  it("🔴 declares the watermark INCOMPLETE, which is what keeps the full sweep MANDATORY", () => {
    // `updated_at` IS on the Payout object — it is simply not filterable. So a
    // payout that moves SENT -> PAID after its creation window closes is NEVER
    // re-read by an incremental pass. That is the vendor fact, and it is why
    // this endpoint needs a periodic full re-read where the other two do not.
    //
    // ⚠ The note that used to sit here — "flip this to true -> the sweep is
    // dropped as redundant and every payout freezes" — was FALSE, and false in
    // the direction that matters: it described a consequence, so a reader would
    // stop looking for one. Nothing reads `complete`. The sweep's cadence is
    // uniform, and `payout` is not in `ERP_SYNC_ENTITIES` at all, so no sweep
    // and no incremental tick runs for a Square connection in the first place.
    // Mutation: flip this to true -> red here, and nowhere else.
    const payout = SQUARE_PROFILE.datasets.find((d) => d.dataset === "payout")!;
    expect(payout.watermark).toEqual({
      name: "begin_time",
      location: "query",
      format: "iso",
      complete: false,
    });
    expect(payout.pagination).toEqual({ kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" });
    expect(payout.rowsPath).toBe("payouts");
  });

  it("🔴 widens arrival_date (a YYYY-MM-DD DATE) to UTC midnight for the arrival_at TIMESTAMP", async () => {
    // Square documents `arrival_date` as a calendar date — "2022-03-29" — while
    // `COLUMN_KIND.arrival_at` is a timestamp. Widening explicitly beats passing
    // it through for every downstream `Date.parse` to guess at: a bare date string
    // parses as UTC midnight in Node and as LOCAL midnight in some browsers, so an
    // untransformed value lands a payout on a different day depending on who read
    // it.
    // Mutation: map `arrival_at: "arrival_date"` with no transform -> the column
    // holds a date, not an instant, and the failure only shows up a timezone away
    // from the developer who wrote it.
    const { connector } = connectorWith([
      {
        body: {
          payouts: [
            {
              id: "po_2",
              created_at: "2026-09-02T00:00:00Z",
              updated_at: "2026-09-04T00:00:00Z",
              arrival_date: "2026-03-29",
              amount_money: { amount: 5000, currency: "USD" },
              status: "SENT",
            },
          ],
        },
      },
    ]);
    const row = rowsOf(await connector.runRead("get_payouts", { since: SINCE }))[0]!;
    expect(row.arrival_at).toBe("2026-03-29T00:00:00.000Z");
  });

  it("🔴 keeps a WITHDRAWAL negative — a payout amount is signed", async () => {
    // Square: "a positive amount indicates a deposit, and a negative amount
    // indicates a withdrawal". The canonical `payout` comment describes a positive
    // magnitude, so a withdrawal lands here as a negative number, and that is the
    // honest projection.
    // Mutation: `Math.abs` it "to fix the sign" -> money LEAVING the seller's
    // account is reported as money arriving in it, which is the worst possible
    // direction for this particular error.
    const { connector } = connectorWith([
      {
        body: {
          payouts: [
            {
              id: "po_3",
              created_at: "2026-09-02T00:00:00Z",
              updated_at: "2026-09-02T00:00:00Z",
              arrival_date: "2026-09-03",
              amount_money: { amount: -5000, currency: "USD" },
              status: "PAID",
            },
          ],
        },
      },
    ]);
    expect(rowsOf(await connector.runRead("get_payouts", { since: SINCE }))[0]!.amount).toBe(-50);
  });
});

// ── the empty-result shape Square actually sends ────────────────────────────

describe("Square — an empty result omits the array entirely", () => {
  it("🔴 reads a literal {} as ZERO ROWS, not as a pagination contract error", async () => {
    // Square OMITS the array when there is nothing to return: the body is `{}`,
    // not `{"payments": []}`. Without `absentRowsMeansEmpty`, the connector's
    // (correct, and correct for every other vendor) "no array at the declared
    // rowsPath" guard fires — so a seller with no refunds this week gets a hard
    // sync failure and a red connection card for a completely healthy account.
    // Mutation: drop `absentRowsMeansEmpty` from any of the three specs -> red.
    // Its narrowness matters too: only ABSENT means empty. A present non-array is
    // still a contract error, because that is a wrong rowsPath, not an empty page.
    for (const name of ["get_recent_charges", "get_refunds", "get_payouts"]) {
      const { connector, calls } = connectorWith([{ body: {} }]);
      await expect(connector.runRead(name, { since: SINCE })).resolves.toEqual([]);
      expect(calls).toHaveLength(1);
    }
    for (const spec of SQUARE_PROFILE.datasets) {
      expect(spec.absentRowsMeansEmpty, `${spec.dataset} must tolerate Square's omitted array`).toBe(true);
    }
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 🔴 The refusal tests this file's header calls non-negotiable, and which it
 * shipped without.
 *
 * ADR-046 §3 and `rest-track.test.ts`'s own header state the rule: **a refusal
 * asserts `fetch` was called ZERO times**, never merely that an error was
 * thrown. A test that inspected only the returned error would still pass if the
 * request had already gone out carrying the seller's access token — and on this
 * track that token is a live payments credential.
 *
 * Square's profile is STATIC, so its host cannot be steered by a connection
 * row. That is exactly why these belong here anyway: the refusals below are
 * about the CREDENTIAL and the VOCABULARY, which no `kind: egress` entry and no
 * host guard covers, and they are the ones that will still be true when the
 * self-hosted / regional vendors arrive on this track behind a dynamic host.
 */
describe("Square — the refusals, each costing ZERO fetch calls", () => {
  /** The real profile with a resolver that yields nothing at all. */
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([{ body: { payments: [] } }]);
    const connector = new RestProfileConnector(
      SQUARE_PROFILE,
      { provider: SQUARE_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses a read when the stored credential has no accessToken — ZERO fetch calls", async () => {
    // The shape a real connection reaches this in: the descriptor's field was
    // renamed, or the seller's secret was purged on disconnect and the row
    // survived. Sending the literal `{{accessToken}}` would land in Square's
    // logs as a failed auth nobody can explain, and would burn the seller's
    // rate budget doing it.
    // Mutation: fall back to "" instead of refusing an empty placeholder -> the
    // request goes out and the call count goes to 1.
    const { connector, calls } = connectorWithCredentials({});
    await expect(connector.runRead("get_recent_charges", { since: SINCE })).rejects.toThrow(
      /has no "accessToken"/,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a blank accessToken as firmly as a missing one — ZERO fetch calls", async () => {
    // Whitespace is the shape a paste box produces, and an empty Authorization
    // header is a request that cannot succeed. Refusing costs nothing; sending
    // it spends a call and teaches Square that this seller has a broken client.
    const { connector, calls } = connectorWithCredentials({ accessToken: "   " });
    await expect(connector.connect()).rejects.toThrow(/has no "accessToken"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a dataset Square does not serve — ZERO fetch calls, and NOT an empty array", async () => {
    // `invoice`, `order`, `product` and `customer` are omitted from this profile
    // for reasons recorded in `vendors/square.ts`, and the omissions are pinned
    // above. THIS is what makes the omission safe: asked for one anyway, the
    // connection refuses by name.
    // Returning `[]` instead would be a confident false statement about a
    // seller's money that no caller could tell from a genuinely empty result —
    // and it would be indistinguishable in every downstream report.
    // Mutation: make `runRead` fall through to an empty array -> red.
    // Real registry names, each depending on a dataset Square omits:
    // get_open_invoices -> invoice, get_recent_orders -> order,
    // get_schedule_today -> appointment. A name the registry does not know at
    // all raises UnknownReadQueryError instead and would prove nothing here.
    for (const name of ["get_open_invoices", "get_recent_orders", "get_schedule_today"]) {
      const { connector, calls } = connectorWithCredentials({ accessToken: ACCESS_TOKEN });
      await expect(connector.runRead(name, { since: SINCE }), name).rejects.toThrow(
        DatasetNotServedError,
      );
      expect(calls, name).toHaveLength(0);
    }
  });

  it("🔴 refuses every write, and spends no call finding out — the track is read-only", async () => {
    // ADR-046 §4. Square HAS a write API; this connection does not reach it,
    // and there is no profile field that could turn it on. The call count is the
    // assertion that matters: a write attempted and rejected BY SQUARE would
    // have been a real request against a real seller's account.
    const { connector, calls } = connectorWithCredentials({ accessToken: ACCESS_TOKEN });
    await expect(connector.applyWrite("reschedule_appointment", {})).rejects.toThrow(
      ConnectorBlockedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses to build against a provider id that is not Square's — ZERO fetch calls", async () => {
    // A connection row whose `provider` disagrees with the profile it was
    // dispatched to is a row written by a different build. Refused at
    // CONSTRUCTION, before any credential is resolved.
    const { impl, calls } = stubFetch([{ body: { payments: [] } }]);
    expect(
      () =>
        new RestProfileConnector(
          SQUARE_PROFILE,
          { provider: "square-sandbox" },
          { fetchImpl: impl, resolveCredentials: async () => ({ accessToken: ACCESS_TOKEN }) },
        ),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a 302 rather than following it off connect.squareup.com", async () => {
    // The static origin is guarded, but `fetch` defaults to following
    // redirects — so without `redirect: "error"` the guard would be checking a
    // URL while Square's answer chose the destination, with the seller's
    // payments token attached. EXACTLY ONE call: the redirect was not followed.
    const { connector, calls } = connectorWith([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/v2/payments" } },
    ]);
    await expect(connector.runRead("get_recent_charges", { since: SINCE })).rejects.toThrow(
      UnsafeBaseUrlError,
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("connect.squareup.com");
  });
});
