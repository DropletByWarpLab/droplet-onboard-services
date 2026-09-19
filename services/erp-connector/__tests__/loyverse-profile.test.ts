/**
 * WARP-2919 / ADR-046 — Loyverse's VENDOR FACTS, pinned against Loyverse's own
 * documentation.
 *
 * ## Why this file is mandatory rather than nice to have
 *
 * ADR-046's Consequences section: *"A declarative profile is easier to get wrong
 * quietly than code is. A wrong watermark parameter is one string. Mitigation:
 * the parameter names are pinned by tests that cite the vendor page, exactly as
 * `graph-resources.test.ts` does for Microsoft Graph."* This is that file for
 * Loyverse. `rest-track.test.ts` proves the connector does what a profile SAYS —
 * which is exactly the question that stays green when the profile says the wrong
 * thing — and `introspect()`'s fingerprint hashes the datasets and their
 * canonical columns, not the paths, headers or parameter spellings. Only this
 * file can catch those.
 *
 * Loyverse's version of the silent failure is the ordinary one and it is bad
 * enough: `updated_at_min` is one of a family of sibling filters (`/receipts`
 * declares `created_at_min`, `created_at_max`, `updated_at_min` and
 * `updated_at_max` side by side), and a profile that reached for
 * `created_at_min` — the one every quick-start uses — would never see a record
 * edited after its window closed, while every sync reported success.
 *
 * And the one this file learned the hard way: an earlier cut served receipts as
 * `order` with `currency` undefined, because no check asked whether the
 * REQUIRED columns were mapped. `assertValidRestProfile` now does, and the
 * `order` block below pins that the dataset is refused for exactly that reason
 * rather than quietly missing.
 *
 * ## The sources every claim below was checked against (2026-09-18)
 *
 *  • API reference (rendered)   https://developer.loyverse.com/docs/
 *  • the OpenAPI 3.0 document   https://developer.loyverse.com/docs/API-Reference__v1.0.yaml
 *    — where the parameter lists, the `cursor` field on each 200 schema, the
 *    `Pagination`, `Authorization`, `API rate limits` and `Soft deletion`
 *    sections, and every field name in the fixtures below were read.
 *  • Authorization              https://developer.loyverse.com/docs/#section/Authorization
 *  • Pagination                 https://developer.loyverse.com/docs/#section/Pagination
 *  • API rate limits            https://developer.loyverse.com/docs/#section/API-rate-limits
 *  • List receipts (NOT served) https://developer.loyverse.com/docs/#tag/Receipts/paths/~1receipts/get
 *  • List customers             https://developer.loyverse.com/docs/#tag/Customers/paths/~1customers/get
 *  • List items                 https://developer.loyverse.com/docs/#tag/Items/paths/~1items/get
 *  • Merchant                   https://developer.loyverse.com/docs/#tag/Merchant
 *  • Access tokens (help)       https://help.loyverse.com/help/loyverse-api
 *  • FAQ (paid receipts only)   https://support.loyverse.com/en/articles/8061203-faqs-about-loyverse-api
 *  • Pricing (Integrations free) https://loyverse.com/pricing
 *
 * ## The rule every test here obeys
 *
 * 🔴 **Facts are asserted from the OUTGOING REQUEST, not from the profile
 * object.** These tests run the REAL profile through a REAL
 * `RestProfileConnector` with an injected fetch, so a connector that drops the
 * bearer header, forgets the watermark or pages on the wrong parameter goes red
 * here even though the profile is untouched.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import { providerDescriptor } from "@droplet/shared-types";

import {
  RestPaginationContractError,
  RestProfileConnector,
  UnsafeBaseUrlError,
} from "../src/rest/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { assertValidRestProfile, authPlaceholders, type RestDatasetSpec } from "../src/rest/profile.js";
import { restProfileFor } from "../src/rest/profiles.js";
import {
  LOYVERSE_API_ORIGIN,
  LOYVERSE_MIN_REQUEST_INTERVAL_MS,
  LOYVERSE_PAGE_LIMIT,
  LOYVERSE_PROFILE,
  LOYVERSE_PROVIDER,
} from "../src/rest/vendors/loyverse.js";
import { CANONICAL_COLUMNS, REQUIRED_CANONICAL } from "../src/export-drop/profiles.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A recording fetch stub — the same shape `rest-track.test.ts` uses, and
 * duplicated rather than imported ON PURPOSE: importing it from that file would
 * execute that file's whole suite as a side effect of loading this one, and a
 * suite that runs another suite reports failures against the wrong file.
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

/**
 * A personal access token's stand-in. Loyverse documents NO shape for a PAT —
 * no prefix, no length — so the value here is deliberately nothing in
 * particular. It works because nothing validates the shape, which is the
 * property the descriptor test below pins.
 */
const ACCESS_TOKEN = "test-access-token";

/**
 * The REAL profile, through the REAL connector.
 *
 * The clock and `sleep` are injected because this profile paces at 1000 ms
 * between requests: with the default `setTimeout` a two-page read would make the
 * suite actually pay Loyverse's rate ceiling. The recorded sleeps are asserted in
 * the pacing test rather than discarded.
 */
function connectorWith(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const { impl, calls } = stubFetch(pages);
  const slept: number[] = [];
  let clock = 0;
  const connector = new RestProfileConnector(
    LOYVERSE_PROFILE,
    { provider: LOYVERSE_PROVIDER },
    {
      fetchImpl: impl,
      resolveCredentials: async () => ({ accessToken: ACCESS_TOKEN }),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    },
  );
  return { connector, calls, slept };
}

