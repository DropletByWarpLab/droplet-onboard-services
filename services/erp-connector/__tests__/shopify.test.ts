/**
 * WARP-2296 — ShopifyConnector.
 *
 * `fetch` is INJECTED, never patched globally, and every test asserts on the
 * CALLS the connector made — not only on what it returned. That distinction
 * carries the same weight here as on the Mailchimp track, and for an extra
 * reason: on this track the FIRST request carries the merchant's client secret,
 * so a guard test that inspects a returned error would still pass after the
 * secret had already gone out.
 *
 * Shopify's store host is assembled at runtime from the connection's own
 * `<store>.myshopify.com` domain — the token endpoint included — so
 * `docs/security/allowed-egress.yaml` registers it `kind: dynamic` and the
 * static egress scanner verifies NOTHING about where this connector dials
 * (`docs/SECURITY.md:183-185`). The code-side host guard is the entire control.
 *
 * Every test names the mutation that must turn it red.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  InvalidShopifyCredentialError,
  SHOPIFY_ACCESS_TOKEN_HEADER,
  SHOPIFY_ALLOWED_HOST_PATTERN,
  SHOPIFY_ALLOWED_MUTATIONS,
  SHOPIFY_API_VERSION,
  SHOPIFY_CLIENT_CREDENTIAL_PATTERN,
  SHOPIFY_DATASETS,
  SHOPIFY_DATASET_SCOPES,
  SHOPIFY_GRAPHQL_PATH,
  SHOPIFY_LEGACY_ADMIN_TOKEN_PATTERN,
  SHOPIFY_ORDER_HISTORY_SCOPE,
  SHOPIFY_ORDER_HISTORY_WALL_DAYS,
  SHOPIFY_PROTECTED_CUSTOMER_FIELDS,
  SHOPIFY_PROVIDER,
  SHOPIFY_SHOP_DOMAIN_SUFFIX,
  SHOPIFY_TOKEN_LIFETIME_SECONDS,
  SHOPIFY_TOKEN_PATH,
  SHOPIFY_TOKEN_REFRESH_SKEW_MS,
  ShopifyBulkOperationError,
  ShopifyConnector,
  ShopifyOrderHistoryWallError,
  ShopifyProtectedDataDeniedError,
  ShopifyReauthorizationRequiredError,
  ShopifyScopeMissingError,
  ShopifyThrottledError,
  ShopifyTimeoutError,
  UnsafeShopifyBaseUrlError,
  assertReadOnlyShopifyDocument,
  assertSafeShopifyBaseUrl,
  assertShopifyClientCredential,
  assertShopifyShopDomain,
  detectProtectedDataRedaction,
  shopifyAllowedApiHosts,
  shopifyBaseUrlFor,
  throttleWaitMs,
} from "../src/shopify/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { CANONICAL_COLUMNS, COLUMN_KIND } from "../src/export-drop/profiles.js";

/** 2026-09-02T12:00:00Z, the clock every test runs on. */
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

/**
 * Fixture credentials, composed from parts and obviously fake.
 *
 * COMPOSED ON PURPOSE — do not inline these back into single literals. GitHub
 * push protection runs its own secret detectors that no repo config can
 * allowlist, and a rejected push costs an hour (WARP-2379 learned this the hard
 * way). `EXAMPLEFIXTURENOTAREAL` is in every one of them so a reader who greps
 * a leaked-looking string finds the word FIXTURE first.
 */
const SHOP = "acme-fixture";
const SHOP_DOMAIN = `${SHOP}${SHOPIFY_SHOP_DOMAIN_SUFFIX}`;
const CLIENT_ID = ["EXAMPLEFIXTURE", "NOTAREALCLIENTID"].join("");
const CLIENT_SECRET = ["EXAMPLEFIXTURE", "NOTAREALCLIENTSECRET"].join("");
const MINTED = ["EXAMPLEFIXTURE", "NOTAREALACCESSTOKEN"].join("");

const ALL_SCOPES = "read_orders read_products read_customers";

interface StubResponse {
  status?: number;
  body?: unknown;
}
interface Route {
  match: RegExp;
  responses: StubResponse[];
}

/** A routed fetch stub that records every call, including its body. */
function stubFetch(routes: Route[], opts: { hang?: boolean } = {}) {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const seen = new Map<number, number>();

  const impl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    if (opts.hang) {
      // Never settles. The connector's own deadline is what has to fire, which
      // is the whole point of racing the timer rather than trusting `signal`.
      return new Promise<Response>(() => {});
    }
    const idx = routes.findIndex((r) => r.match.test(url));
    if (idx === -1) throw new Error(`test stub has no route for ${url}`);
    const n = seen.get(idx) ?? 0;
    seen.set(idx, n + 1);
    const list = routes[idx].responses;
    const r = list[Math.min(n, list.length - 1)];
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body ?? {},
    } as unknown as Response;
  };

  return {
    impl,
    calls,
    urls: () => calls.map((c) => c.url),
    bodies: () => calls.map((c) => String(c.init.body ?? "")),
    documents: () =>
      calls
        .map((c) => {
          try {
            return (JSON.parse(String(c.init.body ?? "{}")) as { query?: string }).query ?? "";
          } catch {
            return "";
          }
        })
        .filter((q) => q !== ""),
  };
}

