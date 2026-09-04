/**
 * BrevoConnector.
 *
 * `fetch` is INJECTED, never patched globally, and the tests that matter
 * assert on the CALLS the connector made — not only on what it returned.
 *
 * That distinction is the whole design of this file, for a reason specific to
 * this vendor. Brevo is ASSUMED to ignore an unknown query parameter rather
 * than reject it (the assumption cannot be probed without a live key, and it
 * is the dangerous direction). So an invented `since_modified`, a
 * `modifiedSince` bolted onto `/emailCampaigns`, or a `startDate` on
 * `/contacts` would all return 200 with correct-looking rows while performing
 * a FULL SCAN reported as an incremental read. A test that inspects the rows
 * that came back still passes when the connector silently degraded — so the
 * delta tests here assert on the exact query string that left the box.
 *
 * The host-guard tests assert the injected fetch was called ZERO times, for
 * the same class of reason: a test that inspects the thrown error still passes
 * if the request already went out carrying the customer's key.
 *
 * Every vendor fact pinned below cites where it came from. The primary source
 * throughout is Brevo's own live OpenAPI document,
 * https://api.brevo.com/v3/swagger_definition_v3.yml, read on 2026-09-03.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect } from "vitest";

import {
  BREVO_ACCOUNT_PATH,
  BREVO_ALLOWED_API_HOSTS,
  BREVO_API_BASE_URL,
  BREVO_AUTH_HEADER,
  BREVO_CAMPAIGN_STATISTICS,
  BREVO_CAMPAIGN_STATS_HORIZON_MS,
  BREVO_CAMPAIGN_WINDOW_MAX_MS,
  BREVO_CONSTANT_HEADERS,
  BREVO_CONTACTS_RATE_LIMIT_PER_HOUR,
  BREVO_CONTACTS_RATE_LIMIT_PER_SECOND,
  BREVO_CREATED_SINCE_PARAM,
  BREVO_DATASETS,
  BREVO_DEFAULT_RATE_LIMIT_PER_HOUR,
  BREVO_DELTA_PARAM,
  BREVO_DISPLAY_CURRENCY_PATH,
  BREVO_DOCUMENTED_PARAMS,
  BREVO_ENDPOINTS,
  BREVO_HTTP_METHOD,
  BREVO_MAX_PAGE_SIZE,
  BREVO_MEMBER_ID_SEPARATOR,
  BREVO_PROVIDER,
  BREVO_RATE_LIMIT_RESET_HEADER,
  BREVO_SCAN_MODE,
  BREVO_UNAUTHORIZED_CAUSES,
  BrevoCallBudget,
  BrevoCapabilityMissingError,
  BrevoConnector,
  BrevoIpBlockedError,
  BrevoPaginationContractError,
  BrevoRateBudgetExhaustedError,
  BrevoReauthorizationRequiredError,
  UnsafeBrevoBaseUrlError,
  assertDocumentedBrevoParams,
  assertDocumentedBrevoQuery,
  assertReadableBrevoResource,
  assertSafeBrevoBaseUrl,
  brevoCampaignWindows,
  brevoEndpointForPath,
  brevoErrorCode,
  brevoMajorUnits,
  brevoMemberId,
  brevoRateGroup,
  brevoSubscriptionStatus,
  clampBrevoPageSize,
} from "../src/brevo/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { CANONICAL_COLUMNS, DATASETS, REQUIRED_CANONICAL } from "../src/export-drop/profiles.js";

/** 2026-09-03T12:00:00Z, the clock every test runs on. */
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

/**
 * A fixture credential. NOT a real key, and deliberately not shaped like one.
 *
 * Composed from tokens rather than written as one literal: GitHub push
 * protection ships a Brevo/Sendinblue detector that no repo config can
 * allowlist, and a realistic contiguous `xkeysib-<hex>` literal is exactly
 * what it matches. The Mailchimp suite records the same lesson after a push
 * was rejected for it.
 *
 * The shapelessness is also the point of `accepts a key with no recognisable
 * shape` below: this connector ships NO regex on the credential.
 */
const KEY = ["xkeysib", "fixture", "value", "not", "a", "credential"].join("-");

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
interface Route {
  match: RegExp;
  /** Sequential responses; the last one repeats. */
  responses?: StubResponse[];
  /** Or a function of the request URL, for pagination scenarios. */
  handler?: (url: URL) => StubResponse;
}
interface Recorded {
  url: string;
  init: Record<string, unknown>;
}

function stubFetch(routes: Route[]) {
  const calls: Recorded[] = [];
  const seen = new Map<number, number>();

  const impl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    const idx = routes.findIndex((r) => r.match.test(url));
    if (idx === -1) throw new Error(`test stub has no route for ${url}`);
    const route = routes[idx];
    const n = seen.get(idx) ?? 0;
    seen.set(idx, n + 1);
    const r = route.handler
      ? route.handler(new URL(url))
      : (route.responses ?? [{}])[Math.min(n, (route.responses ?? [{}]).length - 1)];
    const status = r.status ?? 200;
    const headers = r.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => {
        if (r.body === undefined) return {};
        return r.body;
      },
    } as unknown as Response;
  };

  return {
    impl,
    calls,
    urls: () => calls.map((c) => c.url),
    paths: () => calls.map((c) => new URL(c.url).pathname),
    params: (i: number) => new URL(calls[i].url).searchParams,
    paramKeys: (i: number) => [...new URL(calls[i].url).searchParams.keys()],
    headers: (i: number) => calls[i].init.headers as Record<string, string>,
  };
}

function connector(
  opts: {
    routes?: Route[];
    baseUrl?: string;
    key?: string;
    blocked?: boolean;
    dealCurrency?: string;
    budget?: BrevoCallBudget;
    sleeps?: number[];
  } = {},
) {
  const f = stubFetch(opts.routes ?? [{ match: /.*/, responses: [{ body: {} }] }]);
  const c = new BrevoConnector(
    {
      credentialsSecretRef: "secret://brevo/acct_fixture",
      connectionId: "conn_a",
      baseUrl: opts.baseUrl,
      dealCurrency: opts.dealCurrency,
    },
    {
      fetchImpl: f.impl,
      now: () => NOW,
      budget: opts.budget,
      sleep: async (ms) => {
        opts.sleeps?.push(ms);
      },
      // `blocked` leaves the default resolver in place, which is the
      // shipped-off state: nothing wired, so every I/O path blocks honestly.
      resolveApiKey: opts.blocked ? undefined : async () => opts.key ?? KEY,
    },
  );
  return { c, f };
}

/** The rejection a call produced, typed — so an assertion on `.message`
 *  survives `tsc --noEmit -p tsconfig.test.json`, and so a call that does NOT
 *  reject fails loudly instead of quietly asserting on `undefined`. */
async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/**
 * The private `request()` choke point, reached deliberately.
 *
 * Every guard in this connector lives inside `request()` rather than on its
 * callers, and that placement is the property under test: a guard that only
 * runs from the pagers protects the pagers, and the direct read somebody adds
 * next is the one that gets 200 and a full scan reported as a delta. Every
 * public method routes through here, so there is no public call that can send
 * an undocumented parameter — which is the point, and also why proving the
 * guard is here at all needs the seam.
 *
 * Typed rather than `any`, so these tests still fail to compile if the
 * signature moves.
 */
type BrevoRequestSeam = {
  request(
    op: string,
    path: string,
    search?: Record<string, string | number | undefined>,
  ): Promise<unknown>;
};
function requestSeam(c: BrevoConnector): BrevoRequestSeam {
  return c as unknown as BrevoRequestSeam;
}