/** The watermark instant every read below passes, and what it must appear as. */
const SINCE = "2026-09-01T00:00:00Z";
/**
 * Loyverse's own documented example is `2020-03-30T18:30:00.000Z` — with
 * millis. `formatWatermark("iso")` emits `toISOString()`, which is exactly that
 * shape, so the question of whether Loyverse accepts an instant WITHOUT millis
 * never arises.
 */
const SINCE_ISO = "2026-09-01T00:00:00.000Z";

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const rowsOf = (rows: unknown[]) => rows as Record<string, unknown>[];

/**
 * The `order` dataset Loyverse WOULD serve — `GET /v1.0/receipts`, as researched
 * against the OpenAPI document — and does not, because it cannot map `currency`.
 *
 * Kept as a test constant rather than deleted, for two reasons. First, the
 * refusal test below runs it through `assertValidRestProfile` and pins that the
 * guard names `currency` — so the dataset is absent for a reason a reader can
 * verify, not for one they have to take on trust. Second, the day the track
 * gains a probe-derived per-account constant (Loyverse's currency is
 * `GET /v1.0/merchant/` → `currency.code`), this is the spec that ships, plus
 * one `currency` entry, and the vendor facts in it — `receipt_number` as the id
 * (there is no `id`), `total_money` already in MAJOR units (17.52, not 1752),
 * `updated_at_min` rather than `created_at_min`, `limit=250` — were checked
 * once and need not be re-learned.
 *
 * NOT a fixture the connector reads: nothing below fetches it.
 */