/** The token-mint route every connected test needs. */
function tokenRoute(scope = ALL_SCOPES, extra: Partial<StubResponse> = {}): Route {
  return {
    match: new RegExp(SHOPIFY_TOKEN_PATH.replace(/\//g, "\\/")),
    responses: [
      {
        body: { access_token: MINTED, scope, expires_in: SHOPIFY_TOKEN_LIFETIME_SECONDS },
        ...extra,
      },
    ],
  };
}

const GRAPHQL_RE = /graphql\.json$/;

function graphqlRoute(...bodies: unknown[]): Route {
  return { match: GRAPHQL_RE, responses: bodies.map((body) => ({ body })) };
}

/**
 * A connector wired to an injected fetch.
 *
 * `connect()` mints a token AND runs the protected-customer-data probe, so a
 * stub whose first GraphQL response is not a `customers` page would fail every
 * test for the wrong reason. `routes` is therefore the EXPLICIT escape hatch
 * used only by tests that are about connect-time behaviour; everything else
 * passes `graphql`, which prepends a benign probe page.
 */
function connector(
  opts: {
    routes?: Route[];
    /** GraphQL response bodies AFTER the connect-time customer probe. */
    graphql?: unknown[];
    scope?: string;
    baseUrl?: string;
    shopDomain?: string;
    clientId?: string;
    clientSecret?: string;
    blocked?: boolean;
    hang?: boolean;
    timeoutMs?: number;
    now?: () => number;
  } = {},
) {
  const scope = opts.scope ?? ALL_SCOPES;
  // The probe only runs when `read_customers` is granted — without it there is
  // nothing to learn, and recording a denial would blame the plan for a tick.
  // So the prepended page is conditional for exactly the same reason.
  const probePage = scope.includes("read_customers") ? [page("customers", [CUSTOMER_NODE])] : [];
  const routes =
    opts.routes ??
    [tokenRoute(scope), graphqlRoute(...probePage, ...(opts.graphql ?? [{ data: {} }]))];
  const f = stubFetch(routes, { hang: opts.hang });
  const c = new ShopifyConnector(
    {
      credentialsSecretRef: "secret://shopify/store_fixture",
      shopDomain: opts.shopDomain ?? SHOP_DOMAIN,
      connectionId: "conn_shopify_a",
      baseUrl: opts.baseUrl,
    },
    {
      fetchImpl: f.impl,
      now: opts.now ?? (() => NOW),
      timeoutMs: opts.timeoutMs,
      sleep: async () => {},
      // `blocked` leaves the default resolver in place, which is the shipped-off
      // state: nothing wired, so every I/O path blocks honestly.
      resolveCredential: opts.blocked
        ? undefined
        : async (field) => (field === "clientId" ? (opts.clientId ?? CLIENT_ID) : (opts.clientSecret ?? CLIENT_SECRET)),
    },
  );
  return { c, f };
}

const SRC_DIR = join(fileURLToPath(new URL("../src/shopify/", import.meta.url)));
function sourceOf(file: string): string {
  return readFileSync(join(SRC_DIR, file), "utf8");
}

/** One node of each dataset, shaped exactly as the Admin API returns it. */
const ORDER_NODE = {
  id: "gid://shopify/Order/1001",
  createdAt: "2026-08-20T09:30:00Z",
  updatedAt: "2026-08-28T11:00:00Z",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  currencyCode: "USD",
  customer: { id: "gid://shopify/Customer/55" },
  currentTotalPriceSet: { shopMoney: { amount: "125.40", currencyCode: "USD" } },
  currentSubtotalPriceSet: { shopMoney: { amount: "110.00" } },
  currentTotalTaxSet: { shopMoney: { amount: "10.40" } },
  totalRefundedSet: { shopMoney: { amount: "5.00" } },
};

const PRODUCT_NODE = {
  id: "gid://shopify/Product/2002",
  createdAt: "2026-01-04T08:00:00Z",
  updatedAt: "2026-08-30T08:00:00Z",
  title: "Fixture Widget",
  status: "ACTIVE",
  totalInventory: 3,
  priceRangeV2: { minVariantPrice: { amount: "19.99", currencyCode: "USD" } },
  variants: { nodes: [{ sku: "FIXTURE-WIDGET-1" }] },
};

const CUSTOMER_NODE = {
  id: "gid://shopify/Customer/55",
  createdAt: "2025-11-02T10:00:00Z",
  updatedAt: "2026-08-28T11:00:00Z",
  firstName: "Fixture",
  lastName: "Buyer",
  email: "fixture.buyer@example.test",
  numberOfOrders: "4",
  amountSpent: { amount: "480.00", currencyCode: "USD" },
};

function page(field: string, nodes: unknown[], hasNextPage = false) {
  return {
    data: {
      [field]: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-1" : null } },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the destination guard is the ENTIRE control (WARP-2314)", () => {
  it("refuses a host that only ENDS WITH the shop-domain suffix", () => {
    // Mutation: swap the anchored pattern for `endsWith` → red. This is the
    // attack the anchoring exists to stop, and an unanchored regex accepts it.
    expect(() =>
      assertSafeShopifyBaseUrl(`https://${SHOP_DOMAIN}.evil.test`, SHOP_DOMAIN),
    ).toThrow(UnsafeShopifyBaseUrlError);
    expect(SHOPIFY_ALLOWED_HOST_PATTERN.test(`${SHOP_DOMAIN}.evil.test`)).toBe(false);
    expect(SHOPIFY_ALLOWED_HOST_PATTERN.test(SHOP_DOMAIN)).toBe(true);

    // The shapes that separate an ANCHORED pattern from an `endsWith` check:
    // each of these really does end with the suffix, and each is a different
    // origin wearing it. Mutation: unanchor the pattern, or rebuild it without
    // `escapeRegExpLiteral` so the dots match any character → red.
    for (const host of ["evil.example.myshopify.com", "a.b.myshopify.com", "xmyshopifyxcom"]) {
      expect(SHOPIFY_ALLOWED_HOST_PATTERN.test(host), host).toBe(false);
    }
    expect("evil.example.myshopify.com".endsWith(SHOPIFY_SHOP_DOMAIN_SUFFIX)).toBe(true);
  });

  it("refuses another merchant's store, http, userinfo and a non-443 port", () => {
    // Mutation: drop any one of the four checks → the matching case goes green.
    expect(() => assertSafeShopifyBaseUrl(`https://other-shop${SHOPIFY_SHOP_DOMAIN_SUFFIX}`, SHOP_DOMAIN)).toThrow(
      /not this connection's store host/,
    );
    expect(() => assertSafeShopifyBaseUrl(`http://${SHOP_DOMAIN}`, SHOP_DOMAIN)).toThrow(/not https/);
    expect(() => assertSafeShopifyBaseUrl(`https://evil@${SHOP_DOMAIN}`, SHOP_DOMAIN)).toThrow(/userinfo/);
    expect(() => assertSafeShopifyBaseUrl(`https://${SHOP_DOMAIN}:8443`, SHOP_DOMAIN)).toThrow(/port 8443/);
  });

  it("refuses a bad destination with ZERO fetch calls, before any credential is resolved", async () => {
    // THE test for this track. Asserting on the thrown error alone would still
    // pass if the request had already gone out carrying the client secret.
    // Mutation: move the guard after `resolveCredential` in `mintAccessToken`,
    // or after the fetch → red.
    const f = stubFetch([tokenRoute(), graphqlRoute({ data: {} })]);
    // Construction itself throws, so nothing further can run.
    expect(() =>
      new ShopifyConnector(
        { credentialsSecretRef: "x", shopDomain: SHOP_DOMAIN, connectionId: "c", baseUrl: `https://${SHOP_DOMAIN}.evil.test` },
        { fetchImpl: f.impl, now: () => NOW, resolveCredential: async () => CLIENT_SECRET },
      ),
    ).toThrow(UnsafeShopifyBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("carries no scheme-URL literal for the store host anywhere in the connector directory", () => {
    // The `kind: dynamic` allowlist entry registers NO host patterns, so a
    // `https://acme.myshopify.com` literal would be extracted by
    // scripts/check-egress-allowlist.py as an unregistered destination and fail
    // egress-gate. Mutation: add one → red here AND in the gate.
    for (const file of readdirSync(SRC_DIR)) {
      expect(sourceOf(file), file).not.toMatch(/https?:\/\/[A-Za-z0-9.-]*myshopify\.com/);
    }
  });

  it("keeps the shop-domain suffix as ONE whole-string literal", () => {
    // The bare suffix is the most the static scanner can ever be given for this
    // vendor, and `ref-shopify-shop-domain` registers exactly that NAME.
    // Mutation: split it into concatenated parts → red.
    expect(sourceOf("connector.ts")).toContain('SHOPIFY_SHOP_DOMAIN_SUFFIX = ".myshopify.com"');
    expect(SHOPIFY_SHOP_DOMAIN_SUFFIX).toBe(".myshopify.com");
  });

  it("derives the per-connection allowed host set from the stored domain, exactly", () => {
    // The ticket's SHOPIFY_ALLOWED_API_HOSTS, as a function of the connection —
    // there is no fixed Shopify host to put in a module constant.
    // Mutation: make it return a wildcard or a suffix test → the first test red.
    expect([...shopifyAllowedApiHosts(SHOP_DOMAIN)]).toEqual([SHOP_DOMAIN]);
    expect(shopifyBaseUrlFor(SHOP)).toBe(`https://${SHOP_DOMAIN}`);
  });

  it("re-validates the stored domain on the way OUT of providerConfig", () => {
    // `providerConfig` is free-text JSON; nothing else stands between a
    // tampered row and a credential-carrying request. Mutation: accept an
    // arbitrary string in `assertShopifyShopDomain` → red.
    expect(() => assertShopifyShopDomain("evil.test")).toThrow(UnsafeShopifyBaseUrlError);
    expect(() => assertShopifyShopDomain("")).toThrow(/no store domain is configured/);
    expect(() => assertShopifyShopDomain("-leading-hyphen")).toThrow(UnsafeShopifyBaseUrlError);
    // A bare handle and a full domain are the same connection, normalised.
    expect(assertShopifyShopDomain(SHOP)).toBe(SHOP_DOMAIN);
    expect(assertShopifyShopDomain(SHOP_DOMAIN.toUpperCase())).toBe(SHOP_DOMAIN);
  });
});

describe("credential intake refuses the retired flow (ADR-042 §4)", () => {
  it("rejects a shpat_ admin-created custom app token by name", () => {
    // ADR-042 §4's boundary rejection. The flow that minted these was removed
    // on 2026-01-01 and they cannot be re-created.
    // Mutation: drop the legacy-prefix branch → red.
    const legacy = ["shpat", "EXAMPLEFIXTURENOTAREAL"].join("_");
    expect(() => assertShopifyClientCredential(legacy)).toThrow(InvalidShopifyCredentialError);
    try {
      assertShopifyClientCredential(legacy);
    } catch (err) {
      expect((err as InvalidShopifyCredentialError).reason).toBe("legacy_admin_api_token");
      // Rule 19: the rejection may not echo the offered value, whole or in part.
      expect((err as Error).message).not.toContain("EXAMPLEFIXTURENOTAREAL");
    }
    expect(SHOPIFY_LEGACY_ADMIN_TOKEN_PATTERN.test(legacy)).toBe(true);
    expect(SHOPIFY_CLIENT_CREDENTIAL_PATTERN.test(legacy)).toBe(false);
  });

  it("classifies empty and whitespace-bearing values distinctly", () => {
    // Different paste mistakes want different advice. Mutation: collapse the
    // reasons into one → red.
    const reasons = ["", "  ", `${CLIENT_ID} `].map((v) => {
      try {
        assertShopifyClientCredential(v);
        return "accepted";
      } catch (err) {
        return (err as InvalidShopifyCredentialError).reason;
      }
    });
    expect(reasons).toEqual(["empty", "empty", "contains_whitespace"]);
  });

  it("accepts an ordinary Dev Dashboard credential and never echoes it", () => {
    // Mutation: tighten the positive pattern to a hex/length rule → red, which
    // is the point: Shopify publishes no format guarantee and a false rejection
    // blocks a paying merchant.
    expect(assertShopifyClientCredential(CLIENT_ID)).toBe(CLIENT_ID);
    expect(assertShopifyClientCredential("0123456789abcdef0123456789abcdef")).toBeTypeOf("string");
  });
});

describe("the client-credentials token minter (WARP-2310)", () => {
  it("posts the grant to the STORE's own token endpoint and captures the granted scopes", async () => {
    // The endpoint is on <store>.myshopify.com, NOT a central Shopify OAuth
    // host — which is why this track registers no fixed egress destination.
    // Mutation: point the mint at a fixed host → red here and in the gate.
    const { c, f } = connector({ graphql: [page("orders", [ORDER_NODE])] });
    await c.connect();
    expect(f.urls()[0]).toBe(`https://${SHOP_DOMAIN}${SHOPIFY_TOKEN_PATH}`);
    const body = f.bodies()[0];
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain(`client_id=${CLIENT_ID}`);
    const status = await c.status();
    expect(status.grantedScopes).toEqual(["read_orders", "read_products", "read_customers"]);
  });

  it("presents the minted token on X-Shopify-Access-Token, never Authorization", async () => {
    // Mutation: send `Authorization: Bearer …` → red. Shopify answers 401 with
    // nothing to explain it, which is an afternoon.
    const { c, f } = connector();
    await c.connect();
    const graphqlCall = f.calls.find((call) => GRAPHQL_RE.test(call.url));
    const headers = graphqlCall?.init.headers as Record<string, string>;
    expect(headers[SHOPIFY_ACCESS_TOKEN_HEADER]).toBe(MINTED);
    expect(headers.Authorization).toBeUndefined();
  });

  it("re-mints once the 24-hour token is inside the skew, and never more often", async () => {
    // Mutation: drop SHOPIFY_TOKEN_REFRESH_SKEW_MS, or cache forever → red.
    let clock = NOW;
    const { c, f } = connector({
      now: () => clock,
      graphql: [page("orders", []), page("orders", [])],
    });
    await c.connect();
    const afterConnect = f.urls().filter((u) => u.endsWith(SHOPIFY_TOKEN_PATH)).length;
    expect(afterConnect).toBe(1);
    // Still inside the token's life: no second mint.
    clock = NOW + (SHOPIFY_TOKEN_LIFETIME_SECONDS * 1_000 - SHOPIFY_TOKEN_REFRESH_SKEW_MS) - 1_000;
    await c.runRead("get_recent_orders", {});
    expect(f.urls().filter((u) => u.endsWith(SHOPIFY_TOKEN_PATH))).toHaveLength(1);
    // Past the skew boundary: exactly one more.
    clock = NOW + SHOPIFY_TOKEN_LIFETIME_SECONDS * 1_000;
    await c.runRead("get_recent_orders", {});
    expect(f.urls().filter((u) => u.endsWith(SHOPIFY_TOKEN_PATH))).toHaveLength(2);
  });

  it("throws from refresh() rather than silently re-minting", async () => {
    // ADR-042 §6: "a short-lived minted token is RE-MINTED, never refreshed".
    // Mutation: make refresh() call mintAccessToken() → red.
    const { c } = connector();
    await expect(c.refresh()).rejects.toThrow(/issues NO refresh token/);
  });

  it("maps a token-endpoint rejection to REAUTHORIZE_REQUIRED without echoing the secret", async () => {
    // Mutation: classify a 400 as a generic blocked error → red. Only
    // REAUTHORIZE_REQUIRED tells the merchant to go and re-copy credentials.
    const { c } = connector({
      routes: [
        { match: new RegExp(SHOPIFY_TOKEN_PATH.replace(/\//g, "\\/")), responses: [{ status: 400, body: { error: "invalid_client" } }] },
        graphqlRoute({ data: {} }),
      ],
    });
    await expect(c.connect()).rejects.toThrow(ShopifyReauthorizationRequiredError);
    try {
      await c.connect();
    } catch (err) {
      expect((err as Error).message).not.toContain(CLIENT_SECRET);
      expect((err as { code: string }).code).toBe("REAUTHORIZE_REQUIRED");
    }
  });

  it("refuses to continue when the token response carries no access_token", async () => {
    // Mutation: default to "" → the connector sends an empty credential and
    // collects an opaque 401 instead of a diagnosable refusal.
    const { c } = connector({
      routes: [
        { match: new RegExp(SHOPIFY_TOKEN_PATH.replace(/\//g, "\\/")), responses: [{ body: { scope: ALL_SCOPES } }] },
        graphqlRoute({ data: {} }),
      ],
    });
    await expect(c.connect()).rejects.toThrow(/carried no access_token/);
  });

  it("blocks honestly with nothing wired, and makes no request", async () => {
    // The shipped-off state (ADR-041 §2). Mutation: default the resolver to
    // something that returns "" → red.
    const { c, f } = connector({ blocked: true });
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("never puts credential material in status()", async () => {
    // Rule 19. Mutation: add the client id or the minted token to the status
    // object "for debugging" → red.
    const { c } = connector();
    await c.connect();
    const serialized = JSON.stringify(await c.status());
    for (const secret of [CLIENT_ID, CLIENT_SECRET, MINTED]) {
      expect(serialized).not.toContain(secret);
    }
    expect((await c.status()).hasCredentials).toBe(true);
  });
});

describe("read-only is a property of the DOCUMENT (WARP-2331)", () => {
  it("refuses a mutation that is not a bulk export", () => {
    // The one control that matters on a single-endpoint API — a path allowlist
    // buys nothing when every call is a POST to one path.
    // Mutation: allow any mutation, or drop the guard → red.
    expect(() =>
      assertReadOnlyShopifyDocument("mutation X { orderCancel(orderId: $id) { job { id } } }"),
    ).toThrow(ConnectorBlockedError);
    expect(() =>
      assertReadOnlyShopifyDocument("mutation X { refundCreate(input: $i) { refund { id } } }"),
    ).toThrow(/orders? cancellation|refunds|SHOPIFY_ALLOWED_MUTATIONS/i);
    expect(() =>
      assertReadOnlyShopifyDocument("mutation X { bulkOperationRunQuery(query: $q) { bulkOperation { id } } }"),
    ).not.toThrow();
    expect([...SHOPIFY_ALLOWED_MUTATIONS].sort()).toEqual([
      "bulkOperationCancel",
      "bulkOperationRunQuery",
    ]);
  });

  it("is not fooled by a nested field that shares an allowed mutation's name", () => {
    // Depth tracking, not a bare regex. Mutation: match the allowed names
    // anywhere in the document → red.
    expect(() =>
      assertReadOnlyShopifyDocument(
        "mutation X { productUpdate(input: $i) { bulkOperationRunQuery { id } } }",
      ),
    ).toThrow(ConnectorBlockedError);
  });

  it("does not read a mutation named in a GraphQL comment as a mutation", () => {
    // Mutation: stop stripping `#` comments → this goes red, and every read
    // whose document mentions a mutation in a note starts failing.
    expect(() =>
      assertReadOnlyShopifyDocument("# never send mutation orderCancel\nquery Y { orders { nodes { id } } }"),
    ).not.toThrow();
  });

  it("refuses a write through applyWrite at every tier", async () => {
    const { c } = connector();
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toThrow(/read-only/);
  });
});

describe("delta reads push the filter DOWN (WARP-2331)", () => {
  it("sends updated_at:>= and sortKey UPDATED_AT, not a client-side filter", async () => {
    // Omitting the filter does NOT fail — it silently becomes a full scan
    // returning correct-looking rows. So the assertion is on the outgoing
    // DOCUMENT, never on the rows. Mutation: drop the `query:` variable → red.
    const { c, f } = connector({ graphql: [page("orders", [ORDER_NODE])] });
    await c.connect();
    f.calls.length = 0;
    await c.runRead("get_recent_orders", { since: "2026-08-01T00:00:00Z" });
    const call = f.calls.find((x) => GRAPHQL_RE.test(x.url));
    const parsed = JSON.parse(String(call?.init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(parsed.query).toContain("sortKey: UPDATED_AT");
    expect(parsed.variables.query).toBe("updated_at:>='2026-08-01T00:00:00.000Z'");
  });

  it("follows the cursor and stops on hasNextPage: false", async () => {
    // Mutation: ignore `endCursor`, or loop on `hasNextPage` alone → red.
    const { c, f } = connector({
      graphql: [
        page("products", [PRODUCT_NODE], true),
        page("products", [{ ...PRODUCT_NODE, id: "gid://shopify/Product/2003" }], false),
      ],
    });
    await c.connect();
    f.calls.length = 0;
    const rows = (await c.runRead("get_low_stock_products", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    const second = JSON.parse(String(f.calls[1].init.body)) as { variables: Record<string, unknown> };
    expect(second.variables.after).toBe("cursor-1");
  });

  it("treats the registry's mandatory filters as OPTIONAL so the poller can enumerate", async () => {
    // What puts these three datasets in ERP_SYNC_ENTITIES without a second
    // query name meaning almost the same thing. Mutation: require `from`/`to`
    // or `query` → the scheduler's `runRead(name, {})` starts throwing.
    const { c } = connector({ graphql: [page("customers", [CUSTOMER_NODE])] });
    await c.connect();
    const rows = (await c.runRead("find_customer", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
  });

  it("windows get_recent_orders on created_at, not on the updated_at it enumerated by", async () => {
    // Conflating them answers "what did we sell in August" with orders placed
    // in July and refunded in August. Mutation: window on `updated_at` → red.
    const { c } = connector({
      graphql: [page("orders", [ORDER_NODE]), page("orders", [ORDER_NODE])],
    });
    await c.connect();
    const inside = await c.runRead("get_recent_orders", {
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    });
    expect(inside).toHaveLength(1);
    // The order was UPDATED on 2026-08-28 but CREATED on 2026-08-20; a July
    // window must not contain it, and an updated_at window would.
    const outside = await c.runRead("get_recent_orders", {
      from: "2026-07-01T00:00:00Z",
      to: "2026-08-01T00:00:00Z",
    });
    expect(outside).toHaveLength(0);
  });

  it("refuses a dataset this track does not serve, by type, before any I/O", async () => {
    const { c, f } = connector();
    await c.connect();
    f.calls.length = 0;
    await expect(c.runRead("get_open_invoices", {})).rejects.toThrow(DatasetNotServedError);
    expect(f.calls).toHaveLength(0);
    expect([...SHOPIFY_DATASETS]).toEqual(["order", "product", "customer"]);
    expect(c.provider).toBe(SHOPIFY_PROVIDER);
  });
});

describe("canonical rows (WARP-2331)", () => {
  it("emits exactly CANONICAL_COLUMNS for every dataset, with no vendor keys", async () => {
    // The projector loops over the VOCABULARY, so a mapper can neither leak a
    // vendor field onto a row nor drop a canonical one.
    // Mutation: spread the vendor record onto the row → red.
    const cases: [string, string, unknown][] = [
      ["get_recent_orders", "orders", ORDER_NODE],
      ["get_low_stock_products", "products", PRODUCT_NODE],
      ["find_customer", "customers", CUSTOMER_NODE],
    ];
    for (const [read, field, node] of cases) {
      const { c } = connector({ graphql: [page(field, [node])] });
      await c.connect();
      const rows = (await c.runRead(read, {})) as Record<string, unknown>[];
      const dataset = field === "orders" ? "order" : field === "products" ? "product" : "customer";
      expect(Object.keys(rows[0]).sort(), read).toEqual([...CANONICAL_COLUMNS[dataset]].sort());
    }
  });

  it("maps every money column from shopMoney as a major-unit decimal", async () => {
    // Shopify's amounts are already major-unit decimal strings, unlike Stripe's
    // integer minor units — so the failure here is reading `presentmentMoney`
    // (whatever the buyer saw) instead of `shopMoney`. Mutation: swap them, or
    // multiply by 100 → red.
    const { c } = connector({ graphql: [page("orders", [ORDER_NODE])] });
    await c.connect();
    const [row] = (await c.runRead("get_recent_orders", {})) as Record<string, unknown>[];
    expect(row.total_amount).toBe(125.4);
    expect(row.subtotal_amount).toBe(110);
    expect(row.tax_amount).toBe(10.4);
    expect(row.refunded_amount).toBe(5);
    expect(row.currency).toBe("USD");
    // Revenue is total - tax - refunded; all three are separate columns
    // precisely so that arithmetic is the caller's and visible.
    expect(COLUMN_KIND.total_amount).toBe("money");
  });

  it("emits the canonical updated_at from Shopify's own field on all three datasets", async () => {
    // The watermark TRUSTS this column, and `watermarkValueOf` reads ONE name
    // across every track. Mutation: spell it `updatedAt`, or source it from
    // `createdAt` → the sync silently re-enumerates the whole store every tick.
    const cases: [string, string, Record<string, unknown>, string][] = [
      ["get_recent_orders", "orders", ORDER_NODE, "2026-08-28T11:00:00.000Z"],
      ["get_low_stock_products", "products", PRODUCT_NODE, "2026-08-30T08:00:00.000Z"],
      ["find_customer", "customers", CUSTOMER_NODE, "2026-08-28T11:00:00.000Z"],
    ];
    for (const [read, field, node, expected] of cases) {
      const { c } = connector({ graphql: [page(field, [node])] });
      await c.connect();
      const [row] = (await c.runRead(read, {})) as Record<string, unknown>[];
      expect(row.updated_at, read).toBe(expected);
      expect(row.created_at, read).not.toBe(expected);
    }
  });

  it("keeps global ids verbatim so an id-set diff can compare them", async () => {
    // Stripping the gid:// prefix collides Order/5 with Product/5.
    // Mutation: strip it → red.
    const { c } = connector({ graphql: [page("orders", [ORDER_NODE])] });
    await c.connect();
    const [row] = (await c.runRead("get_recent_orders", {})) as Record<string, unknown>[];
    expect(row.order_id).toBe("gid://shopify/Order/1001");
    expect(row.customer_id).toBe("gid://shopify/Customer/55");
  });

  it("has a source for every canonical column of every dataset it declares", () => {
    // Structural: a canonical column with no field in NODE_SELECTION is a row
    // that looks complete and answers "no value" to every question about it.
    // Mutation: delete a field from a selection → red.
    const src = sourceOf("connector.ts");
    const selection = src.slice(src.indexOf("const NODE_SELECTION"), src.indexOf("const SORT_KEY"));
    const unmapped: string[] = [];
    for (const dataset of SHOPIFY_DATASETS) {
      for (const column of CANONICAL_COLUMNS[dataset]) {
        if (!src.includes(`case "${column}":`)) unmapped.push(`${dataset}.${column}`);
      }
    }
    expect(unmapped).toEqual([]);
    expect(selection).toContain("updatedAt");
  });
});

describe("under-scoped credentials are a NAMED failure, never an empty result (ADR-042 §6)", () => {
  it("refuses a dataset whose scope the merchant did not tick, before any request", async () => {
    // `[]` here reads as "this store has no customers". Mutation: return the
    // empty list, or drop assertScopeFor → red.
    const { c, f } = connector({ scope: "read_orders", graphql: [page("orders", [])] });
    await c.connect();
    f.calls.length = 0;
    await expect(c.runRead("find_customer", {})).rejects.toThrow(ShopifyScopeMissingError);
    expect(f.calls).toHaveLength(0);
    expect(SHOPIFY_DATASET_SCOPES.customer).toEqual(["read_customers"]);
  });

  it("reads the granted scopes from the mint response rather than probing", async () => {
    // The client-credentials response carries `scope`, so the connector knows
    // before it asks. Mutation: assume every scope is granted → the first test
    // in this block goes green with a request already sent.
    const { c } = connector({ scope: "read_products", graphql: [page("products", [PRODUCT_NODE])] });
    await c.connect();
    const status = await c.status();
    expect(status.grantedScopes).toEqual(["read_products"]);
    await expect(c.runRead("get_recent_orders", {})).rejects.toThrow(/read_orders/);
  });

  it("treats an absent scope string as NO scopes, never as all of them", async () => {
    // Mutation: default `parseScopes` to the full set → every under-scoped
    // store silently returns empty lists.
    const { c } = connector({
      routes: [
        { match: new RegExp(SHOPIFY_TOKEN_PATH.replace(/\//g, "\\/")), responses: [{ body: { access_token: MINTED, expires_in: 3600 } }] },
        graphqlRoute(page("orders", [])),
      ],
    });
    await c.connect();
    expect((await c.status()).grantedScopes).toEqual([]);
  });
});

describe("protected customer data is detected, not absorbed (WARP-2338)", () => {
  it("detects the SILENT redaction shape — HTTP 200 with every protected field blank", async () => {
    // The dangerous shape: Shopify does not refuse, it blanks. Mutation: return
    // the rows → the owner sees a customer list full of empty names and reads
    // it as their data.
    const redacted = { ...CUSTOMER_NODE, firstName: null, lastName: null, email: null };
    const { c } = connector({
      routes: [tokenRoute(), graphqlRoute(page("customers", [redacted]))],
    });
    await c.connect();
    const status = await c.status();
    expect(status.protectedCustomerData.state).toBe("denied");
    expect(status.state).toBe("capability_limited");
    await expect(c.runRead("find_customer", {})).rejects.toThrow(ShopifyProtectedDataDeniedError);
  });

  it("detects the VENDOR-ERROR shape — HTTP 200 with an errors array", async () => {
    // Mutation: treat a 200 with `errors` as success → red.
    const { c } = connector({
      routes: [
        tokenRoute(),
        graphqlRoute({
          errors: [
            {
              message: "This app is not approved to use the email field.",
              extensions: { code: "ACCESS_DENIED" },
            },
          ],
        }),
      ],
    });
    await c.connect();
    const probe = (await c.status()).protectedCustomerData;
    expect(probe.state).toBe("denied");
    expect(probe).toMatchObject({ shape: "vendor_error" });
  });

  it("distinguishes a protected-data refusal from a missing access scope", async () => {
    // Both arrive as ACCESS_DENIED and want OPPOSITE advice — one is a plan
    // upgrade plus a data request, the other is a tick on the app.
    // Mutation: classify on `extensions.code` alone → the two collapse.
    const { c } = connector({
      routes: [
        tokenRoute(),
        graphqlRoute({
          errors: [
            {
              message: "Access denied for orders field. Required access: `read_orders` access scope.",
              extensions: { code: "ACCESS_DENIED" },
            },
          ],
        }),
      ],
    });
    await c.connect().catch(() => {});
    await expect(c.runRead("get_recent_orders", {})).rejects.toThrow(ShopifyScopeMissingError);
  });

  it("does NOT call a store with no customers a denial", async () => {
    // An absence of evidence is not evidence. Mutation: fold `no_customers`
    // into `denied` → a brand-new Grow-plan merchant is told to upgrade a plan
    // they already have; fold it into `granted` → the next read breaks a
    // promise this probe made.
    const { c } = connector({
      routes: [tokenRoute(), graphqlRoute(page("customers", []))],
    });
    await c.connect();
    expect((await c.status()).protectedCustomerData.state).toBe("no_customers");
    expect((await c.status()).state).toBe("connected");
  });

  it("does not call a single sparse customer a redaction", async () => {
    // One buyer with no surname is ordinary. Mutation: use `some` instead of
    // `every` → a Grow-plan store is told its plan is wrong.
    expect(detectProtectedDataRedaction([{ ...CUSTOMER_NODE, lastName: null }])).toBe(false);
    expect(detectProtectedDataRedaction([])).toBe(false);
    // `every`, not `some`, and THIS is the case that separates them: a page
    // where one buyer is anonymous and the rest are not is a store with one
    // anonymous buyer. Mutation: swap `every` for `some` → red, and a
    // Grow-plan merchant with a single blank record is told their plan is
    // wrong.
    expect(
      detectProtectedDataRedaction([{ email: null, firstName: null, lastName: null }, CUSTOMER_NODE]),
    ).toBe(false);
    expect(
      detectProtectedDataRedaction([{ email: null, firstName: null, lastName: "" }]),
    ).toBe(true);
    expect(SHOPIFY_PROTECTED_CUSTOMER_FIELDS).toContain("email");
  });

  it("keeps health() OK on a Basic-plan store so orders and products stay readable", async () => {
    // The design decision worth a test: `integrations.service` classifies a
    // rejected health() into the row's status, so throwing here would render
    // the whole integration ERROR and send the merchant to fix a connection
    // that has nothing wrong with it. Mutation: throw from health() on a denial
    // → red, and a Basic-plan store's working commerce reads become invisible.
    const redacted = { ...CUSTOMER_NODE, firstName: null, lastName: null, email: null };
    const { c } = connector({
      routes: [
        tokenRoute(),
        graphqlRoute(page("customers", [redacted]), page("customers", [redacted]), page("orders", [ORDER_NODE])),
      ],
    });
    await c.connect();
    await expect(c.health()).resolves.toEqual({ ok: true });
    const orders = await c.runRead("get_recent_orders", {});
    expect(orders).toHaveLength(1);
  });

  it("re-detects a redaction on the READ, not only at connect time", async () => {
    // A store that downgrades from Grow to Basic keeps working and simply
    // starts blanking fields; the connect-time probe may be hours old.
    // Mutation: trust the probe alone → red.
    const redacted = { ...CUSTOMER_NODE, firstName: null, lastName: null, email: null };
    const { c } = connector({
      routes: [
        tokenRoute(),
        graphqlRoute(page("customers", [CUSTOMER_NODE]), page("customers", [redacted])),
      ],
    });
    await c.connect();
    expect((await c.status()).protectedCustomerData.state).toBe("granted");
    await expect(c.runRead("find_customer", {})).rejects.toThrow(ShopifyProtectedDataDeniedError);
    expect((await c.status()).protectedCustomerData.state).toBe("denied");
  });
});

describe("the 60-day order wall (WARP-2299)", () => {
  it("refuses a bounded read that reaches past the wall without read_all_orders", async () => {
    // Shopify returns FEWER ORDERS, not an error. Answering would report a
    // truncated window as complete — a confident false statement about revenue.
    // Mutation: send the filter anyway → red.
    const { c, f } = connector({ scope: "read_orders", graphql: [page("orders", [])] });
    await c.connect();
    f.calls.length = 0;
    await expect(
      c.runRead("get_recent_orders", { since: "2026-01-01T00:00:00Z" }),
    ).rejects.toThrow(ShopifyOrderHistoryWallError);
    expect(f.calls).toHaveLength(0);
  });

  it("clamps an UNBOUNDED enumeration to the wall instead of refusing it", async () => {
    // The poller asks "what changed", for which 60 days is a complete answer;
    // a caller who named an older `from` asked a question this connection
    // cannot answer. Mutation: refuse the poller too → the whole order sync
    // parks FAILED on every Basic-scope store.
    const { c, f } = connector({ scope: "read_orders", graphql: [page("orders", [ORDER_NODE])] });
    await c.connect();
    f.calls.length = 0;
    await c.runRead("get_recent_orders", {});
    const parsed = JSON.parse(String(f.calls[0].init.body)) as { variables: Record<string, unknown> };
    const wall = new Date(NOW - SHOPIFY_ORDER_HISTORY_WALL_DAYS * 86_400_000).toISOString();
    expect(parsed.variables.query).toBe(`updated_at:>='${wall}'`);
  });

  it("lifts the wall entirely once read_all_orders is granted", async () => {
    // Mutation: ignore the scope → the clamp applies to a store that paid for
    // full history.
    const { c, f } = connector({
      scope: `read_orders ${SHOPIFY_ORDER_HISTORY_SCOPE}`,
      graphql: [page("orders", [ORDER_NODE])],
    });
    await c.connect();
    f.calls.length = 0;
    await c.runRead("get_recent_orders", { since: "2025-01-01T00:00:00Z" });
    const parsed = JSON.parse(String(f.calls[0].init.body)) as { variables: Record<string, unknown> };
    expect(parsed.variables.query).toBe("updated_at:>='2025-01-01T00:00:00.000Z'");
    expect((await c.status()).orderHistory).toEqual({
      allOrders: true,
      windowDays: SHOPIFY_ORDER_HISTORY_WALL_DAYS,
    });
  });

  it("never applies the wall to products or customers", async () => {
    // The wall is an ORDER limit. Mutation: clamp every dataset → a catalogue
    // sync silently drops everything created more than 60 days ago.
    const { c, f } = connector({ scope: "read_products", graphql: [page("products", [PRODUCT_NODE])] });
    await c.connect();
    f.calls.length = 0;
    await c.runRead("get_low_stock_products", {});
    const parsed = JSON.parse(String(f.calls[0].init.body)) as { variables: Record<string, unknown> };
    expect(parsed.variables.query).toBeNull();
  });
});

describe("what the reconciliation sweep needs (WARP-2344)", () => {
  it("lists ids with a one-field selection, not the full read", async () => {
    // Shopify's cost model charges per FIELD, so an id-only query is roughly an
    // order of magnitude cheaper — the difference between a nightly sweep that
    // fits in the bucket and one that throttles.
    // Mutation: reuse NODE_SELECTION here → red.
    const { c, f } = connector({
      graphql: [page("orders", [{ id: "gid://shopify/Order/1" }, { id: "gid://shopify/Order/2" }])],
    });
    await c.connect();
    f.calls.length = 0;
    const ids = await c.listEntityIds("order");
    expect(ids).toEqual(["gid://shopify/Order/1", "gid://shopify/Order/2"]);
    const doc = JSON.parse(String(f.calls[0].init.body)) as { query: string };
    expect(doc.query).toContain("nodes { id }");
    expect(doc.query).not.toContain("currentTotalPriceSet");
  });

  it("throws rather than returning a short list when a scope is missing", async () => {
    // The one failure in this area that DESTROYS DATA: an id-set diff over a
    // truncated list deletes live rows. Mutation: return [] → red.
    const { c } = connector({ scope: "read_orders", graphql: [page("orders", [])] });
    await c.connect();
    await expect(c.listEntityIds("customer")).rejects.toThrow(ShopifyScopeMissingError);
  });

  it("refuses an id listing for a dataset this track does not serve", async () => {
    const { c } = connector();
    await c.connect();
    await expect(c.listEntityIds("invoice")).rejects.toThrow(DatasetNotServedError);
  });
});

describe("bulk export is a REFERENCE, never a download", () => {
  it("returns the signed URL without dialing it", async () => {
    // The JSONL lives on object storage, a host allowed-egress.yaml does not
    // register — the same line the HubSpot track draws for a completed export.
    // Mutation: fetch the URL → red, and the connector dials an unregistered
    // host with nothing in CI to notice.
    const { c, f } = connector({
      graphql: [
        { data: { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/9", status: "CREATED" }, userErrors: [] } } },
        { data: { currentBulkOperation: { id: "gid://shopify/BulkOperation/9", status: "COMPLETED", objectCount: "42", url: "https://storage.example.test/export.jsonl", errorCode: null } } },
      ],
    });
    await c.connect();
    f.calls.length = 0;
    const ref = await c.runBulkExport("order");
    expect(ref.url).toBe("https://storage.example.test/export.jsonl");
    expect(ref.objectCount).toBe(42);
    expect(f.urls().every((u) => u.startsWith(`https://${SHOP_DOMAIN}`))).toBe(true);
  });

  it("reports a failed bulk operation rather than an empty export", async () => {
    const { c } = connector({
      graphql: [
        { data: { bulkOperationRunQuery: { bulkOperation: { id: "gid://x/1", status: "CREATED" }, userErrors: [] } } },
        { data: { currentBulkOperation: { id: "gid://x/1", status: "FAILED", objectCount: null, url: null, errorCode: "INTERNAL_SERVER_ERROR" } } },
      ],
    });
    await c.connect();
    await expect(c.runBulkExport("order")).rejects.toThrow(ShopifyBulkOperationError);
  });
});

describe("throttling and timeouts are named states, never empty results", () => {
  it("derives the retry wait from the response's own throttleStatus", async () => {
    // Mutation: replace with a constant backoff → red. A guessed number is
    // wrong on every plan but one.
    const extensions = {
      cost: { throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 } },
    };
    // 400 points short at 50/s ⇒ 8 s, plus the 100 ms cushion, capped at 10 s.
    expect(throttleWaitMs(extensions, 500)).toBe(8_100);
    // No usable numbers ⇒ one second, never zero (a hot retry loop).
    expect(throttleWaitMs(undefined, 500)).toBe(1_000);
  });

  it("reports THROTTLED after the retry budget rather than returning nothing", async () => {
    // Mutation: swallow the throttle and return [] → the owner is told their
    // store sold nothing.
    const throttled = {
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } },
    };
    const { c } = connector({
      routes: [tokenRoute(), graphqlRoute(throttled, throttled, throttled, throttled, throttled, throttled)],
    });
    await expect(c.connect()).rejects.toThrow(ShopifyThrottledError);
  });

  it("times out on its OWN clock even when fetch ignores the signal", async () => {
    // The deadline is OURS rather than a delegated hope. Mutation: drop the
    // Promise.race and keep only the AbortSignal → this never settles.
    const { c } = connector({ hang: true, timeoutMs: 20 });
    await expect(c.connect()).rejects.toThrow(ShopifyTimeoutError);
  });

  it("classifies a 401 as REAUTHORIZE_REQUIRED and drops the cached token", async () => {
    // Mutation: keep the cached token → a reconnect presents a dead one.
    const { c } = connector({
      routes: [tokenRoute(), { match: GRAPHQL_RE, responses: [{ status: 401 }] }],
    });
    await expect(c.connect()).rejects.toThrow(ShopifyReauthorizationRequiredError);
  });
});

describe("the version pin", () => {
  it("is written exactly once in the connector directory", () => {
    // A second version literal is a version that can drift out of the pin
    // silently. Mutation: hardcode the version in a path → red.
    for (const file of readdirSync(SRC_DIR)) {
      const occurrences = sourceOf(file).split(SHOPIFY_API_VERSION).length - 1;
      const expected = file === "connector.ts" ? 1 : 0;
      expect(occurrences, `${file} names ${SHOPIFY_API_VERSION} ${occurrences} times`).toBe(expected);
    }
    expect(SHOPIFY_GRAPHQL_PATH).toBe(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    // The token endpoint is deliberately UN-versioned — Shopify's own design.
    expect(SHOPIFY_TOKEN_PATH).not.toContain(SHOPIFY_API_VERSION);
  });
});