/** `n` companies as Brevo returns them: `{ items: [...] }`, no `count`. */
function companyItems(ids: readonly string[]) {
  return {
    items: ids.map((id) => ({
      id,
      attributes: { name: `Co ${id}`, domain: `${id}.example.test` },
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The host guard — exact host, derived from the one literal CI can see
// ─────────────────────────────────────────────────────────────────────────────

describe("host guard", () => {
  it("carries the base URL as a WHOLE-STRING https literal the egress scanner can extract", () => {
    // Brevo's OpenAPI declares exactly one server: https://api.brevo.com/v3.
    // Unlike the Mailchimp track (whose host is assembled from the key at
    // runtime and must therefore NOT appear as a scheme literal), this
    // connector's allowlist entry is `kind: egress` and is BACKED by this
    // literal — `scripts/check-egress-allowlist.py` is a static text scanner.
    // Mutation: split this into a template or a join → the egress entry is
    // unregistered in the scanner's eyes and the gate fails.
    expect(BREVO_API_BASE_URL).toBe("https://api.brevo.com/v3");
  });

  it("DERIVES the allowed host set from that literal rather than hand-listing hosts", () => {
    // The QBO_ALLOWED_API_HOSTS shape. A hand-written list drifts in exactly
    // one direction — towards dialling more — and can bless a host the egress
    // registry never screened.
    // Mutation: hand-write `new Set(["api.brevo.com", "api.sendinblue.com"])`
    // → red, because the legacy host is not derivable from the literal.
    expect([...BREVO_ALLOWED_API_HOSTS]).toEqual(["api.brevo.com"]);
  });

  it("refuses a SUFFIX-ATTACK host on ZERO fetch calls", () => {
    // The attack exact-host equality exists to stop.
    // Mutation: change the guard to `host.endsWith("api.brevo.com")` → red
    // here AND red on the zero-fetch assertion, which is the half proving the
    // key never left the box.
    const f = stubFetch([{ match: /.*/, responses: [{ body: {} }] }]);
    expect(
      () =>
        new BrevoConnector(
          { credentialsSecretRef: "s", connectionId: "conn_a", baseUrl: "https://api.brevo.com.evil.test/v3" },
          { fetchImpl: f.impl, now: () => NOW, resolveApiKey: async () => KEY },
        ),
    ).toThrow(UnsafeBrevoBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses the LEGACY pre-rebrand host on ZERO fetch calls", () => {
    // api.sendinblue.com is not registered in allowed-egress.yaml, is not a
    // literal in the connector, and is not accepted as an override.
    // Mutation: add it to the allowed set → red.
    const f = stubFetch([{ match: /.*/, responses: [{ body: {} }] }]);
    expect(
      () =>
        new BrevoConnector(
          { credentialsSecretRef: "s", connectionId: "conn_a", baseUrl: "https://api.sendinblue.com/v3" },
          { fetchImpl: f.impl, now: () => NOW, resolveApiKey: async () => KEY },
        ),
    ).toThrow(UnsafeBrevoBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses http, userinfo and a non-443 port, each on ZERO fetch calls", () => {
    const f = stubFetch([{ match: /.*/, responses: [{ body: {} }] }]);
    const build = (baseUrl: string) =>
      new BrevoConnector(
        { credentialsSecretRef: "s", connectionId: "conn_a", baseUrl },
        { fetchImpl: f.impl, now: () => NOW, resolveApiKey: async () => KEY },
      );
    // An API key over http is the key given away.
    expect(() => build("http://api.brevo.com/v3")).toThrow(UnsafeBrevoBaseUrlError);
    // Some clients resolve userinfo to a different authority than a reader expects.
    expect(() => build("https://evil@api.brevo.com/v3")).toThrow(UnsafeBrevoBaseUrlError);
    // 443 is the only port the egress registry declares.
    expect(() => build("https://api.brevo.com:8443/v3")).toThrow(UnsafeBrevoBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("accepts the registered host, including an explicit :443", () => {
    // The URL parser drops the default port, so this must normalise rather
    // than be refused — a connection row written with :443 is not an attack.
    expect(assertSafeBrevoBaseUrl("https://api.brevo.com:443/v3")).toBe("https://api.brevo.com/v3");
    expect(assertSafeBrevoBaseUrl("https://api.brevo.com/v3/")).toBe("https://api.brevo.com/v3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The auth header — one header, spelled Brevo's way
// ─────────────────────────────────────────────────────────────────────────────

describe("authentication", () => {
  it("sends the credential in an `api-key` header, character for character", async () => {
    // Verbatim from developers.brevo.com/docs/how-it-works: "Include your API
    // key in the api-key header for every request." NOT Authorization, NOT
    // Bearer, NOT X-API-Key — the three a reader arriving from the Stripe or
    // QuickBooks track reaches for, every one of which authenticates nothing
    // here and presents as a bad credential.
    // Mutation: `Authorization: \`Bearer ${key}\`` → red.
    expect(BREVO_AUTH_HEADER).toBe("api-key");
    const { c, f } = connector({
      routes: [{ match: /\/account/, responses: [{ body: { companyName: "Acme" } }] }],
    });
    await c.connect();
    const headers = f.headers(0);
    expect(headers["api-key"]).toBe(KEY);
    expect(headers["api-key"]).not.toContain("Bearer");
  });

  it("sends EXACTLY the credential plus the constant headers, and nothing else", async () => {
    // An extra header travels on every call and is a leak surface; a missing
    // Accept lets a proxy negotiate a representation the parser was not
    // written for.
    // Mutation: add any header to the request → red.
    const { c, f } = connector({
      routes: [{ match: /\/account/, responses: [{ body: {} }] }],
    });
    await c.connect();
    const keys = Object.keys(f.headers(0)).sort();
    expect(keys).toEqual([BREVO_AUTH_HEADER, ...Object.keys(BREVO_CONSTANT_HEADERS)].sort());
    expect(keys.map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(keys.map((k) => k.toLowerCase())).not.toContain("x-api-key");
  });

  it("never puts the credential in the URL, and only ever issues GETs", async () => {
    // A key in a query string is a key in every proxy log and every browser
    // history. And a read-only connector that can issue a POST is one refactor
    // away from sending a campaign.
    // Mutation: move the key to a query parameter, or take `method` from a
    // caller → red.
    const { c, f } = connector({
      routes: [
        { match: /\/contacts\?/, responses: [{ body: { contacts: [], count: 0 } }] },
      ],
    });
    await c.listContacts({ modifiedSince: "2026-09-01T00:00:00.000Z" });
    expect(f.urls().every((u) => !u.includes(KEY))).toBe(true);
    expect(f.calls.every((call) => call.init.method === BREVO_HTTP_METHOD)).toBe(true);
    expect(BREVO_HTTP_METHOD).toBe("GET");
  });

  it("accepts a key with no recognisable shape — this track ships NO credential regex", async () => {
    // The `xkeysib-` prefix is widely repeated but appears on no page of
    // Brevo's developer documentation; the api-key-authentication page states
    // no prefix at all. A rejecting pattern anchored on an undocumented prefix
    // is a false rejection that blocks a paying customer's onboarding for zero
    // security gain. Validation is GET /account, not a string match.
    // Mutation: add `/^xkeysib-/` validation at intake → red.
    const { c } = connector({
      key: "a-perfectly-valid-key-that-does-not-look-like-one",
      routes: [{ match: /\/account/, responses: [{ body: { companyName: "Acme" } }] }],
    });
    await expect(c.connect()).resolves.toBeUndefined();
  });

  it("refuses an EMPTY stored credential rather than sending an empty header", async () => {
    const { c, f } = connector({ key: "   " });
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The delta parameters — the facts that fail SILENTLY
// ─────────────────────────────────────────────────────────────────────────────

describe("delta parameters", () => {
  it("pins `modifiedSince` on the five endpoints that document it", () => {
    // Verified verbatim in the vendor's own OpenAPI
    // (https://api.brevo.com/v3/swagger_definition_v3.yml): the parameter is
    // named `modifiedSince` on GET /contacts, GET
    // /contacts/lists/{listId}/contacts, GET /companies, GET /crm/deals and
    // GET /orders — "Filter (urlencoded) the contacts modified after a given
    // UTC date-time (YYYY-MM-DDTHH:mm:ss.SSSZ)".
    // Mutation: rename it to `modified_since`, `since` or `updatedSince` →
    // red HERE, whereas the API would answer 200 with a full scan.
    expect(BREVO_DELTA_PARAM).toEqual({
      contact: "modifiedSince",
      audience: null,
      audience_member: "modifiedSince",
      campaign: null,
      company: "modifiedSince",
      deal: "modifiedSince",
      ecommerce_order: "modifiedSince",
    });
  });

  it("pins `createdSince` on FOUR endpoints — one of which is /contacts, not a CRM one", () => {
    // The easy mistake is to call these "the CRM/commerce endpoints", which is
    // three. /contacts documents createdSince too, and that is what makes a
    // first backfill a forward walk over creations instead of a full scan of
    // the address book.
    expect(
      Object.entries(BREVO_CREATED_SINCE_PARAM)
        .filter(([, v]) => v !== null)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["company", "contact", "deal", "ecommerce_order"]);
  });

  it("puts `modifiedSince` on the wire for a contacts delta — asserted on the REQUEST", () => {
    // The response cannot falsify this: an ignored parameter returns
    // correct-looking rows. Only the outgoing query string can.
    // Mutation: drop the parameter → the rows are identical and this is the
    // only test that goes red.
    const { c, f } = connector({
      routes: [{ match: /\/contacts\?/, responses: [{ body: { contacts: [], count: 0 } }] }],
    });
    return c.listContacts({ modifiedSince: "2026-09-01T00:00:00.000Z" }).then(() => {
      expect(f.params(0).get("modifiedSince")).toBe("2026-09-01T00:00:00.000Z");
      expect(f.paramKeys(0)).not.toContain("since");
      expect(f.paramKeys(0)).not.toContain("modified_since");
    });
  });

  it("puts `modifiedSince` on the wire for a per-list membership delta", async () => {
    const { c, f } = connector({
      routes: [
        { match: /\/contacts\/lists\/5\/contacts/, responses: [{ body: { contacts: [], count: 0 } }] },
      ],
    });
    await c.listAudienceMembers("5", { modifiedSince: "2026-09-01T00:00:00.000Z" });
    expect(f.paths()[0]).toBe("/v3/contacts/lists/5/contacts");
    expect(f.params(0).get("modifiedSince")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("REFUSES a modifiedSince on /emailCampaigns, on ZERO fetch calls", async () => {
    // The highest-value negative finding in this connector. GET
    // /emailCampaigns documents type, status, statistics, startDate, endDate,
    // limit, offset, sort, excludeHtmlContent and excludePdfAttachment — and
    // NO modification watermark. Brevo is assumed to ignore an unknown
    // parameter, so bolting one on returns 200 and a full scan reported as a
    // delta, with no error anywhere.
    //
    // Both halves are load-bearing and neither is a restatement of the other.
    // The pure-function half pins the TABLE: a campaign parameter set that
    // grew a `modifiedSince` would go red here. The connector half pins the
    // PLACEMENT: the stub below is handed to a real connector and driven
    // through the one choke point every call goes through, so a guard that
    // exists but sits on the pagers instead of inside `request()` — which is
    // exactly where it used to sit — leaves this fetch count at 1.
    // Mutation: delete the guard, add `modifiedSince` to the campaign
    // parameter set, or move the call back out of `request()` into
    // `pageOffset()` → red.
    expect(() => assertDocumentedBrevoParams("campaign", { modifiedSince: "x" })).toThrow(
      ConnectorBlockedError,
    );

    const { c, f } = connector({
      routes: [{ match: /emailCampaigns/, responses: [{ body: { campaigns: [], count: 0 } }] }],
    });
    // The direct read the module docstring promises is safe and the finding
    // proved was not: a filtered call straight onto `request()`, with no pager
    // in between to run a parameter check on the caller's behalf.
    const err = await rejection(() =>
      requestSeam(c).request("listCampaigns", BREVO_ENDPOINTS.campaign, {
        modifiedSince: "2026-09-01T00:00:00.000Z",
      }),
    );
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err.message).toContain("not a documented /emailCampaigns parameter");
    expect(f.calls).toHaveLength(0);
  });

  it("runs the parameter guard BEFORE the key resolves, so a refusal never touches the credential", async () => {
    // The order `request()` documents: path allowlist, parameter allowlist,
    // host guard — all before the credential is read out of the secret store.
    // A test that only inspects the thrown error still passes when the key was
    // already resolved into memory (and, one refactor later, already on the
    // wire), so this counts resolver calls rather than reading the message.
    // Mutation: resolve the key first and check parameters afterwards → the
    // error is identical and only `resolved` goes red.
    let resolved = 0;
    const f = stubFetch([{ match: /.*/, responses: [{ body: { campaigns: [] } }] }]);
    const c = new BrevoConnector(
      { credentialsSecretRef: "secret://brevo/acct_fixture", connectionId: "conn_a" },
      {
        fetchImpl: f.impl,
        now: () => NOW,
        resolveApiKey: async () => {
          resolved += 1;
          return KEY;
        },
      },
    );
    await expect(
      requestSeam(c).request("listCampaigns", BREVO_ENDPOINTS.campaign, { modifiedSince: "x" }),
    ).rejects.toThrow(ConnectorBlockedError);
    expect(resolved).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it("REFUSES any query on an endpoint that documents none, and on a path it cannot name", async () => {
    // /account and /ecommerce/config/displayCurrency take no parameters at
    // all, and GET /companies/{id} is a single object rather than the
    // /companies collection — so it must NOT inherit that collection's filter
    // set just because the paths share a prefix.
    // Mutation: resolve the endpoint by `path.startsWith()` → /companies/{id}
    // silently accepts `modifiedSince`, `page` and `limit`, and this goes red.
    expect(() => assertDocumentedBrevoQuery(BREVO_ACCOUNT_PATH, { limit: 10 })).toThrow(
      ConnectorBlockedError,
    );
    expect(() => assertDocumentedBrevoQuery(BREVO_DISPLAY_CURRENCY_PATH, { limit: 10 })).toThrow(
      ConnectorBlockedError,
    );
    expect(() => assertDocumentedBrevoQuery("/companies/61a5ce58", { modifiedSince: "x" })).toThrow(
      ConnectorBlockedError,
    );
    // An absent filter is not a parameter, and these endpoints are dialled
    // with no query on every real call.
    expect(() => assertDocumentedBrevoQuery(BREVO_ACCOUNT_PATH, {})).not.toThrow();
    expect(() => assertDocumentedBrevoQuery("/companies/61a5ce58", { page: undefined })).not.toThrow();

    // A path this file cannot name has no documented set to check against, so
    // it may carry no query either — sending one would be exactly the
    // unscreened full scan the guard exists to prevent. Driven through the
    // PUBLIC surface: an empty list id collapses /contacts/lists/{id}/contacts
    // into a three-segment path the resolver does not recognise, and the pager
    // always sends limit and offset.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: { contacts: [] } }] }],
    });
    const err = await rejection(() => c.listAudienceMembers(""));
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err.message).toContain("unrecognised Brevo path");
    expect(f.calls).toHaveLength(0);
  });

  it("resolves an endpoint by SEGMENT POSITION, never by prefix", async () => {
    // The four /contacts-rooted paths document four different parameter sets,
    // and three of them share a prefix with the others.
    // Mutation: match on `startsWith("/contacts")` → /contacts/lists gets
    // /contacts' set and accepts `modifiedSince`, which that endpoint
    // documents nowhere and Brevo is assumed to ignore.
    expect(brevoEndpointForPath("/contacts")).toEqual({ kind: "dataset", dataset: "contact" });
    expect(brevoEndpointForPath("/contacts/lists")).toEqual({ kind: "dataset", dataset: "audience" });
    expect(brevoEndpointForPath("/contacts/lists/5/contacts")).toEqual({
      kind: "dataset",
      dataset: "audience_member",
    });
    expect(brevoEndpointForPath("/crm/deals")).toEqual({ kind: "dataset", dataset: "deal" });
    expect(brevoEndpointForPath("/companies")).toEqual({ kind: "dataset", dataset: "company" });
    expect(brevoEndpointForPath("/orders")).toEqual({ kind: "dataset", dataset: "ecommerce_order" });
    expect(brevoEndpointForPath("/emailCampaigns")).toEqual({ kind: "dataset", dataset: "campaign" });
    // Single objects and account settings: no query parameters at all.
    expect(brevoEndpointForPath("/companies/61a5ce58").kind).toBe("parameterless");
    expect(brevoEndpointForPath(BREVO_ACCOUNT_PATH).kind).toBe("parameterless");
    expect(brevoEndpointForPath(BREVO_DISPLAY_CURRENCY_PATH).kind).toBe("parameterless");
    // And every endpoint this connector actually dials resolves to one of the
    // two, so no real call falls through to the unknown branch.
    for (const path of Object.values(BREVO_ENDPOINTS)) {
      expect(brevoEndpointForPath(path.replace("{listId}", "5")).kind).not.toBe("unknown");
    }
    expect(brevoEndpointForPath("/emailCampaigns/12").kind).toBe("unknown");
  });

  it("REFUSES a date filter on /contacts/lists, which documents none at all", () => {
    // GET /contacts/lists documents ONLY limit, offset and sort. Full scan
    // only — declared rather than assumed, so a scheduler can price it.
    expect(() => assertDocumentedBrevoParams("audience", { modifiedSince: "x" })).toThrow(
      ConnectorBlockedError,
    );
    expect(() => assertDocumentedBrevoParams("audience", { createdSince: "x" })).toThrow(
      ConnectorBlockedError,
    );
    expect(BREVO_SCAN_MODE.audience).toBe("full_scan_only");
    // And the method exposes no `since` option at all, so nothing can be
    // smuggled in from a caller.
    expect(() => assertDocumentedBrevoParams("audience", { limit: 50, offset: 0 })).not.toThrow();
  });

  it("REFUSES an invented delta parameter on an endpoint that HAS a real one", () => {
    // The subtler half: `/contacts` does support a delta, so a plausible
    // misspelling looks harmless.
    expect(() => assertDocumentedBrevoParams("contact", { since_modified: "x" })).toThrow(
      /not a documented \/contacts parameter/,
    );
    expect(() => assertDocumentedBrevoParams("contact", { startDate: "x" })).toThrow(
      ConnectorBlockedError,
    );
  });

  it("declares campaigns as a send-date window, NOT a delta", () => {
    // startDate/endDate filter WHEN A CAMPAIGN WAS SENT, are mutually
    // mandatory, and apply only when `status` is unset or `sent`. A campaign
    // already inside a consumed window never re-enters it while its statistics
    // keep accruing — so calling this a delta is a lie a scheduler acts on.
    // Mutation: fold this into "delta" → red.
    expect(BREVO_SCAN_MODE.campaign).toBe("send_date_window");
    expect(BREVO_DOCUMENTED_PARAMS.campaign.has("startDate")).toBe(true);
    expect(BREVO_DOCUMENTED_PARAMS.campaign.has("modifiedSince")).toBe(false);
  });

  it("asks for globalStats and EXCLUDES the html body on every campaign read", async () => {
    // The campaign body is the entire marketing email. Nothing upstream asked
    // for it and a connector taking the default persists it on the box.
    const { c, f } = connector({
      routes: [{ match: /emailCampaigns/, responses: [{ body: { campaigns: [], count: 0 } }] }],
    });
    await c.listCampaigns();
    expect(f.params(0).get("statistics")).toBe(BREVO_CAMPAIGN_STATISTICS);
    expect(f.params(0).get("excludeHtmlContent")).toBe("true");
  });

  it("sends startDate/endDate TOGETHER or not at all, and chunks a multi-year window", async () => {
    // "Mandatory if endDate is used" / "Mandatory if startDate is used", and
    // "The date range between startDate and endDate must not exceed 2 years."
    // A first backfill over a longer history is several calls, not one.
    const { c, f } = connector({
      routes: [{ match: /emailCampaigns/, responses: [{ body: { campaigns: [], count: 0 } }] }],
    });
    await c.listCampaigns({ from: "2020-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" });
    expect(f.calls.length).toBeGreaterThan(1);
    for (let i = 0; i < f.calls.length; i += 1) {
      const p = f.params(i);
      expect(p.get("startDate")).not.toBeNull();
      expect(p.get("endDate")).not.toBeNull();
      const span = Date.parse(p.get("endDate") as string) - Date.parse(p.get("startDate") as string);
      expect(span).toBeLessThanOrEqual(BREVO_CAMPAIGN_WINDOW_MAX_MS);
    }
    // With only ONE bound, neither may be sent — they are mutually mandatory.
    const half = connector({
      routes: [{ match: /emailCampaigns/, responses: [{ body: { campaigns: [], count: 0 } }] }],
    });
    await half.c.listCampaigns({ from: "2026-01-01T00:00:00.000Z" });
    expect(half.f.paramKeys(0)).not.toContain("startDate");
    expect(half.f.paramKeys(0)).not.toContain("endDate");
  });

  it("answers a future-only campaign window with nothing, on ZERO fetch calls", async () => {
    // A bounded request that produced no windows asked only about the future.
    // Falling through to an unfiltered read would spend a hundred requests
    // against a 100/hour budget to return nothing.
    // Mutation: drop the `bounded && windows.length === 0` short-circuit → the
    // rows are still empty (the window filter catches them) and only the
    // zero-fetch assertion goes red.
    const { c, f } = connector({
      routes: [{ match: /emailCampaigns/, responses: [{ body: { campaigns: [], count: 0 } }] }],
    });
    const rows = await c.listCampaigns({
      from: "2030-01-01T00:00:00.000Z",
      to: "2030-02-01T00:00:00.000Z",
    });
    expect(rows).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("clamps a campaign window that runs into the future", () => {
    // "startDate must not be in the future" / "endDate must not be in the
    // future". A window ending at now+clock-skew is a 400 on the first run of
    // a new install.
    const windows = brevoCampaignWindows(NOW - 86_400_000, NOW + 86_400_000 * 30, NOW);
    expect(windows).toHaveLength(1);
    expect(Date.parse(windows[0].endDate)).toBeLessThanOrEqual(NOW);
    // Entirely in the future is a legitimate question with no answer.
    expect(brevoCampaignWindows(NOW + 1000, NOW + 2000, NOW)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

describe("pagination", () => {
  it("pins the documented per-endpoint `limit` ceilings", () => {
    // From the vendor's OpenAPI `schema.maximum` on each limit parameter:
    // /contacts 1000, /contacts/lists/{listId}/contacts 500, /contacts/lists
    // 50, /emailCampaigns 100, /orders 100. /crm/deals and /companies declare
    // NO maximum and are clamped to the documented default of 50 — there is no
    // ceiling to discover safely from outside.
    // Mutation: reuse /contacts' 1000 everywhere → red, and in production a
    // 20x over-cap request at /contacts/lists.
    expect(BREVO_MAX_PAGE_SIZE).toEqual({
      contact: 1000,
      audience: 50,
      audience_member: 500,
      campaign: 100,
      company: 50,
      deal: 50,
      ecommerce_order: 100,
    });
    expect(clampBrevoPageSize("audience", 1000)).toBe(50);
    expect(clampBrevoPageSize("contact", 1000)).toBe(1000);
    expect(clampBrevoPageSize("audience_member", 1000)).toBe(500);
    expect(clampBrevoPageSize("contact", 0)).toBe(1);
  });

  it("terminates on a SHORT page and never trusts `count`", async () => {
    // There is no cursor anywhere in this API, so a walk over a collection
    // mutating underneath cannot use a total as proof it saw everything. The
    // stub's `count` deliberately disagrees with reality.
    // Mutation: terminate on `rows.length >= count` → red (this stops one page
    // early or loops forever depending on the lie).
    const page = (n: number, from: number) => ({
      contacts: Array.from({ length: n }, (_, i) => ({ id: from + i, email: `p${from + i}@x.test` })),
      count: 9999,
    });
    const { c, f } = connector({
      routes: [
        {
          match: /\/contacts\?/,
          handler: (url) => {
            const offset = Number(url.searchParams.get("offset"));
            return { body: offset === 0 ? page(2, 0) : page(1, 2) };
          },
        },
      ],
    });
    const result = await c.listContacts({ pageSize: 2 });
    expect(result.rows).toHaveLength(3);
    expect(f.calls).toHaveLength(2);
    expect(f.params(0).get("offset")).toBe("0");
    expect(f.params(1).get("offset")).toBe("2");
  });

  it("pages DEALS with `offset` and COMPANIES with `page` — Brevo's own disagreement", async () => {
    // GET /crm/deals takes `offset`; GET /companies takes `page`, with the
    // identical description. A shared pager written against one and reused for
    // the other fails quietly.
    // Mutation: send `offset` to /companies → red here, and in production a
    // result set that is wrong-but-plausible rather than an error.
    const deals = connector({
      routes: [{ match: /crm\/deals/, responses: [{ body: { items: [] } }] }],
    });
    await deals.c.listDeals();
    expect(deals.f.paramKeys(0)).toContain("offset");
    expect(deals.f.paramKeys(0)).not.toContain("page");

    const companies = connector({
      routes: [{ match: /\/companies/, responses: [{ body: companyItems(["c0"]) }] }],
    });
    await companies.c.listCompanies({ pageSize: 2 });
    expect(companies.f.paramKeys(0)).not.toContain("offset");
  });

  it("MEASURES what /companies' `page` means — offset semantics", async () => {
    // The parameter is NAMED `page` but described "Index of the first document
    // of the page" — the identical string used for `offset` on /crm/deals. Two
    // of the three readings are silently wrong, so this is measured once per
    // connection rather than guessed.
    const ids = ["c0", "c1", "c2", "c3", "c4"];
    const { c } = connector({
      routes: [
        {
          match: /\/companies/,
          handler: (url) => {
            const raw = url.searchParams.get("page");
            const start = raw === null ? 0 : Number(raw);
            return { body: companyItems(ids.slice(start, start + 2)) };
          },
        },
      ],
    });
    const rows = await c.listCompanies({ pageSize: 2 });
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(c.companyPagingSemantics).toBe("offset");
  });

  it("MEASURES what /companies' `page` means — 1-based page numbers", async () => {
    // Mutation: assume offset semantics unconditionally → this walk sends
    // page=2 expecting documents 2-3 and receives page 2 (documents 2-3 under
    // this vendor's numbering is a coincidence of the fixture; on a real
    // account it skips 49 pages). The measurement is what makes it safe.
    const ids = ["c0", "c1", "c2", "c3", "c4"];
    const { c } = connector({
      routes: [
        {
          match: /\/companies/,
          handler: (url) => {
            const raw = url.searchParams.get("page");
            const pageNo = raw === null ? 1 : Number(raw);
            return { body: companyItems(ids.slice((pageNo - 1) * 2, (pageNo - 1) * 2 + 2)) };
          },
        },
      ],
    });
    const rows = await c.listCompanies({ pageSize: 2 });
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(c.companyPagingSemantics).toBe("page_from_one");
  });

  it("MEASURES what /companies' `page` means — 0-based page numbers", async () => {
    const ids = ["c0", "c1", "c2", "c3", "c4"];
    const { c } = connector({
      routes: [
        {
          match: /\/companies/,
          handler: (url) => {
            const pageNo = Number(url.searchParams.get("page") ?? 0);
            return { body: companyItems(ids.slice(pageNo * 2, pageNo * 2 + 2)) };
          },
        },
      ],
    });
    const rows = await c.listCompanies({ pageSize: 2 });
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(c.companyPagingSemantics).toBe("page_from_zero");
  });

  it("REFUSES a page parameter that does not advance, rather than duplicating rows", async () => {
    // A page parameter that does not advance produces duplicates, not an
    // error, and a duplicate set is a wrong answer nobody looks at twice.
    // Mutation: drop the seen-ids check → the walk returns the same two
    // companies 500 times and reports success.
    const { c } = connector({
      routes: [{ match: /\/companies/, responses: [{ body: companyItems(["c0", "c1"]) }] }],
    });
    await expect(c.listCompanies({ pageSize: 2 })).rejects.toThrow(BrevoPaginationContractError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Degraded responses — the 200-`[]`-on-an-outage defect class
// ─────────────────────────────────────────────────────────────────────────────

describe("a degraded call never renders as an empty dataset", () => {
  it("REFUSES a 200 whose envelope carries no `contacts` array, rather than reporting an empty account", async () => {
    // The `GET /api/files` 200-[]-on-an-outage defect, on a cloud track. A
    // renamed array, an error object served with status 200 or a
    // proxy-rewritten body all arrive here as a 200 with the documented key
    // missing. Returning [] for that makes the offset pager see 0 < limit,
    // terminate on the first page, and report zero rows as a CLEAN RESULT.
    // Mutation: `if (data === undefined || data === null) return [];` → this
    // resolves with `{ rows: [], watermark: undefined }` and every assertion
    // below goes red — which is precisely how the defect hides.
    const { c, f } = connector({
      routes: [{ match: /\/contacts\?/, responses: [{ body: { items: [], count: 0 } }] }],
    });
    const err = await rejection(() => c.listContacts());
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err.message).toContain("contacts");
    // One page attempted, and the walk stopped on the fault rather than
    // continuing to page a response it did not understand.
    expect(f.calls).toHaveLength(1);
  });

  it("REFUSES a null collection, and a 200 error envelope, on ORDERS — where [] reads as `you sold nothing`", async () => {
    // The dataset where the failure is most expensive to believe: an empty
    // order list is a revenue claim, and nobody double-checks a zero.
    // Mutation: default a null collection to [] → red.
    const nulled = connector({
      routes: [{ match: /\/orders/, responses: [{ body: { orders: null, count: 0 } }] }],
    });
    await expect(nulled.c.listOrders()).rejects.toThrow(ConnectorBlockedError);

    const errorEnvelope = connector({
      routes: [
        {
          match: /\/orders/,
          responses: [{ body: { code: "unavailable", message: "upstream is down" } }],
        },
      ],
    });
    const err = await rejection(() => errorEnvelope.c.listOrders());
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    // ...and the vendor's message still does not travel, even on this path.
    expect(err.message).not.toContain("upstream is down");
  });

  it("REFUSES a companies page whose `items` key is missing, on the pager AND on the semantics probe", async () => {
    // listCompanies does not use the shared pager — it measures its own page
    // parameter — so the envelope check has to hold on that path too.
    // Mutation: return [] for a missing key → the walk reports an account with
    // no companies, and `companyPagingSemantics` stays null with nothing red.
    const { c } = connector({
      routes: [{ match: /\/companies/, responses: [{ body: { count: 0 } }] }],
    });
    await expect(c.listCompanies({ pageSize: 2 })).rejects.toThrow(ConnectorBlockedError);
  });

  it("but a PRESENT-and-empty array is a real empty, on every collection this track reads", async () => {
    // The other half, and the reason the line is drawn at the envelope key
    // rather than at the row count: /companies, /crm/deals and /orders
    // legitimately return nothing on an account that never used Brevo's Sales
    // Platform or its e-commerce module, and that must stay a clean [].
    // Mutation: throw on a zero-length array too → red, and in production
    // every free-plan account looks broken.
    const audiences = connector({
      routes: [{ match: /\/contacts\/lists/, responses: [{ body: { lists: [], count: 0 } }] }],
    });
    await expect(audiences.c.listAudiences()).resolves.toEqual([]);

    const deals = connector({
      routes: [{ match: /crm\/deals/, responses: [{ body: { items: [] } }] }],
    });
    await expect(deals.c.listDeals()).resolves.toEqual([]);

    const companies = connector({
      routes: [{ match: /\/companies/, responses: [{ body: { items: [] } }] }],
    });
    await expect(companies.c.listCompanies()).resolves.toEqual([]);

    const orders = connector({
      routes: [{ match: /\/orders/, responses: [{ body: { orders: [], count: 0 } }] }],
    });
    await expect(orders.c.listOrders()).resolves.toEqual({ rows: [], watermark: undefined });
  });

  it("still refuses a non-object body and a non-array collection", async () => {
    const scalar = connector({
      routes: [{ match: /\/contacts\?/, responses: [{ body: "gateway timeout" }] }],
    });
    await expect(scalar.c.listContacts()).rejects.toThrow(ConnectorBlockedError);

    const wrongType = connector({
      routes: [{ match: /\/contacts\?/, responses: [{ body: { contacts: { id: 1 } } }] }],
    });
    await expect(wrongType.c.listContacts()).rejects.toThrow(ConnectorBlockedError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical projection — including the money conversion
// ─────────────────────────────────────────────────────────────────────────────

describe("canonical projection", () => {
  it("serves exactly the seven datasets, all of which already exist in the vocabulary", () => {
    expect([...BREVO_DATASETS].sort()).toEqual([
      "audience",
      "audience_member",
      "campaign",
      "company",
      "contact",
      "deal",
      "ecommerce_order",
    ]);
    for (const dataset of BREVO_DATASETS) {
      expect(DATASETS).toContain(dataset);
      expect(CANONICAL_COLUMNS[dataset].length).toBeGreaterThan(0);
    }
    expect(BREVO_PROVIDER).toBe("brevo");
  });

  it("treats Brevo money as MAJOR units already — a 2000 order is 2000, not 20", async () => {
    // The single most dangerous reflex on this track. Brevo's own order
    // schema: `amount` is "Total amount of the order, including all shipping
    // expenses, tax and the price of items", example 308.42 — a DECIMAL in
    // major units. The vendor's own /orders response example uses
    // `amount: 2000`. A reader arriving from ../stripe/connector.ts, where
    // every figure is a minor-unit integer that MUST be divided by 100, would
    // apply the same conversion here and understate every Brevo figure 100x —
    // silently, because 20.00 is as plausible a number as 2000.00.
    // Mutation: `amount / 100` anywhere on this path → red.
    expect(brevoMajorUnits(2000)).toBe(2000);
    expect(brevoMajorUnits(308.42)).toBe(308.42);
    // Absent stays absent: a missing amount must not become 0.
    expect(brevoMajorUnits(undefined)).toBeUndefined();
    expect(brevoMajorUnits("")).toBeUndefined();

    const { c } = connector({
      routes: [
        { match: /displayCurrency/, responses: [{ body: { code: "EUR" } }] },
        {
          match: /\/orders/,
          responses: [
            {
              body: {
                count: 1,
                orders: [
                  {
                    id: "order1803",
                    amount: 2000,
                    storeId: "123",
                    contact_id: 2,
                    createdAt: "2021-12-31T11:42:35.638Z",
                    updatedAt: "2022-03-03T14:48:31.867Z",
                    status: "complete",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_ecommerce_orders", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].total_amount).toBe(2000);
    expect(rows[0].currency).toBe("EUR");
    expect(rows[0].processed_at).toBe("2021-12-31T11:42:35.638Z");
    expect(rows[0].store_id).toBe("123");
    expect(rows[0].customer_id).toBe("2");
    // The row carries EXACTLY the canonical columns — no vendor billing
    // address, no coupon list, no product array.
    expect(Object.keys(rows[0])).toEqual([...CANONICAL_COLUMNS.ecommerce_order]);
  });

  it("resolves the order currency from the ACCOUNT, because an order has none", async () => {
    // A Brevo order carries no currency field at all. The account has one
    // ISO-4217 e-commerce display currency and that endpoint is the only
    // currency fact the API exposes for orders.
    // Mutation: hardcode "USD", or emit the amount with an undefined currency
    // → red. REQUIRED_CANONICAL.ecommerce_order demands both.
    expect(REQUIRED_CANONICAL.ecommerce_order).toContain("currency");
    const { c, f } = connector({
      routes: [
        { match: /displayCurrency/, responses: [{ body: { code: "gbp" } }] },
        { match: /\/orders/, responses: [{ body: { count: 0, orders: [] } }] },
      ],
    });
    await c.runRead("get_ecommerce_orders", {});
    expect(f.paths()[0]).toBe(`/v3${BREVO_DISPLAY_CURRENCY_PATH}`);
    expect((await c.status()).displayCurrency).toBe("GBP");
  });

  it("reports e-commerce-not-activated as a CAPABILITY, never as an empty order list", async () => {
    // GET /ecommerce/config/displayCurrency answers "403 Permission denied.
    // eCommerce is not activated." An empty array here reads as "you sold
    // nothing", which is a confident false statement nobody can falsify.
    // Mutation: catch the 403 and return [] → red.
    const { c } = connector({
      routes: [
        { match: /displayCurrency/, responses: [{ status: 403, body: { code: "permission_denied", message: "eCommerce is not activated" } }] },
        { match: /\/orders/, responses: [{ body: { count: 0, orders: [] } }] },
      ],
    });
    await expect(c.runRead("get_ecommerce_orders", {})).rejects.toThrow(BrevoCapabilityMissingError);
  });

  it("reads `uniqueSubscribers` for member_count — `totalSubscribers` is being retired to 0", async () => {
    // The vendor's own note on GET /contacts/lists: "We're dropping support
    // for the response attributes totalSubscribers and totalBlacklisted. These
    // are non breaking changes. The default value for the attributes will be
    // 0." REQUIRED_CANONICAL.audience demands member_count, so reading the
    // retired field makes every audience report zero members and say so
    // confidently — the marketing twin of a bill with no balance.
    // Mutation: read `totalSubscribers` first → red, and in production every
    // list shows 0 members.
    expect(REQUIRED_CANONICAL.audience).toContain("member_count");
    const { c } = connector({
      routes: [
        {
          match: /\/contacts\/lists/,
          responses: [
            {
              body: {
                count: 1,
                lists: [
                  { id: 53, name: "Spanish_Speakers", folderId: 1, totalSubscribers: 0, totalBlacklisted: 0, uniqueSubscribers: 1789 },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_audiences", {})) as Record<string, unknown>[];
    expect(rows[0].member_count).toBe(1789);
    expect(rows[0].audience_id).toBe("53");
    expect(Object.keys(rows[0])).toEqual([...CANONICAL_COLUMNS.audience]);
  });

  it("leaves campaign `emails_sent` ABSENT past the 6-month statistics horizon, never 0", async () => {
    // "This option only returns data for events that occurred in the last 6
    // months. For older campaigns, it is advisable to use the Get Campaign
    // Report endpoint." So an older campaign comes back with no statistics
    // block. A 0 here is a false statement about a send that really happened,
    // and emails_sent is the column this dataset is REQUIRED to carry.
    // Mutation: `?? 0` on the statistics read → red.
    expect(REQUIRED_CANONICAL.campaign).toContain("emails_sent");
    const { c } = connector({
      routes: [
        {
          match: /emailCampaigns/,
          responses: [
            {
              body: {
                count: 2,
                campaigns: [
                  {
                    id: 12,
                    name: "Recent",
                    subject: "20% OFF",
                    status: "sent",
                    sentDate: "2026-08-01T12:30:00Z",
                    scheduledAt: "2026-08-01T12:00:00Z",
                    recipients: { lists: [5], exclusionLists: [] },
                    statistics: { globalStats: { sent: 19887, uniqueViews: 7779, uniqueClicks: 2300, viewed: 8999 } },
                  },
                  {
                    id: 13,
                    name: "Ancient",
                    subject: "Older than the horizon",
                    status: "sent",
                    sentDate: "2020-01-01T12:30:00Z",
                    recipients: { lists: [5], exclusionLists: [] },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_campaign_performance", {})) as Record<string, unknown>[];
    const recent = rows.find((r) => r.campaign_id === "12");
    const ancient = rows.find((r) => r.campaign_id === "13");
    expect(recent?.emails_sent).toBe(19887);
    // `uniqueViews`, not `viewed`: the raw total counts one recipient opening
    // four times as four, which makes an open rate exceed 100%.
    expect(recent?.opens_unique).toBe(7779);
    expect(recent?.clicks_unique).toBe(2300);
    expect(ancient?.emails_sent).toBeUndefined();
    // ...and the boundary is PUBLISHED rather than left to be discovered as a
    // column of absent values. A scheduler pricing a campaign backfill reads
    // it; an operator on a connection card sees the hole is the vendor's.
    // Mutation: drop `campaignStatsHorizonStart` from the status object, or
    // stop reading BREVO_CAMPAIGN_STATS_HORIZON_MS to build it → red, and the
    // constant goes back to documenting a horizon nothing acts on.
    const horizon = (await c.status()).campaignStatsHorizonStart;
    expect(horizon).toBe(new Date(NOW - BREVO_CAMPAIGN_STATS_HORIZON_MS).toISOString());
    // Six months, not six weeks: the ancient campaign above is outside it and
    // the recent one is inside.
    expect(Date.parse(horizon)).toBeLessThan(Date.parse("2026-08-01T12:30:00Z"));
    expect(Date.parse(horizon)).toBeGreaterThan(Date.parse("2020-01-01T12:30:00Z"));
  });

  it("takes campaign `sent_at` from sentDate ONLY — never from scheduledAt", async () => {
    // sentDate is "only available if 'status' of the campaign is 'sent'".
    // Falling back to scheduledAt would report a send that has not happened
    // for every scheduled campaign on the account.
    // Mutation: `record.sentDate ?? record.scheduledAt` → red.
    const { c } = connector({
      routes: [
        {
          match: /emailCampaigns/,
          responses: [
            {
              body: {
                count: 1,
                campaigns: [
                  {
                    id: 22,
                    name: "Scheduled but not sent",
                    subject: "Next week",
                    status: "queued",
                    scheduledAt: "2026-12-01T12:30:00Z",
                    recipients: { lists: [10], exclusionLists: [] },
                    statistics: { globalStats: { sent: 0, uniqueViews: 0, uniqueClicks: 0 } },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_campaign_performance", {})) as Record<string, unknown>[];
    expect(rows[0].sent_at).toBeUndefined();
    expect(rows[0].status).toBe("queued");
    // One targeted list means audience_id is answerable...
    expect(rows[0].audience_id).toBe("10");
  });

  it("leaves campaign `audience_id` absent when a send targeted MORE THAN ONE list", async () => {
    // A canonical column that holds one id cannot honestly describe a send to
    // four. Picking the first element reports a four-list send as a one-list
    // send, which is a wrong answer rather than a partial one.
    // Mutation: `recipients.lists[0]` → red.
    const { c } = connector({
      routes: [
        {
          match: /emailCampaigns/,
          responses: [
            {
              body: {
                count: 1,
                campaigns: [
                  {
                    id: 31,
                    subject: "Everyone",
                    status: "sent",
                    sentDate: "2026-08-02T09:00:00Z",
                    recipients: { lists: [5, 10, 12], exclusionLists: [] },
                    statistics: { globalStats: { sent: 10, uniqueViews: 1, uniqueClicks: 0 } },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_campaign_performance", {})) as Record<string, unknown>[];
    expect(rows[0].audience_id).toBeUndefined();
  });

  it("derives a membership's subscription status, resolving every branch to do-not-mail", () => {
    // Brevo publishes NO per-list status string. The state is derived from
    // `listUnsubscribed` (which is "only available if unsubscription per list
    // is activated for the account", so its absence proves nothing) and the
    // account-wide `emailBlacklisted`. Mailing somebody who unsubscribed is
    // the one unrecoverable mistake this dataset can cause.
    // Mutation: return "subscribed" when listUnsubscribed is absent but
    // emailBlacklisted is true → red, and in production a send to somebody who
    // opted out.
    expect(brevoSubscriptionStatus({ listUnsubscribed: [1, 5] }, "5")).toBe("unsubscribed");
    expect(brevoSubscriptionStatus({ emailBlacklisted: true }, "5")).toBe("unsubscribed");
    expect(brevoSubscriptionStatus({ listUnsubscribed: [1] }, "5")).toBe("subscribed");
    expect(brevoSubscriptionStatus({}, "5")).toBe("subscribed");
    expect(REQUIRED_CANONICAL.audience_member).toContain("subscription_status");
  });

  it("keys a membership by LIST AND CONTACT, so a contact on four lists is four rows", async () => {
    // A Brevo contact id is ACCOUNT-WIDE, so the bare id repeats in every list
    // the contact belongs to. Any store keyed by (dataset, id) would collapse
    // four memberships into one and lose three silently.
    // Mutation: use the bare contact id → red.
    expect(brevoMemberId("5", "45")).toBe(`5${BREVO_MEMBER_ID_SEPARATOR}45`);
    const { c } = connector({
      routes: [
        {
          match: /\/contacts\/lists\/5\/contacts/,
          responses: [
            {
              body: {
                count: 1,
                contacts: [
                  {
                    id: 45,
                    email: "alex.pain@example.test",
                    attributes: { FIRSTNAME: "Alex", LASTNAME: "Pain" },
                    createdAt: "2017-05-12T12:30:00Z",
                    modifiedAt: "2026-09-01T12:30:00Z",
                    listIds: [5, 9],
                    listUnsubscribed: [9],
                    emailBlacklisted: false,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_audience_members", { audienceId: "5" })) as Record<string, unknown>[];
    expect(rows[0].audience_member_id).toBe("5:45");
    expect(rows[0].audience_id).toBe("5");
    expect(rows[0].subscription_status).toBe("subscribed");
    expect(rows[0].updated_at).toBe("2026-09-01T12:30:00.000Z");
    // Consent evidence is NOT synthesised from `createdAt`: when the row was
    // made is not when the person agreed to anything.
    expect(rows[0].opted_in_at).toBeUndefined();
    expect(Object.keys(rows[0])).toEqual([...CANONICAL_COLUMNS.audience_member]);
  });

  it("WITHHOLDS a deal amount when no currency is known, and emits it when one is", async () => {
    // Brevo publishes no currency for a CRM deal: the object carries a bare
    // `amount` and there is no CRM equivalent of the e-commerce display
    // currency. profiles.ts exists partly to make money-without-currency
    // unrepresentable — "an amount whose currency must be guessed is not a
    // number" — and borrowing the e-commerce setting would be a different
    // subsystem's value wearing this one's name.
    // Mutation: emit the amount with an undefined currency → red.
    const body = {
      items: [
        {
          id: "629475917295261d9b1f4403",
          attributes: {
            amount: 12,
            deal_name: "testname",
            deal_stage: "9e577ff7-8e42-4ab3-be26-2b5e01b42518",
            created_at: "2022-05-30T07:42:05.671Z",
            last_updated_date: "2026-09-01T08:38:36.761Z",
          },
          linkedCompaniesIds: ["61a5ce58c5d4795761045990"],
        },
      ],
    };
    const silent = connector({ routes: [{ match: /crm\/deals/, responses: [{ body }] }] });
    const withheld = (await silent.c.runRead("get_deals_by_stage", {})) as Record<string, unknown>[];
    expect(withheld[0].amount).toBeUndefined();
    expect(withheld[0].currency).toBeUndefined();
    // The rest of the deal is still served — the stage is an opaque id, which
    // is what the vendor's own filter takes.
    expect(withheld[0].stage).toBe("9e577ff7-8e42-4ab3-be26-2b5e01b42518");
    expect(withheld[0].company_id).toBe("61a5ce58c5d4795761045990");
    expect(withheld[0].updated_at).toBe("2026-09-01T08:38:36.761Z");

    const stated = connector({
      dealCurrency: "eur",
      routes: [{ match: /crm\/deals/, responses: [{ body }] }],
    });
    const emitted = (await stated.c.runRead("get_deals_by_stage", {})) as Record<string, unknown>[];
    expect(emitted[0].amount).toBe(12);
    expect(emitted[0].currency).toBe("EUR");
  });

  it("re-applies the stage predicate on the PROJECTED rows, not only in the query", async () => {
    // The vendor filter is pushed down to keep the read cheap, but an unknown
    // query parameter is assumed to be IGNORED rather than rejected — so if
    // `filters[attributes.deal_stage]` ever stops being the parameter name,
    // Brevo returns every deal and a query-only filter would label them all as
    // being in the requested stage.
    // Mutation: drop the client-side pass → red (the stub deliberately ignores
    // the filter, exactly as the vendor is assumed to).
    const { c, f } = connector({
      routes: [
        {
          match: /crm\/deals/,
          responses: [
            {
              body: {
                items: [
                  { id: "d1", attributes: { deal_name: "Wanted", deal_stage: "stage-a" } },
                  { id: "d2", attributes: { deal_name: "Other", deal_stage: "stage-b" } },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_deals_by_stage", { stage: "stage-a" })) as Record<string, unknown>[];
    expect(rows.map((r) => r.deal_id)).toEqual(["d1"]);
    expect(f.params(0).get("filters[attributes.deal_stage]")).toBe("stage-a");
  });

  it("reads contact names from the account's OWN attribute spellings, and guesses none", async () => {
    // The attributes bag is account-defined and the vendor's own examples
    // disagree: /contacts shows FIRST_NAME/LAST_NAME, the list-membership
    // endpoint shows FIRSTNAME/LASTNAME. An account that renamed the attribute
    // gets an absent name rather than somebody else's field.
    const { c } = connector({
      routes: [
        {
          match: /\/contacts\?/,
          responses: [
            {
              body: {
                count: 2,
                contacts: [
                  { id: 247, email: "meg@example.test", attributes: { FIRST_NAME: "Meg", LAST_NAME: "Brennon" }, createdAt: "2017-05-01T17:05:03Z", modifiedAt: "2026-09-01T17:05:03Z" },
                  { id: 248, email: "sophia@example.test", attributes: { FIRSTNAME: "Sophia", LASTNAME: "Press" }, createdAt: "2017-05-01T17:05:03Z", modifiedAt: "2026-09-02T17:05:03Z" },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("find_contact", { query: "bre" })) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].last_name).toBe("Brennon");
    expect(rows[0].first_name).toBe("Meg");
    expect(rows[0].contact_id).toBe("247");
    // Brevo has no lifecycle-stage concept and no company link on a contact;
    // neither is substituted from a list membership or a blacklist flag.
    expect(rows[0].lifecycle_stage).toBeUndefined();
    expect(rows[0].company_id).toBeUndefined();
    expect(Object.keys(rows[0])).toEqual([...CANONICAL_COLUMNS.contact]);
  });

  it("refuses a read whose dataset this track does not serve", async () => {
    const { c, f } = connector();
    await expect(c.runRead("get_open_invoices", {})).rejects.toThrow(DatasetNotServedError);
    expect(f.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocked boundary — nothing wired, nothing half-authenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("blocked boundary", () => {
  it("blocks every I/O method with NO credential, on ZERO fetch calls", async () => {
    // ADR-041 §2: ships off, and the owner's consent is the enabling event. A
    // connector that half-authenticates is worse than one that refuses.
    // Mutation: default the resolver to a no-op returning "" → red.
    const { c, f } = connector({ blocked: true });
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
    await expect(c.health()).rejects.toThrow(ConnectorBlockedError);
    await expect(c.listAudiences()).rejects.toThrow(ConnectorBlockedError);
    await expect(c.runRead("get_audiences", {})).rejects.toThrow(ConnectorBlockedError);
    await expect(c.resolveDisplayCurrency()).rejects.toThrow(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("reports `disconnected` without inventing a connected state", async () => {
    const { c } = connector({ blocked: true });
    const status = await c.status();
    expect(status.state).toBe("disconnected");
    expect(status.ok).toBe(false);
    expect(status.hasApiKey).toBe(false);
    // The status object carries the vendor facts a caller needs and no key
    // material of any kind.
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(status.scanModes).toEqual(BREVO_SCAN_MODE);
    expect(status.deltaParams).toEqual(BREVO_DELTA_PARAM);
  });

  it("is READ-ONLY: applyWrite refuses on ZERO fetch calls", async () => {
    // The customer's key can send email from their own domain and delete
    // their contacts. None of that is a later ticket.
    // Mutation: implement any write → red.
    const { c, f } = connector();
    // A REGISTERED command name, so the refusal comes from this track rather
    // than from the registry rejecting an unknown name — the two are different
    // failures and only one of them is the property under test.
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toThrow(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses the send and order-creation paths by SHAPE, and unknown resources by allowlist", () => {
    // A resource allowlist alone is not enough: `emailCampaigns` and `orders`
    // are legitimately readable, and the mutation verbs live under them.
    // Mutation: drop the forbidden-segment check → red.
    expect(() => assertReadableBrevoResource("/emailCampaigns/12/sendNow")).toThrow(ConnectorBlockedError);
    expect(() => assertReadableBrevoResource("/orders/status")).toThrow(ConnectorBlockedError);
    expect(() => assertReadableBrevoResource("/smtp/email")).toThrow(ConnectorBlockedError);
    expect(() => assertReadableBrevoResource("/transactionalSMS/sms")).toThrow(ConnectorBlockedError);
    // ...and the paths this connector actually uses all pass.
    expect(() => assertReadableBrevoResource(BREVO_ACCOUNT_PATH)).not.toThrow();
    expect(() => assertReadableBrevoResource(BREVO_DISPLAY_CURRENCY_PATH)).not.toThrow();
    for (const path of Object.values(BREVO_ENDPOINTS)) {
      expect(() => assertReadableBrevoResource(path.replace("{listId}", "5"))).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vendor errors — the CODE reaches the caller, the MESSAGE never does
// ─────────────────────────────────────────────────────────────────────────────

describe("vendor errors", () => {
  it("surfaces the vendor's error CODE and status, never its MESSAGE", async () => {
    // Brevo's own errorModel example quotes request state back at the caller
    // ("email is already associated with another Contact"), so propagating the
    // message writes whatever the request contained into every log line that
    // renders the error.
    // Mutation: append `body.message` to the thrown error → red.
    const { c } = connector({
      routes: [
        {
          match: /\/account/,
          responses: [
            { status: 400, body: { code: "invalid_parameter", message: "the value 'jane@customer.test' is invalid" } },
          ],
        },
      ],
    });
    const err = await rejection(() => c.connect());
    expect(err.message).toContain("400");
    expect(err.message).toContain("invalid_parameter");
    expect(err.message).not.toContain("jane@customer.test");
    expect(err.message).not.toContain("the value");
  });

  it("degrades to the bare status when the vendor's `code` is free text", () => {
    // Brevo's own code enum mixes token-shaped codes with sentences
    // ("Returned when query params are invalid"), and `code` is not even
    // required — only `message` is. So a code is surfaced only when it looks
    // like a code.
    expect(brevoErrorCode({ code: "permission_denied" })).toBe("permission_denied");
    expect(brevoErrorCode({ code: "Returned when query params are invalid" })).toBeUndefined();
    expect(brevoErrorCode({ message: "no code at all" })).toBeUndefined();
    expect(brevoErrorCode(null)).toBeUndefined();
  });

  it("turns a 401 into a re-authorisation error that ENUMERATES all four causes", async () => {
    // Brevo answers a deleted key, an expired key, a deactivated key and a
    // blocked IP with the same status. The box cannot tell them apart, so
    // asserting one would send the customer to fix something that is not
    // broken.
    // Mutation: name only "the key was revoked" → red.
    const { c } = connector({
      routes: [{ match: /\/account/, responses: [{ status: 401, body: { code: "unauthorized", message: "Key not found" } }] }],
    });
    const err = await rejection(() => c.connect());
    expect(err).toBeInstanceOf(BrevoReauthorizationRequiredError);
    expect(BREVO_UNAUTHORIZED_CAUSES).toHaveLength(4);
    expect(err.message).toContain("EXPIRED");
    expect(err.message).toContain("DEACTIVATED");
    expect(err.message).toContain("Authorized IPs");
    expect(err.message).not.toContain(KEY);
  });

  it("separates an IP block from a dead key — the remedy is the opposite", async () => {
    // "When enabled, Brevo validates the source IP address of each API
    // request. Requests from unauthorized IPs are blocked even if the API key
    // is valid." Brevo arms this BY ITSELF 30 days after the last new IP, so
    // every box on a dynamic WAN address is on a fuse.
    // Mutation: fold this into the 401 branch → red, and in production a
    // customer regenerates a key that was never the problem.
    const { c } = connector({
      routes: [
        {
          match: /\/account/,
          responses: [{ status: 401, body: { code: "unauthorized", message: "Your IP address 203.0.113.9 is not authorized" } }],
        },
      ],
    });
    const err = await rejection(() => c.connect());
    expect(err).toBeInstanceOf(BrevoIpBlockedError);
    expect(err.message).toContain("Authorized IPs");
    // The classifying body is read but NOT propagated — the customer's WAN
    // address does not belong in a log line.
    expect(err.message).not.toContain("203.0.113.9");
    expect((await c.status()).state).toBe("ip_blocked");
  });

  it("backs off on the vendor's RESET header, because Brevo documents no Retry-After", async () => {
    // "Rate limit headers are included in all responses": Brevo sends
    // x-sib-ratelimit-limit / -remaining / -reset and NO Retry-After. A
    // connector looking for the standard header finds nothing and retries
    // straight into another 429.
    // Mutation: read `retry-after` → red (the stub sends only the sib header),
    // and the backoff silently becomes the exponential fallback.
    const sleeps: number[] = [];
    const { c } = connector({
      sleeps,
      routes: [
        {
          match: /\/account/,
          responses: [
            { status: 429, headers: { [BREVO_RATE_LIMIT_RESET_HEADER]: "7" } },
            { body: { companyName: "Acme" } },
          ],
        },
      ],
    });
    await c.connect();
    expect(sleeps).toEqual([7000]);
  });

  it("gives up after the retry budget rather than hammering a 429 forever", async () => {
    const sleeps: number[] = [];
    const { c, f } = connector({
      sleeps,
      routes: [{ match: /\/account/, responses: [{ status: 429 }] }],
    });
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
    // Four attempts: the initial one plus BREVO_MAX_RATE_LIMIT_RETRIES.
    expect(f.calls).toHaveLength(4);
    // No reset header, so the fallback is exponential rather than a hot loop.
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rate budget — two meters 360x apart
// ─────────────────────────────────────────────────────────────────────────────

describe("rate budget", () => {
  it("charges the BARE /contacts collection to the slow group, conservatively", () => {
    // Brevo's fast row is written "/v3/contacts/{…}" — with the braces — so
    // whether the bare collection sits inside the 36,000 RPH group or falls to
    // the 100 RPH catch-all is NOT stated. Under-consuming costs latency;
    // over-consuming costs 429s. Resolving it needs one successful
    // authenticated call against a real account: a live 401 carries no
    // x-sib-ratelimit-* header at all, so the ambiguity cannot be settled from
    // a failed call.
    // Mutation: charge /contacts to the fast group on a hunch → red.
    expect(brevoRateGroup("/contacts")).toBe("other");
    expect(brevoRateGroup("/contacts/lists")).toBe("contacts");
    expect(brevoRateGroup("/contacts/lists/5/contacts")).toBe("contacts");
    expect(brevoRateGroup("/emailCampaigns")).toBe("other");
    expect(brevoRateGroup("/account")).toBe("other");
    expect(BREVO_DEFAULT_RATE_LIMIT_PER_HOUR).toBe(100);
  });

  it("stops on an exhausted group BEFORE the request goes out", async () => {
    // The budget is per endpoint group and not per connection: at 100
    // calls/hour applied connection-wide, one contacts backfill at limit=1000
    // is exactly 100 pages and would starve every other dataset.
    // Mutation: charge after the fetch → the assertion on call count goes red.
    const budget = new BrevoCallBudget(() => NOW, { other: 2 });
    const { c, f } = connector({
      budget,
      routes: [{ match: /\/account/, responses: [{ body: {} }] }],
    });
    await c.connect();
    await c.probeAccount();
    await expect(c.probeAccount()).rejects.toThrow(BrevoRateBudgetExhaustedError);
    expect(f.calls).toHaveLength(2);
    expect((await c.status()).budget.other).toEqual({ spent: 2, ceiling: 2 });
  });

  it("resets a group's meter when its hour rolls over", () => {
    let clock = NOW;
    const budget = new BrevoCallBudget(() => clock, { other: 1 });
    budget.charge("other");
    expect(() => budget.charge("other")).toThrow(BrevoRateBudgetExhaustedError);
    clock += 3_600_000;
    expect(() => budget.charge("other")).not.toThrow();
  });

  it("charges NOTHING when the credential does not resolve — the meter counts calls, not attempts", async () => {
    // A disconnected connection polled on a schedule would otherwise burn its
    // own 100/hour allowance on requests that never leave the box: the meter
    // on the connection card reads high, nothing was actually spent, and the
    // first real call after a reconnect is refused by a budget nobody
    // consumed.
    // Mutation: charge before `await this.key()` → the spend is 3 and this
    // goes red, while every other test in this file stays green.
    const budget = new BrevoCallBudget(() => NOW, { other: 2 });
    const { c, f } = connector({ budget, blocked: true });
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
    await expect(c.listAudiences()).rejects.toThrow(ConnectorBlockedError);
    await expect(c.resolveDisplayCurrency()).rejects.toThrow(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
    const status = await c.status();
    expect(status.budget.other).toEqual({ spent: 0, ceiling: 2 });
    expect(status.budget.contacts.spent).toBe(0);
    // An EMPTY stored credential is the same story: refused before the meter.
    const empty = connector({ key: "   ", budget: new BrevoCallBudget(() => NOW, { other: 2 }) });
    await expect(empty.c.connect()).rejects.toThrow(ConnectorBlockedError);
    expect((await empty.c.status()).budget.other.spent).toBe(0);
  });

  it("spends the SLOW meter on a bare /contacts backfill, exactly as the file's own reasoning says", async () => {
    // The two-meter design is justified in the module docstring by a contacts
    // backfill — and then `brevoRateGroup` charges the bare collection to the
    // 100/hour group, so the mitigation does not cover the hazard that
    // motivated it. That is deliberate caution (the vendor's fast row is
    // written "/v3/contacts/{…}", with the braces, and over-consuming costs
    // 429s), but it has a consequence a caller must be able to see: page 101
    // of an unbounded find_contact throws rather than returning a partial
    // answer. Pinned here so the code and the prose cannot drift apart again.
    // Mutation: move the bare collection to the fast group on a hunch → red,
    // and the docstring's caution silently stops being true.
    expect(brevoRateGroup("/contacts")).toBe("other");
    expect(BREVO_CONTACTS_RATE_LIMIT_PER_HOUR / BREVO_DEFAULT_RATE_LIMIT_PER_HOUR).toBe(360);
    const budget = new BrevoCallBudget(() => NOW, { other: 2 });
    const { c, f } = connector({
      budget,
      routes: [
        {
          match: /\/contacts\?/,
          handler: (url) => {
            const offset = Number(url.searchParams.get("offset"));
            return { body: { contacts: [{ id: offset }, { id: offset + 1 }], count: 9999 } };
          },
        },
      ],
    });
    const err = await rejection(() => c.listContacts({ pageSize: 2 }));
    expect(err).toBeInstanceOf(BrevoRateBudgetExhaustedError);
    expect((err as BrevoRateBudgetExhaustedError).group).toBe("other");
    // Two pages went out and the third never did — a reported budget, not a
    // silently truncated read.
    expect(f.calls).toHaveLength(2);
  });

  it("PACES the fast group's 10-per-second burst instead of refusing it", async () => {
    // 36,000 calls an hour permits a thousand of them inside one second, which
    // is a hundredfold over Brevo's documented burst row — so the hourly meter
    // cannot express this ceiling and a constant recording it enforces
    // nothing. A membership backfill is a legitimate read, so the ceiling is a
    // WAIT rather than a refusal.
    // Mutation: delete paceMs, or return 0 unconditionally → red.
    expect(BREVO_CONTACTS_RATE_LIMIT_PER_SECOND).toBe(10);
    const budget = new BrevoCallBudget(() => NOW);
    for (let i = 0; i < BREVO_CONTACTS_RATE_LIMIT_PER_SECOND; i += 1) {
      expect(budget.paceMs("contacts")).toBe(0);
    }
    expect(budget.paceMs("contacts")).toBe(1000);
    // Virtual time: the window advances by a second whether or not the clock
    // does, so a frozen clock cannot spin and the next second's slots open in
    // order rather than all at once.
    for (let i = 0; i < BREVO_CONTACTS_RATE_LIMIT_PER_SECOND - 1; i += 1) {
      expect(budget.paceMs("contacts")).toBe(1000);
    }
    expect(budget.paceMs("contacts")).toBe(2000);
    // Brevo publishes NO per-second row for the catch-all group, and one is
    // not invented — a delay with no vendor fact behind it is just latency.
    const other = new BrevoCallBudget(() => NOW);
    for (let i = 0; i < 50; i += 1) expect(other.paceMs("other")).toBe(0);
    // A real second elapsing reopens the window.
    let clock = NOW;
    const moving = new BrevoCallBudget(() => clock);
    for (let i = 0; i < BREVO_CONTACTS_RATE_LIMIT_PER_SECOND; i += 1) moving.paceMs("contacts");
    clock += 1000;
    expect(moving.paceMs("contacts")).toBe(0);
  });

  it("actually WAITS out the burst on the wire, before the request goes out", async () => {
    // The unit above proves the meter; this proves it is wired. A pacer
    // nothing awaits is the same unenforced ceiling in a different place.
    // Mutation: compute the pace and drop it on the floor → the sleeps array
    // is empty and this goes red while every other test stays green.
    const sleeps: number[] = [];
    const budget = new BrevoCallBudget(() => NOW, {}, { contacts: 2 });
    const { c, f } = connector({
      budget,
      sleeps,
      routes: [
        {
          match: /\/contacts\/lists\/5\/contacts/,
          handler: (url) => {
            const offset = Number(url.searchParams.get("offset"));
            return { body: { contacts: offset < 2 ? [{ id: offset }] : [], count: 2 } };
          },
        },
      ],
    });
    await c.listAudienceMembers("5", { pageSize: 1 });
    expect(f.calls).toHaveLength(3);
    // The first two calls fit inside the burst; the third waits for the next
    // window rather than being refused, and the read still completes.
    expect(sleeps).toEqual([1000]);
  });
});