const RECEIPTS_WHEN_CURRENCY_ARRIVES: RestDatasetSpec = {
  dataset: "order",
  path: "/v1.0/receipts",
  query: { limit: LOYVERSE_PAGE_LIMIT },
  watermark: { name: "updated_at_min", location: "query", format: "iso", complete: true },
  pagination: { kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" },
  rowsPath: "receipts",
  fieldMap: {
    order_id: "receipt_number",
    created_at: "created_at",
    customer_id: "customer_id",
    total_amount: "total_money",
    tax_amount: "total_tax",
    updated_at: "updated_at",
  },
};

/**
 * One Loyverse `Customer`, field names and nesting verbatim from the schema.
 * ONE `name` field — Loyverse has no first/last split — and `total_visits`,
 * which is NOT documented as a receipt count. Both facts are pinned below.
 */
const CUSTOMER = {
  id: "c71758a2-79bf-11ea-bde9-1269e7c5a22d",
  name: "John Smith",
  email: "jsmith@example.com",
  phone_number: "+12025550143",
  address: "1 Main St",
  city: "Springfield",
  region: "IL",
  postal_code: "62701",
  country_code: "US",
  customer_code: "C-001",
  note: null,
  first_visit: "2020-03-25T19:55:23.077Z",
  last_visit: "2020-06-23T08:35:47.047Z",
  total_visits: 3,
  total_spent: 120.55,
  total_points: 12.5,
  created_at: "2020-03-25T19:55:23.077Z",
  updated_at: "2020-03-30T08:05:10.020Z",
};

/**
 * One Loyverse `Item`, field names and nesting verbatim from the schema. TWO
 * variants, because that is the shape `variants[0]` is knowingly lossy about:
 * the second variant's sku and price are NOT representable in a canonical row.
 */
const ITEM = {
  id: "d5fe0da6-44b3-4633-9915-e9dc5118cbfc",
  handle: "t-shirt",
  item_name: "T-shirt",
  description: "string",
  reference_id: null,
  category_id: null,
  track_stock: false,
  sold_by_weight: false,
  is_composite: false,
  use_production: false,
  components: [],
  primary_supplier_id: null,
  tax_ids: [],
  modifiers_ids: [],
  form: "SQUARE",
  color: "GREY",
  image_url: null,
  option1_name: "Size",
  option2_name: "Color",
  option3_name: null,
  created_at: "2020-03-25T19:55:23.077Z",
  updated_at: "2020-03-30T08:05:10.020Z",
  deleted_at: null,
  variants: [
    {
      variant_id: "706e2626-3329-45f8-98d7-0e1dbcbcb9d9",
      item_id: "d5fe0da6-44b3-4633-9915-e9dc5118cbfc",
      sku: "10010",
      reference_variant_id: null,
      option1_value: "Large",
      option2_value: "Green",
      option3_value: null,
      barcode: null,
      cost: 0.0,
      purchase_cost: 0.0,
      default_pricing_type: "FIXED",
      default_price: 10.0,
      stores: [
        {
          store_id: "42dc2cec-6f40-11ea-bde9-1269e7c5a22d",
          pricing_type: "FIXED",
          price: 10.0,
          available_for_sale: true,
          optimal_stock: null,
          low_stock: null,
        },
      ],
      created_at: "2020-11-04T00:00:00.000Z",
      updated_at: "2020-11-04T00:00:00.000Z",
      deleted_at: null,
    },
    {
      variant_id: "9b1c0f0e-0000-4000-8000-000000000002",
      item_id: "d5fe0da6-44b3-4633-9915-e9dc5118cbfc",
      sku: "10011",
      reference_variant_id: null,
      option1_value: "Small",
      option2_value: "Red",
      option3_value: null,
      barcode: null,
      cost: 0.0,
      purchase_cost: 0.0,
      default_pricing_type: "FIXED",
      default_price: 12.5,
      stores: [],
      created_at: "2020-11-04T00:00:00.000Z",
      updated_at: "2020-11-04T00:00:00.000Z",
      deleted_at: null,
    },
  ],
};

/** The cursor Loyverse's examples use — a UUID, echoed back verbatim. */
const CURSOR = "b4d08058-dc81-11ea-90b4-1269e7c5a22d";

// ── identity, custody and the descriptor ────────────────────────────────────

describe("Loyverse — the profile the track actually dispatches", () => {
  it("is the profile restProfileFor('loyverse') returns, not a copy", () => {
    // Mutation: register a second Loyverse profile in `profiles.ts` and this
    // whole file starts testing a file nothing ships.
    expect(restProfileFor(LOYVERSE_PROVIDER)).toBe(LOYVERSE_PROFILE);
  });

  it("🔴 dials ONE static host, and it is the host the descriptor registers for egress", () => {
    // The OpenAPI document's single `servers` entry is
    // `https://api.loyverse.com/v1.0` — one host, no region, no merchant
    // subdomain. The `/v1.0` is a PATH, and `assertValidRestProfile` refuses a
    // path on a static origin (it would silently prefix every dataset path), so
    // the version prefix rides on `probePath` and on every dataset `path`
    // instead. Pinned here because a build agent copying Square's shape could
    // put it on the origin and fail at module load, or drop it from one path
    // and get a 404 that reads as a wrong credential.
    // Mutation: `origin: "https://api.loyverse.com/v1.0"` -> module load throws.
    expect(LOYVERSE_PROFILE.baseUrl).toEqual({ kind: "static", origin: LOYVERSE_API_ORIGIN });
    expect(LOYVERSE_API_ORIGIN).toBe("https://api.loyverse.com");
    expect(providerDescriptor(LOYVERSE_PROVIDER)!.egressHosts).toEqual(["api.loyverse.com"]);
    for (const spec of LOYVERSE_PROFILE.datasets) {
      expect(spec.path, spec.dataset).toMatch(/^\/v1\.0\//);
    }
    expect(LOYVERSE_PROFILE.probePath).toMatch(/^\/v1\.0\//);
  });

  it("🔴 serves EXACTLY the datasets the descriptor advertises", () => {
    // The descriptor is what the hub, the scheduler (`entityServedBy`) and the
    // dashboard read; the profile is what the connector reads. A drift between
    // them is the class of bug the descriptor exists to prevent — a hub tile
    // offering a dataset the connection will refuse the first time it is asked.
    // Compared as SETS: ordering carries no meaning in either place.
    const served = LOYVERSE_PROFILE.datasets.map((d) => d.dataset);
    expect([...served].sort()).toEqual([...providerDescriptor(LOYVERSE_PROVIDER)!.datasets].sort());
    expect([...served].sort()).toEqual(["customer", "product"]);
    // 🔴 And NOT `order` — see the block below for the reason, pinned.
    expect(served).not.toContain("order");
  });

  it("🔴 declares NO credential-field pattern — Loyverse documents no token shape", () => {
    // The help article and the OpenAPI Authorization section describe how a
    // personal access token is MINTED (Back Office → Integrations → Access
    // tokens → + Add access token) and what it can do ("unlimited access to
    // all resources"), and say nothing about what it looks like. A regex
    // anchored on an undocumented shape is the Brevo/Square/Cal.com false
    // rejection: it blocks a paying owner at the paste box for zero security
    // gain. Emptiness is the only thing refused; the proof a token is real is
    // Loyverse answering `GET /v1.0/merchant/` with it, which `connect()` does.
    // Mutation: add any `pattern` -> red.
    const fields = providerDescriptor(LOYVERSE_PROVIDER)!.credentialFields;
    expect(fields.map((f) => f.name)).toEqual(["accessToken"]);
    for (const field of fields) expect(field.pattern).toBeUndefined();
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.required).toBe(true);
    expect(fields[0]!.storage).toBe("encrypted");
  });

  it("🔴 tells the owner, in the help text, that the token is unlimited AND to set an expiry", () => {
    // Loyverse's own words: "personal access token gives unlimited access to
    // the targeted account" — read AND write, with no read-only scope on the
    // PAT path (scopes exist only on the OAuth path, which this track does not
    // use). Expiry is optional at mint time. The box is read-only by
    // construction, but the TOKEN is not, so the one control the owner has is
    // the expiration date — and the help text is the only place they will read
    // that before pasting.
    // Mutation: soften "unlimited" or drop the expiry advice -> red.
    const help = providerDescriptor(LOYVERSE_PROVIDER)!.credentialFields[0]!.help ?? "";
    expect(help).toMatch(/Back Office/);
    expect(help).toMatch(/Access tokens/);
    expect(help).toMatch(/unlimited/i);
    expect(help).toMatch(/expir/i);
  });

  it("names its credential placeholder EXACTLY as the descriptor names the field", () => {
    // These two are wired together at runtime by nothing but this string: the
    // orchestrator stores the field under the descriptor's name, the connector
    // looks it up by the template's placeholder. Rename either alone and every
    // Loyverse connection refuses with "the stored credential has no
    // accessToken" — at first read, on a schedule, where nobody is watching.
    expect(authPlaceholders(LOYVERSE_PROFILE.auth)).toEqual(["accessToken"]);
    expect(providerDescriptor(LOYVERSE_PROVIDER)!.credentialFields.map((f) => f.name)).toEqual(
      authPlaceholders(LOYVERSE_PROFILE.auth),
    );
  });

  it("paces at the DOCUMENTED floor, and the descriptor's ceiling says the same thing twice", async () => {
    // Loyverse's API rate limits section: "The current limit is 300 requests
    // per 300 sec per account." One request per second. A published number, so
    // the profile paces against it rather than reacting to the 429 alone. The
    // descriptor states the same fact in `ProviderRateLimit`'s shape, and these
    // are the only two places it is written down.
    //
    // ⚠ PER ACCOUNT, not per token: every other integration the merchant runs
    // shares this budget, and Loyverse also mentions "additional resource-based
    // rate limits" it does not quantify. 1 s is the floor, not a guarantee.
    // Mutation: "300 per minute" -> 200 ms -> red.
    const rateLimit = providerDescriptor(LOYVERSE_PROVIDER)!.rateLimit!;
    expect(rateLimit).toEqual({ callCeiling: 300, periodMs: 300_000 });
    expect(rateLimit.periodMs / rateLimit.callCeiling).toBe(LOYVERSE_MIN_REQUEST_INTERVAL_MS);
    expect(LOYVERSE_PROFILE.minRequestIntervalMs).toBe(1000);

    // And it is a WAIT between requests, not a refusal.
    const { connector, slept } = connectorWith([
      { body: { customers: [CUSTOMER], cursor: CURSOR } },
      { body: { customers: [] } },
    ]);
    await connector.runRead("find_customer", { since: SINCE });
    expect(slept).toEqual([LOYVERSE_MIN_REQUEST_INTERVAL_MS]);
  });
});

// ── the headers that actually leave the box ─────────────────────────────────

describe("Loyverse — auth read off the wire", () => {
  it("sends Authorization: Bearer <token> — the literal name and the literal template", async () => {
    // securitySchemes.BearerAuth is `type: http, scheme: bearer` in the OpenAPI
    // document, and the Authorization section shows the header verbatim. A
    // genuine RFC-6750 Bearer scheme — pinned because five of the six shapes on
    // ADR-046 §2's table are NOT this one.
    const { connector, calls } = connectorWith([{ body: { customers: [] } }]);
    await connector.runRead("find_customer", { since: SINCE });

    expect(LOYVERSE_PROFILE.auth).toEqual({
      headerName: "Authorization",
      valueTemplate: "Bearer {{accessToken}}",
    });
    expect(headersOf(calls[0]!.init).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("sends NO constant header — Loyverse pins its version in the PATH, not a header", async () => {
    // Square needs `Square-Version`, Cal.com `cal-api-version`, Klaviyo
    // `revision`. Loyverse versions by URL (`/v1.0/`) and documents no
    // version, revision or accept header of any kind. An invented header is
    // not harmless: it is a contract nobody published, and the day Loyverse
    // starts honouring one it will mean something this profile never chose.
    // Mutation: copy a version header across from a neighbouring profile -> red.
    const { connector, calls } = connectorWith([{ body: { customers: [] } }]);
    await connector.connect();
    await connector.runRead("find_customer", { since: SINCE });

    expect(LOYVERSE_PROFILE.constantHeaders).toEqual({});
    for (const call of calls) {
      const names = Object.keys(headersOf(call.init)).map((h) => h.toLowerCase());
      expect(names.filter((h) => h !== "authorization" && h !== "accept")).toEqual([]);
    }
  });

  it("probes GET /v1.0/merchant/ — trailing slash and all — on BOTH connect() and health()", async () => {
    // 🔴 Resolving the credential locally is not a connection: a token the
    // owner expired in the Back Office resolves perfectly and fails on the
    // first scheduled read, hours later. `GET /merchant/` returns the one
    // merchant profile the token belongs to — no pagination, no parameters —
    // so a 401 on it is unambiguous evidence about the TOKEN.
    //
    // The TRAILING SLASH is the documented path (`/merchant/` in the OpenAPI
    // paths object, unlike `/receipts`), and it is kept rather than
    // normalised: whether Loyverse redirects `/merchant` to `/merchant/` is
    // undocumented, and this connector refuses redirects.
    // Mutation: point probePath at `/v1.0/customers` -> the health check pages
    // the owner's customer book every time, and an account with no customers
    // still "connects" for reasons unrelated to the token.
    const { connector, calls } = connectorWith([
      { body: { id: "m-1", business_name: "Test", currency: { code: "USD", decimal_places: 2 } } },
    ]);
    await connector.connect();
    await connector.health();

    expect(LOYVERSE_PROFILE.probePath).toBe("/v1.0/merchant/");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.loyverse.com/v1.0/merchant/",
      "https://api.loyverse.com/v1.0/merchant/",
    ]);
    // The probe carries no watermark and no paging parameter: this endpoint
    // documents none, and sending one would be inventing a contract.
    for (const call of calls) expect(new URL(call.url).search).toBe("");
  });
});

// ── order — GET /v1.0/receipts — NOT served ─────────────────────────────────

describe("Loyverse order — NOT served, and refused for a reason a test can name", () => {
  it("🔴 refuses get_recent_orders by NAME — ZERO fetch calls, and NOT an empty array", async () => {
    // A `[]` here would be the worst answer available: "no sales" is a
    // completely believable statement about a quiet day, and the caller could
    // not tell it from "this vendor does not serve orders". The refusal is
    // `DatasetNotServedError`, the same one every unserved dataset gets, and
    // it costs no request — the owner's UNLIMITED token never leaves the box
    // for a question the profile cannot answer.
    // Mutation: put `RECEIPTS_WHEN_CURRENCY_ARRIVES` back into `datasets` ->
    // module load throws (the guard test below says why) before this runs.
    const { connector, calls } = connectorWith([{ body: { receipts: [] } }]);
    await expect(connector.runRead("get_recent_orders", { since: SINCE })).rejects.toThrow(
      DatasetNotServedError,
    );
    expect(calls).toHaveLength(0);
    expect(LOYVERSE_PROFILE.datasets.find((d) => d.dataset === "order")).toBeUndefined();
  });

  it("🔴 the would-be receipts spec is refused by the profile guard, naming `currency` — nothing else", () => {
    // `REQUIRED_CANONICAL.order` names `currency` on the vocabulary's own rule:
    // "an amount without its currency is not a number, it is a rumour". No
    // Loyverse receipt carries one — it is account-wide, on
    // `GET /v1.0/merchant/` as `currency.code` — and this track has no way to
    // stamp a per-account constant onto every row. An earlier cut of this
    // profile shipped the dataset anyway with `currency` undefined, and a
    // `cloud_query_dataset` row of `total_amount: 17.52, currency: undefined`
    // is a dollar-shaped answer for a merchant in Tokyo. Brevo's bespoke
    // connector meets the same vendor shape and makes a second call for the
    // account's display currency; the declarative track cannot yet.
    //
    // Two things pinned. The guard refuses the spec AS RESEARCHED, and the
    // refusal names `currency` — so the reason the dataset is absent is
    // checkable, not folklore. And the SAME spec with `currency` mapped
    // passes, which is the proof that the guard is the only thing between
    // this spec and shipping: the day a probe-derived constant exists, the
    // change is one fieldMap line, not a re-research.
    // Mutation: delete the REQUIRED_CANONICAL loop in `assertValidRestProfile`
    // -> the first expectation goes red, and the dataset could ship blind
    // again. Mutation: `currency: "USD"` as a literal in the map -> the guard
    // passes (a literal is a path that reads `undefined` off every row), which
    // is why the second expectation maps a PATH and the profile header, not
    // this test, is what refuses the hardcode.
    expect(REQUIRED_CANONICAL.order).toContain("currency");
    expect(Object.keys(RECEIPTS_WHEN_CURRENCY_ARRIVES.fieldMap)).not.toContain("currency");

    const withReceipts = { ...LOYVERSE_PROFILE, datasets: [...LOYVERSE_PROFILE.datasets, RECEIPTS_WHEN_CURRENCY_ARRIVES] };
    expect(() => assertValidRestProfile(withReceipts)).toThrow(
      /dataset "order" does not map "currency", which REQUIRED_CANONICAL\.order names/,
    );

    // Every OTHER required column of `order` IS mapped — the refusal is about
    // currency alone, and the spec is otherwise the one that ships.
    for (const column of REQUIRED_CANONICAL.order.filter((c) => c !== "currency")) {
      expect(Object.keys(RECEIPTS_WHEN_CURRENCY_ARRIVES.fieldMap), column).toContain(column);
    }
    const currencyMapped = {
      ...RECEIPTS_WHEN_CURRENCY_ARRIVES,
      fieldMap: { ...RECEIPTS_WHEN_CURRENCY_ARRIVES.fieldMap, currency: "currency" },
    };
    expect(() =>
      assertValidRestProfile({ ...LOYVERSE_PROFILE, datasets: [...LOYVERSE_PROFILE.datasets, currencyMapped] }),
    ).not.toThrow();
  });

  it("🔴 the shipped profile passes the same guard — the two datasets it serves map every required column", () => {
    // The positive half, read off `REQUIRED_CANONICAL` directly rather than by
    // trusting the module loaded: `customer` needs `customer_id`, `product`
    // needs `product_id`, and both are mapped to Loyverse's `id`.
    for (const spec of LOYVERSE_PROFILE.datasets) {
      for (const column of REQUIRED_CANONICAL[spec.dataset]) {
        expect(Object.keys(spec.fieldMap), `${spec.dataset}.${column}`).toContain(column);
      }
    }
    expect(() => assertValidRestProfile(LOYVERSE_PROFILE)).not.toThrow();
  });

  it("records the receipts facts the future dataset must not re-learn", () => {
    // Not a behaviour — a pin on the research, so that a later build reads
    // them here rather than from a forum. `receipt_number` (no `id` exists),
    // `total_money` with NO minor-units transform (17.52 is already major
    // units; "for Japan there is no decimals in money amounts"), and
    // `updated_at_min` rather than the `created_at_min` every quick-start
    // uses. The refund and 31-day facts live in the profile header.
    expect(RECEIPTS_WHEN_CURRENCY_ARRIVES.path).toBe("/v1.0/receipts");
    expect(RECEIPTS_WHEN_CURRENCY_ARRIVES.fieldMap.order_id).toBe("receipt_number");
    expect(RECEIPTS_WHEN_CURRENCY_ARRIVES.fieldMap.total_amount).toBe("total_money");
    expect(RECEIPTS_WHEN_CURRENCY_ARRIVES.watermark?.name).toBe("updated_at_min");
    expect(RECEIPTS_WHEN_CURRENCY_ARRIVES.query).toEqual({ limit: "250" });
  });
});

// ── customer — GET /v1.0/customers ──────────────────────────────────────────

describe("Loyverse customer — GET /v1.0/customers", () => {
  it("🔴 filters on updated_at_min and pages on cursor / cursor", async () => {
    const { connector, calls } = connectorWith([
      { body: { customers: [{ ...CUSTOMER, id: "c-1" }], cursor: CURSOR, contacts: [{ id: "decoy" }] } },
      { body: { customers: [{ ...CUSTOMER, id: "c-2" }] } },
    ]);
    const rows = rowsOf(await connector.runRead("find_customer", { since: SINCE }));

    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/v1.0/customers");
    // `GET /customers` references the shared `updated_at_min` parameter: "Show
    // resources updated after date (ISO 8601 format, e.g:
    // 2020-03-30T18:30:00.000Z)". The Customer schema carries `updated_at`
    // and the `customers.update` webhook fires on create, update and delete.
    // Mutation: `created_at_min` -> a changed email is never re-read.
    expect(first.searchParams.get("updated_at_min")).toBe(SINCE_ISO);
    expect(first.searchParams.get("limit")).toBe("250");
    expect(first.searchParams.has("created_at_min")).toBe(false);

    // ⚠ The `/customers` 200 schema in the OpenAPI document declares only
    // `customers` and omits `cursor`, while `/receipts` and `/items` declare
    // it. The generic Pagination section and the declared `cursor` REQUEST
    // parameter say the cursor is there. This fixture pins the profile's
    // reading; the first live read should confirm it.
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("cursor")).toBe(CURSOR);
    expect(second.searchParams.get("updated_at_min")).toBe(SINCE_ISO);
    expect(calls).toHaveLength(2);
    expect(rows.map((r) => r.customer_id)).toEqual(["c-1", "c-2"]);

    const customer = LOYVERSE_PROFILE.datasets.find((d) => d.dataset === "customer")!;
    expect(customer.watermark).toEqual({
      name: "updated_at_min",
      location: "query",
      format: "iso",
      complete: true,
    });
    expect(customer.pagination).toEqual({ kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" });
    expect(customer.rowsPath).toBe("customers");
    // NO `show_deleted` here: `GET /customers` declares no such parameter,
    // and sending one would be inventing a contract.
    expect(customer.query).toEqual({ limit: "250" });
  });

  it("🔴 asks for the DOCUMENTED maximum page, limit=250, on every page", async () => {
    // components.parameters.limit: default 50, maximum 250. At the default a
    // shop's customer book is several round trips at one per second; at the
    // maximum it is usually one. The page size is a CONSTANT QUERY PARAMETER —
    // the `cursor` pagination arm has no pageSize member (only limit-offset
    // and page-number do), exactly as Square's shape works.
    // Mutation: `limit: "500"` -> Loyverse's behaviour above the maximum is
    // undocumented; `limit` dropped -> 5x the requests against a shared budget.
    const { connector, calls } = connectorWith([
      { body: { customers: [CUSTOMER], cursor: CURSOR } },
      { body: { customers: [] } },
    ]);
    await connector.runRead("find_customer", { since: SINCE });
    expect(LOYVERSE_PAGE_LIMIT).toBe("250");
    for (const call of calls) expect(new URL(call.url).searchParams.get("limit")).toBe("250");
  });

  it("🔴 does NOT tolerate an absent `customers` array — the empty shape is UNVERIFIED", async () => {
    // Square omits the array on an empty result, so its specs declare
    // `absentRowsMeansEmpty`. Loyverse's documentation does not say whether an
    // empty result is `{"receipts": []}` or `{}`. The flag is left OFF
    // deliberately: with it set, a WRONG rowsPath would read as "no customers" on
    // every page of every sync, which is a confident false statement about an
    // owner's customer book. Off, a healthy-but-empty account fails LOUDLY
    // on the first read instead — and that is the failure to want until a live
    // `{}` has been observed, at which point this pin flips with the evidence.
    // Mutation: copy `absentRowsMeansEmpty: true` across from Square "for
    // symmetry" -> this goes red, and it should.
    for (const spec of LOYVERSE_PROFILE.datasets) {
      expect(spec.absentRowsMeansEmpty, spec.dataset).toBeFalsy();
    }
    const { connector } = connectorWith([{ body: {} }]);
    await expect(connector.runRead("find_customer", { since: SINCE })).rejects.toThrow(
      RestPaginationContractError,
    );

    // The DOCUMENTED empty shape — an empty array — is an empty read.
    const { connector: emptyOk } = connectorWith([{ body: { customers: [] } }]);
    expect(await emptyOk.runRead("find_customer", { since: SINCE })).toEqual([]);
  });

  it("🔴 projects id, email, total_spent and the timestamps — and NOT the name", async () => {
    // Loyverse has ONE `name` field ("The customer's name", max 64 chars).
    // The canonical vocabulary has `first_name` and `last_name`, the track has
    // no split transform, and splitting free text on a space would be a guess
    // ("Mary Ann Smith", "van der Berg"). Both stay undefined, and the name is
    // asserted ABSENT from every value so a later "helpful" pass cannot stuff
    // the whole name into `last_name`.
    //
    // `orders_count` stays undefined too: Loyverse's `total_visits` is "the
    // total number of visits", which is not documented as a receipt count.
    // Mutation: `last_name: "name"` or `orders_count: "total_visits"` -> red.
    const { connector } = connectorWith([{ body: { customers: [CUSTOMER] } }]);
    const row = rowsOf(await connector.runRead("find_customer", { since: SINCE }))[0]!;

    expect(row.customer_id).toBe("c71758a2-79bf-11ea-bde9-1269e7c5a22d");
    expect(row.email).toBe("jsmith@example.com");
    expect(row.total_spent_amount).toBe(120.55);
    expect(row.created_at).toBe("2020-03-25T19:55:23.077Z");
    expect(row.updated_at).toBe("2020-03-30T08:05:10.020Z");
    for (const column of ["first_name", "last_name", "orders_count", "currency"]) {
      expect(column in row, column).toBe(true);
      expect(row[column], column).toBeUndefined();
    }
    expect(Object.values(row)).not.toContain("John Smith");
    expect(Object.values(row)).not.toContain(3);
    expect(Object.keys(row)).toEqual([...CANONICAL_COLUMNS.customer]);
  });

  it("🔴 a NAMED customer search returns NOTHING — because the filter column is one Loyverse cannot fill", async () => {
    // `find_customer` narrows on a `last_name` PREFIX, and every filter except
    // `all` DROPS a row whose column is undefined (SQL: `NULL LIKE 'smi%'` is
    // not true). Loyverse fills no `last_name`, so "find customer Smith" is
    // honestly zero rows, while an unqualified `find_customer` lists everyone.
    //
    // Pinned so the limitation is a fact someone can read, not a support
    // ticket. The WRONG fix is `last_name: "name"` (the test above refuses
    // it); the right one is a name-search read that filters on a single
    // `name` column, which is a read-query decision, not a profile one.
    const { connector } = connectorWith([{ body: { customers: [CUSTOMER] } }]);
    expect(await connector.runRead("find_customer", { since: SINCE, query: "Smith" })).toEqual([]);
    expect(await connector.runRead("find_customer", { since: SINCE })).toHaveLength(1);
  });
});

// ── product — GET /v1.0/items ───────────────────────────────────────────────

describe("Loyverse product — GET /v1.0/items", () => {
  it("🔴 filters on updated_at_min, sends show_deleted=true on EVERY page, and pages on cursor", async () => {
    const { connector, calls } = connectorWith([
      { body: { items: [{ ...ITEM, id: "i-1" }], cursor: CURSOR, products: [{ id: "decoy" }] } },
      { body: { items: [{ ...ITEM, id: "i-2" }] } },
    ]);
    const rows = rowsOf(await connector.runRead("get_low_stock_products", { since: SINCE }));

    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/v1.0/items");
    expect(first.searchParams.get("updated_at_min")).toBe(SINCE_ISO);
    expect(first.searchParams.has("created_at_min")).toBe(false);

    // 🔴 `show_deleted=true`, and on every page. Loyverse's Soft deletion
    // section: deleted items "will not be returned by default, but can be
    // accessed using show_deleted = true filter and have deleted_at
    // parameter". Without it a deleted item simply stops appearing — it never
    // arrives under `updated_at_min` as a change — and the box keeps selling
    // it. ⚠ The shared parameter's own description is copy-pasted ("Show
    // deleted modifiers and modifier options") although `/items` references
    // it and `Item` carries `deleted_at`; the behaviour is pinned by this
    // fixture rather than by that sentence.
    // Mutation: drop `show_deleted` -> red on both calls.
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.searchParams.get("show_deleted")).toBe("true");
      expect(url.searchParams.get("limit")).toBe("250");
    }
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("cursor")).toBe(CURSOR);
    expect(calls).toHaveLength(2);
    expect(rows.map((r) => r.product_id)).toEqual(["i-1", "i-2"]);

    const product = LOYVERSE_PROFILE.datasets.find((d) => d.dataset === "product")!;
    expect(product.path).toBe("/v1.0/items");
    expect(product.query).toEqual({ limit: "250", show_deleted: "true" });
    expect(product.watermark).toEqual({
      name: "updated_at_min",
      location: "query",
      format: "iso",
      complete: true,
    });
    expect(product.pagination).toEqual({ kind: "cursor", nextCursorPath: "cursor", cursorParam: "cursor" });
    expect(product.rowsPath).toBe("items");
  });

  it("🔴 takes sku and price from the FIRST variant — knowingly lossy for multi-variant items", async () => {
    // A canonical `product` row holds one sku and one price. A Loyverse item
    // with size/colour options has SEVERAL variants, each with its own sku
    // and `default_price`, and this fixture has two. `variants[0]` keeps the
    // first and the fact that `10011` at 12.50 also exists is NOT
    // representable here. That loss is deliberate and recorded, per the
    // bracket-index rule in `readPath`.
    // Mutation: `variants[1].sku`, or join the skus into "10010,10011" -> red;
    // a text column holding two skus is not a sku.
    const { connector } = connectorWith([{ body: { items: [ITEM] } }]);
    const row = rowsOf(await connector.runRead("get_low_stock_products", { since: SINCE }))[0]!;

    expect(row.product_id).toBe("d5fe0da6-44b3-4633-9915-e9dc5118cbfc");
    expect(row.title).toBe("T-shirt");
    expect(row.sku).toBe("10010");
    expect(row.price_amount).toBe(10);
    expect(row.created_at).toBe("2020-03-25T19:55:23.077Z");
    expect(row.updated_at).toBe("2020-03-30T08:05:10.020Z");
    expect(Object.values(row)).not.toContain("10011");
    expect(Object.values(row)).not.toContain(12.5);
    expect(Object.keys(row)).toEqual([...CANONICAL_COLUMNS.product]);
  });

  it("🔴 a VARIABLE-priced variant has NO price, and it stays undefined rather than 0", async () => {
    // `default_price` is documented null when `default_pricing_type` is
    // VARIABLE (the price is typed at the till). `0` there would read as
    // "this item is free". `undefined` is the honest projection.
    // Mutation: `price_amount: { path: ..., default: 0 }` (no such field
    // exists, and this is why) -> red.
    const variable = {
      ...ITEM,
      variants: [{ ...ITEM.variants[0], default_pricing_type: "VARIABLE", default_price: null }],
    };
    const { connector } = connectorWith([{ body: { items: [variable] } }]);
    const row = rowsOf(await connector.runRead("get_low_stock_products", { since: SINCE }))[0]!;
    expect(row.sku).toBe("10010");
    expect("price_amount" in row).toBe(true);
    expect(row.price_amount).toBeUndefined();
  });

  it("🔴 leaves currency, inventory_quantity and status UNDEFINED — and a deleted item still arrives", async () => {
    //  • `currency` — per merchant, not per row; optional on `product`, which
    //    is why this dataset ships and `order` does not (see the order block).
    //  • `inventory_quantity` — stock lives on `GET /v1.0/inventory`, per
    //    variant per store, a second endpoint this track cannot join.
    //  • `status` — there is no status field. `deleted_at` is a timestamp, and
    //    a timestamp is not a status; `variants[].stores[].available_for_sale`
    //    is per store per variant.
    //
    // And a soft-deleted item (`deleted_at` set) is projected like any other
    // — that is what `show_deleted=true` is FOR: the deletion reaches the box
    // as an update to an existing row rather than as a row that quietly
    // stopped arriving. What the consumer does with it is not this profile's
    // decision; that it arrives is.
    // Mutation: `status: "deleted_at"` -> red.
    const deleted = { ...ITEM, id: "i-gone", deleted_at: "2026-09-10T12:00:00.000Z" };
    const { connector } = connectorWith([{ body: { items: [ITEM, deleted] } }]);
    const rows = rowsOf(await connector.runRead("get_low_stock_products", { since: SINCE }));
    expect(rows.map((r) => r.product_id).sort()).toEqual(["d5fe0da6-44b3-4633-9915-e9dc5118cbfc", "i-gone"]);
    for (const row of rows) {
      for (const column of ["currency", "inventory_quantity", "status"]) {
        expect(column in row, column).toBe(true);
        expect(row[column], column).toBeUndefined();
      }
    }
    expect(Object.values(rows[1]!)).not.toContain("2026-09-10T12:00:00.000Z");
  });

  it("🔴 a low-stock question returns NOTHING — the threshold column is one Loyverse cannot fill", async () => {
    // `get_low_stock_products` narrows on `inventory_quantity <= threshold`,
    // and a row with no `inventory_quantity` is dropped by the filter. So
    // "what is running low" is honestly zero rows from Loyverse, while an
    // unqualified read lists the catalogue. Pinned for the same reason as the
    // customer search: a limitation someone can read. The right fix is a
    // second endpoint (`/v1.0/inventory`) the track cannot express today, not
    // a fabricated quantity.
    const { connector } = connectorWith([{ body: { items: [ITEM] } }]);
    expect(await connector.runRead("get_low_stock_products", { since: SINCE, threshold: 5 })).toEqual([]);
    expect(await connector.runRead("get_low_stock_products", { since: SINCE })).toHaveLength(1);
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 🔴 ADR-046 §3 and `rest-track.test.ts`'s own header state the rule: **a
 * refusal asserts `fetch` was called ZERO times**, never merely that an error
 * was thrown. A test that inspected only the returned error would still pass if
 * the request had already gone out carrying the owner's token — a token that,
 * on Loyverse, can create receipts and delete customers.
 */
describe("Loyverse — the refusals, each costing ZERO fetch calls", () => {
  /** The real profile with a resolver that yields exactly what is passed. */
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([{ body: { customers: [] } }]);
    const connector = new RestProfileConnector(
      LOYVERSE_PROFILE,
      { provider: LOYVERSE_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses a read when the stored credential has no accessToken — ZERO fetch calls", async () => {
    // The shape a real connection reaches this in: the descriptor's field was
    // renamed, or the owner's secret was purged on disconnect and the row
    // survived. Sending the literal `{{accessToken}}` would land in Loyverse's
    // logs as a failed auth nobody can explain.
    // Mutation: fall back to "" instead of refusing an empty placeholder ->
    // the request goes out and the call count goes to 1.
    const { connector, calls } = connectorWithCredentials({});
    await expect(connector.runRead("find_customer", { since: SINCE })).rejects.toThrow(
      /has no "accessToken"/,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a blank accessToken as firmly as a missing one — ZERO fetch calls", async () => {
    // Whitespace is what a paste box produces. An empty Authorization header
    // is a request that cannot succeed, and Loyverse's budget is 300 per five
    // minutes PER ACCOUNT, so spending a call to learn that costs the owner's
    // every other integration as well as the round trip.
    const { connector, calls } = connectorWithCredentials({ accessToken: "\t \n" });
    await expect(connector.connect()).rejects.toThrow(/has no "accessToken"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a dataset Loyverse does not serve — ZERO fetch calls, and NOT an empty array", async () => {
    // This profile serves `customer` and `product` and nothing else. Asked
    // for orders (see the order block), money (charges, refunds — which
    // Loyverse folds into receipts), a schedule or a patient record, the
    // connection refuses by NAME. `[]` would be a confident false statement no
    // caller can tell from a genuinely empty result.
    // Mutation: make `runRead` fall through to an empty array -> red.
    for (const name of [
      "get_recent_orders",
      "get_recent_charges",
      "get_refunds",
      "get_bookings",
      "get_ar_summary",
    ]) {
      const { connector, calls } = connectorWithCredentials({ accessToken: ACCESS_TOKEN });
      await expect(connector.runRead(name, { since: SINCE }), name).rejects.toThrow(
        DatasetNotServedError,
      );
      expect(calls, name).toHaveLength(0);
    }
  });

  it("🔴 refuses every write, and spends no call finding out — the track is read-only", async () => {
    // ADR-046 §4. This matters MORE for Loyverse than for most: the PAT is
    // "unlimited access", so the token in the box could create a receipt or
    // delete a customer. The refusal is the track's, not the vendor's, and it
    // costs no request.
    const { connector, calls } = connectorWithCredentials({ accessToken: ACCESS_TOKEN });
    await expect(connector.applyWrite("reschedule_appointment", {})).rejects.toThrow(
      ConnectorBlockedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses to build against a provider id that is not Loyverse's — ZERO fetch calls", async () => {
    // A row naming one provider and dispatched to another must fail at
    // CONSTRUCTION, before a credential is resolved.
    const { impl, calls } = stubFetch([{ body: { customers: [] } }]);
    expect(
      () =>
        new RestProfileConnector(
          LOYVERSE_PROFILE,
          { provider: "square" },
          { fetchImpl: impl, resolveCredentials: async () => ({ accessToken: ACCESS_TOKEN }) },
        ),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a 302 rather than following it off api.loyverse.com", async () => {
    // `fetch` defaults to following redirects, so without `redirect: "error"`
    // the guard would be checking a URL while the answer chose the destination
    // — with the owner's UNLIMITED token attached, and with a response body
    // that carries customer names, emails, phone numbers and addresses.
    // EXACTLY ONE call: the redirect was not followed.
    const { connector, calls } = connectorWith([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/v1.0/customers" } },
    ]);
    await expect(connector.runRead("find_customer", { since: SINCE })).rejects.toThrow(
      UnsafeBaseUrlError,
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.loyverse.com");
  });
});
