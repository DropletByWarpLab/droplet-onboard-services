/**
 * WARP-2317 — HubSpotConnector.
 *
 * `fetch` is INJECTED, never patched globally, and every test asserts on the
 * CALLS the connector made — not only on what it returned. That distinction is
 * load-bearing here more than anywhere: the host guard, the account-keyed
 * Search governor, the 10,000-record re-anchoring and the Exports backfill are
 * all promises about requests that must NOT happen (or must happen to a
 * particular path, at a particular rate), and a test that inspects only the
 * return value passes even when the request already went out.
 *
 * Every test names the mutation that must turn it red.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";

import {
  HUBSPOT_API_ROUTES,
  HUBSPOT_API_VERSION,
  HUBSPOT_BACKFILL_MAX_ATTEMPTS,
  HUBSPOT_BACKOFF_BASE_MS,
  HUBSPOT_DATASETS,
  HUBSPOT_MAX_RATE_LIMIT_RETRIES,
  HUBSPOT_PRODUCTION_BASE_URL,
  HUBSPOT_PROVIDER,
  HUBSPOT_READABLE_RESOURCES,
  HUBSPOT_SEARCH_CONSISTENCY_OVERLAP_MS,
  HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND,
  HUBSPOT_SEARCH_PAGE_SIZE,
  HUBSPOT_SEARCH_RESULT_CAP,
  HUBSPOT_SUPER_ADMIN_REMEDIATION,
  HUBSPOT_TIER_GATED_RESOURCES,
  HUBSPOT_WRITABLE_OBJECTS,
  HubSpotBackfillInProgressError,
  HubSpotCapabilityUnavailableError,
  HubSpotConfirmationRequiredError,
  HubSpotConnector,
  HubSpotQuotaExhaustedError,
  HubSpotReauthorizationRequiredError,
  HubSpotSearchRateLimitedError,
  HubSpotSuperAdminRevokedError,
  HubSpotWatermarkStallError,
  InvalidHubspotCredentialError,
  UnsafeHubspotBaseUrlError,
  assertHubspotPrivateAppToken,
  assertReadableHubspotObject,
  assertSafeHubspotBaseUrl,
  assertWritableHubspotObject,
  hubspotPath,
  hubspotResourceOf,
  resetSearchGovernors,
} from "../src/hubspot/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { CANONICAL_COLUMNS, COLUMN_KIND, DATASETS } from "../src/export-drop/profiles.js";

/** 2026-08-27T12:00:00Z, the wall clock every test starts on. */
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
/**
 * A private app token carrying HubSpot's `pat-<region>-` prefix — which is all
 * {@link assertHubspotPrivateAppToken} gates on — and a body that is
 * deliberately NOT the UUID shape a real one has.
 *
 * The prefix is kept because the redaction assertions check for it by name. The
 * body is not, because a UUID-shaped fixture matches GitHub's "Hubspot API Key"
 * push-protection detector and blocks the push outright. `__tests__/` is
 * allowlisted in `.gitleaks.toml`, so gitleaks passes either way — GitHub's
 * secret scanning is a second, independent gate, and the right answer to it is
 * a fixture that cannot be mistaken for a credential rather than an exemption.
 */
const TOKEN = "pat-na1-EXAMPLE-FIXTURE-NOT-A-REAL-TOKEN";
const PORTAL = "48273615";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
interface Route {
  match: RegExp;
  /** Consumed in order; the LAST one repeats, so a route can model
   *  "pending, pending, then complete" or "always pending". */
  responses?: StubResponse[];
  /** Full control, for routes whose answer depends on the request body. */
  handler?: (url: string, init: Record<string, unknown>) => StubResponse;
}
interface Recorded {
  url: string;
  init: Record<string, unknown>;
  /** The FAKE clock reading at the moment the call was made. The governor
   *  assertions are about this column and nothing else. */
  at: number;
}

/**
 * A clock that only moves when something sleeps.
 *
 * That is the whole point: a rate governor that did not actually wait would
 * produce a call timeline with no gaps in it, and the 5 req/s assertion would
 * catch it. Real timers would make the same assertion flaky instead.
 *
 * The macrotask yield before advancing is not decoration. Time in a real
 * process cannot move while a task that is already runnable has not run, but a
 * naive fake clock CAN teleport past a request that has been granted a slot and
 * not yet issued — which shows up as a burst the governor never actually
 * allowed. Draining the microtask queue first makes the fake clock behave the
 * way the real one does, so the call timeline means what it says.
 */
function fakeClock(start = NOW) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      t += Math.max(0, ms);
    },
  };
}

function stubFetch(routes: Route[], clock: { now: () => number }) {
  const calls: Recorded[] = [];
  const seen = new Map<number, number>();
  const impl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init, at: clock.now() });
    const idx = routes.findIndex((r) => r.match.test(url));
    if (idx === -1) throw new Error(`test stub has no route for ${url}`);
    const route = routes[idx];
    const n = seen.get(idx) ?? 0;
    seen.set(idx, n + 1);
    const r = route.handler
      ? route.handler(url, init)
      : (route.responses ?? [{}])[Math.min(n, (route.responses ?? [{}]).length - 1)];
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k: string) => r.headers?.[k] ?? r.headers?.[k.toLowerCase()] ?? null,
      },
      json: async () => r.body ?? {},
    } as unknown as Response;
  };
  return {
    impl,
    calls,
    paths: () => calls.map((c) => new URL(c.url).pathname),
    searchCalls: () => calls.filter((c) => c.url.endsWith("/search")),
    bodyOf: (i: number) => JSON.parse(String(calls[i].init.body ?? "{}")),
  };
}

function connector(
  opts: {
    routes?: Route[];
    baseUrl?: string;
    token?: string;
    /** `true` leaves the resolver at its blocked default. */
    blocked?: boolean;
    portalId?: string;
    clock?: ReturnType<typeof fakeClock>;
    sleeps?: number[];
    random?: () => number;
    connectionId?: string;
  } = {},
) {
  const clock = opts.clock ?? fakeClock();
  const f = stubFetch(
    opts.routes ?? [{ match: /.*/, responses: [{ body: { results: [] } }] }],
    clock,
  );
  const sleeps = opts.sleeps ?? [];
  const c = new HubSpotConnector(
    {
      portalId: opts.portalId ?? PORTAL,
      credentialsSecretRef: opts.connectionId ?? "secret://hubspot/conn-1",
      baseUrl: opts.baseUrl,
    },
    {
      fetchImpl: f.impl,
      now: clock.now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        await clock.sleep(ms);
      },
      random: opts.random ?? (() => 0),
      resolveToken: opts.blocked ? undefined : async () => opts.token ?? TOKEN,
    },
  );
  return { c, f, sleeps, clock };
}

beforeEach(() => {
  // The Search governor is module-level and account-keyed BY DESIGN, so it
  // outlives a connector instance. Tests must therefore reset it, exactly as
  // production must not.
  resetSearchGovernors();
});

// ─────────────────────────────────────────────────────────────────────────────
// Host guard (WARP-2329)
// ─────────────────────────────────────────────────────────────────────────────

describe("base-URL host guard", () => {
  it("rejects an unregistered host that merely LOOKS like HubSpot", () => {
    // Suffix matching would have accepted the first of these.
    // Mutation: delete the HUBSPOT_ALLOWED_API_HOSTS.has(host) check → red.
    for (const bad of [
      "https://api.hubapi.com.evil.test",
      "https://evil.test/api.hubapi.com",
      "https://apihubapi.com",
    ]) {
      expect(() => assertSafeHubspotBaseUrl(bad)).toThrow(UnsafeHubspotBaseUrlError);
    }
  });

  it("refuses an unregistered host on ZERO fetch calls, not on the response", async () => {
    // The guard's whole value is that the private app token never leaves the
    // box. A test asserting on the returned error would still pass if the
    // request had already gone out carrying the token.
    // Mutation: move the guard from construction to response handling → red.
    const clock = fakeClock();
    const f = stubFetch([{ match: /.*/, responses: [{ body: {} }] }], clock);
    expect(
      () =>
        new HubSpotConnector(
          {
            portalId: PORTAL,
            credentialsSecretRef: "secret://hubspot/conn-1",
            baseUrl: "https://api.hubapi.com.evil.test",
          },
          { fetchImpl: f.impl, now: clock.now, resolveToken: async () => TOKEN },
        ),
    ).toThrow(UnsafeHubspotBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("rejects userinfo, a non-443 port and plain http", () => {
    // Mutation: drop any one of the three checks → red.
    expect(() => assertSafeHubspotBaseUrl("https://evil@api.hubapi.com")).toThrow(
      UnsafeHubspotBaseUrlError,
    );
    expect(() => assertSafeHubspotBaseUrl("https://api.hubapi.com:8443")).toThrow(
      UnsafeHubspotBaseUrlError,
    );
    expect(() => assertSafeHubspotBaseUrl("http://api.hubapi.com")).toThrow(
      UnsafeHubspotBaseUrlError,
    );
  });

  it("normalises a trailing slash and accepts the registered host", () => {
    // Mutation: drop the trailing-slash strip → red (paths become //2026-03/…).
    expect(assertSafeHubspotBaseUrl("https://api.hubapi.com/")).toBe(HUBSPOT_PRODUCTION_BASE_URL);
    expect(assertSafeHubspotBaseUrl(HUBSPOT_PRODUCTION_BASE_URL)).toBe(
      HUBSPOT_PRODUCTION_BASE_URL,
    );
  });

  it("keeps the base URL as a whole literal so the egress scanner can read it", () => {
    // scripts/check-egress-allowlist.py is a static text scanner over tracked
    // source (docs/SECURITY.md:183-185) and can only extract a hostname it
    // literally sees. Assembling the URL at runtime blinds the egress gate
    // while leaving the code working — the worst of both.
    // Mutation: rewrite the constant as `"https://" + host` → red.
    const src = readFileSync(hubspotSourcePath("connector.ts"), "utf8");
    expect(src).toContain('"https://api.hubapi.com"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Private app token intake (WARP-2334, connector half)
// ─────────────────────────────────────────────────────────────────────────────

describe("private app token intake", () => {
  it("accepts the pat- regional family", () => {
    expect(assertHubspotPrivateAppToken(TOKEN)).toBe(TOKEN);
    expect(assertHubspotPrivateAppToken("pat-eu1-aaaaaaaa-bbbb")).toBe("pat-eu1-aaaaaaaa-bbbb");
    expect(assertHubspotPrivateAppToken("pat-ap1-0")).toBe("pat-ap1-0");
  });

  it("rejects a legacy hapikey UUID with a distinct reason", () => {
    // The retired `hapikey` is a bare UUID. Accepting one would produce a
    // connection that authenticates against nothing and reads as "quiet CRM".
    // Mutation: loosen HUBSPOT_PRIVATE_APP_TOKEN_PATTERN to /^(pat-)?/ → red.
    let caught: unknown;
    try {
      assertHubspotPrivateAppToken("d1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidHubspotCredentialError);
    expect((caught as InvalidHubspotCredentialError).reason).toBe("legacy_api_key");
  });

  it("rejects an OAuth access token, an empty string and a non-string", () => {
    // OAuth is out on a hard technical ground — HubSpot has no PKCE — so an
    // OAuth-shaped credential is a wrong-integration signal, not a near miss.
    // Mutation: drop the empty-string guard → red.
    expect(
      (() => {
        try {
          assertHubspotPrivateAppToken("CObW3vaOMBIRAQEAAAABGH3f0j");
        } catch (e) {
          return (e as InvalidHubspotCredentialError).reason;
        }
        return "not-thrown";
      })(),
    ).toBe("oauth_token");
    expect(() => assertHubspotPrivateAppToken("")).toThrow(InvalidHubspotCredentialError);
    expect(() => assertHubspotPrivateAppToken("   ")).toThrow(InvalidHubspotCredentialError);
    expect(() => assertHubspotPrivateAppToken(undefined)).toThrow(InvalidHubspotCredentialError);
  });

  it("never echoes the rejected credential back in the error — rule 19", () => {
    // A validation error that quotes the token writes it into every log line
    // that renders the error.
    // Mutation: interpolate the offered value into the message → red.
    let caught: unknown;
    try {
      assertHubspotPrivateAppToken("pat_SUPERSECRETVALUE");
    } catch (e) {
      caught = e;
    }
    const rendered = JSON.stringify({
      // Spread FIRST, explicit `message` last. `Error.prototype.message` is a
      // NON-ENUMERABLE own property, so the spread never carried it and the
      // old `message`-then-spread order only looked like it overwrote it
      // (TS2783). Same keys and same value either way — this ordering just
      // makes the message the test asserts on deterministically the real one.
      ...(caught as InvalidHubspotCredentialError),
      message: (caught as Error).message,
    });
    expect(rendered).not.toContain("SUPERSECRETVALUE");
  });

  it("reports THAT a token exists and never its value", async () => {
    // The SMTP settings view's `hasPassword` convention.
    // Mutation: add `token` to the status object → red.
    const { c } = connector();
    await c.connect();
    const status = await c.status();
    expect(status.hasToken).toBe(true);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).not.toContain("pat-na1-");
  });

  it("holds only a secret-store pointer in its config, never the token", () => {
    // The blocked-boundary contract from __tests__/connector.test.ts:1-51.
    // Mutation: store the resolved token on the config object → red.
    const config = {
      portalId: PORTAL,
      credentialsSecretRef: "secret://hubspot/conn-1",
    };
    const c = new HubSpotConnector(config, { resolveToken: async () => TOKEN });
    expect(c.provider).toBe(HUBSPOT_PROVIDER);
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(JSON.stringify(config)).toContain("secret://");
  });

  it("re-validates on every resolve, not only at intake", async () => {
    // A row edited out-of-band must not be able to put a non-pat credential on
    // the wire.
    // Mutation: validate once in the constructor instead of in `token()` → red.
    const { c, f } = connector({ token: "d1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6" });
    await expect(c.connect()).rejects.toBeInstanceOf(InvalidHubspotCredentialError);
    expect(f.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Version pinning + the v-four ban (WARP-2359)
// ─────────────────────────────────────────────────────────────────────────────

describe("API version pin", () => {
  it("declares the date-based version exactly once in source", () => {
    // A second literal is a version that can drift out of the pin silently.
    // Mutation: paste the version string into a second constant → red.
    const hits = hubspotSources().flatMap((p) => {
      const src = readFileSync(p, "utf8");
      return [...src.matchAll(/"\d{4}-\d{2}"/g)].map((m) => `${p}:${m[0]}`);
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(HUBSPOT_API_VERSION);
  });

  it("builds EVERY request path from the pin, not one sampled call", async () => {
    // Mutation: hardcode a path anywhere that skips hubspotPath() → red.
    //
    // The pin must appear as its own SEGMENT, which is a different claim from
    // "the path contains the string": a version spliced into a name
    // (`/crm/objects-2026-03/…`) would satisfy a substring check and 404 all
    // the same.
    const { c, f } = connector({
      routes: [searchRoute([]), objectRoute(), exportRoutes()].flat(),
    });
    await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    await c.listAssociatedDeals("101");
    await c.runBackfill({ objectType: "contacts", properties: ["email"] });

    expect(f.calls.length).toBeGreaterThanOrEqual(4);
    for (const p of f.paths()) {
      expect(p.split("/")).toContain(HUBSPOT_API_VERSION);
    }
  });

  it("contains no v-four route literal anywhere under the connector directory", () => {
    // HubSpot v4 — Associations v4 included — ends support 2027-03-30, inside
    // this product's support horizon. v3 CRM objects have no announced sunset.
    // The v4 association endpoints are the ones a developer reaches for FIRST
    // when wiring contact↔deal links, which is exactly why this is a test and
    // not a convention.
    // Mutation: add an Associations v4 route literal → red.
    const banned = /\/v4\/|crm\/v4|associations\/v4/;
    for (const p of hubspotSources()) {
      expect(readFileSync(p, "utf8")).not.toMatch(banned);
    }
  });

  it("resolves the contact↔deal association on the object route, with no v-four call", async () => {
    // The object read answers associations as a block (?associations=deals),
    // so the link needs no separate API family — which is what keeps the v4
    // Associations API (support ends 2027-03-30) out of this connector.
    // Mutation: fetch the link from an associations v4 route → red.
    const { c, f } = connector({ routes: objectRoute() });
    const deals = await c.listAssociatedDeals("101");
    expect(deals).toEqual(["501", "502"]);
    for (const p of f.paths()) {
      expect(p).toContain(`/crm/objects/${HUBSPOT_API_VERSION}/`);
      expect(p).not.toMatch(/v4/);
    }
    expect(f.calls[0].url).toContain("associations=deals");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Documented date-based path shape (WARP-2470)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The paths HubSpot's 2026-03 OpenAPI documents, byte for byte.
 *
 * Deliberately NOT built from {@link HUBSPOT_API_VERSION} or from any helper
 * the connector also uses: a test that assembles the expectation the same way
 * the code does cannot observe the code assembling it wrongly. These are typed
 * out from the spec, which is the only oracle here — no live HubSpot call is
 * needed or permitted.
 *
 * Sources (each verified 2026-08-27 against the embedded OpenAPI fragment on
 * the endpoint's own reference page, all of which declare ZERO header
 * parameters — the version is carried by the path and nothing else):
 *   /crm/objects/2026-03/{objectType}                      crm-contacts-v2026-03.json
 *   /crm/objects/2026-03/{objectType}/{objectId}           crm-contacts-v2026-03.json
 *   /crm/objects/2026-03/{objectType}/search   (POST)      crm-contacts-v2026-03.json
 *   /crm/owners/2026-03                                    crm-crm-owners-v2026-03.json
 *   /crm/exports/2026-03/export/async          (POST)      crm-exports-v2026-03.json
 *   /crm/exports/2026-03/export/async/tasks/{taskId}/status
 *                                                          crm-exports-v2026-03.json
 *   /marketing/emails/2026-03                              marketing-marketing-emails-v2026-03.json
 *   /crm-object-schemas/2026-03/schemas                    crm-schemas-v2026-03.json
 */
const DOCUMENTED_PATHS = {
  ownersList: "/crm/owners/2026-03",
  objectsSearch: "/crm/objects/2026-03/contacts/search",
  objectById: "/crm/objects/2026-03/contacts/101",
  objectsCollection: "/crm/objects/2026-03/notes",
  exportCreate: "/crm/exports/2026-03/export/async",
  exportStatus: "/crm/exports/2026-03/export/async/tasks/exp_1/status",
  marketingEmails: "/marketing/emails/2026-03",
  objectSchemas: "/crm-object-schemas/2026-03/schemas",
} as const;

/**
 * Routes matched on the request TAIL only, so the stub answers both the shipped
 * (broken) shape and the documented one. If these regexes encoded either shape
 * the suite would fail with "test stub has no route for …" instead of the path
 * mismatch the assertion is actually about.
 */
function allEndpointRoutes(): Route[] {
  return [
    { match: /\/search$/, responses: [{ body: { total: 0, results: [] } }] },
    { match: /export\/async$/, responses: [{ body: { id: "exp_1" } }] },
    {
      match: /tasks\/exp_1\/status$/,
      responses: [
        { body: { status: "COMPLETE", result: "https://export.example.test/exp_1" } },
      ],
    },
    { match: /schemas/, responses: [{ body: { results: [] } }] },
    { match: /marketing/, responses: [{ body: { results: [] } }] },
    { match: /owners/, responses: [{ body: { results: [] } }] },
    {
      match: /contacts\/101/,
      responses: [
        {
          body: {
            id: "101",
            properties: {},
            associations: { deals: { results: [{ id: "501" }] } },
          },
        },
      ],
    },
    { match: /notes$/, responses: [{ body: { id: "n_1" } }] },
    // Anything else is a path nobody declared. Left unmatched on purpose: the
    // stub throws, which is how an undeclared route announces itself.
  ];
}

/** Drive every endpoint the connector can dial and return the paths it built. */
async function dialEveryEndpoint(): Promise<string[]> {
  const { c, f } = connector({ routes: allEndpointRoutes() });
  await c.connect();
  await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
  await c.listAssociatedDeals("101");
  await c.runBackfill({ objectType: "contacts", properties: ["email"] });
  await c.listMarketingEmails();
  await c.listCustomObjectSchemas();
  await c.createNote({ body: "call summary", associatedContactId: "101" }, { confirmed: true });
  return f.paths();
}

describe("documented 2026-03 path shape", () => {
  it("dials exactly the paths HubSpot's 2026-03 spec documents, byte for byte", async () => {
    // The whole defect in one assertion. The shipped shape prefixes the date
    // (`/2026-03/crm/v3/objects/contacts`); the spec puts it AFTER the product
    // group, with the object name ahead of it. Compared as exact strings, not a
    // regex, because a regex loose enough to accept both orderings is a regex
    // that cannot see the bug.
    // Mutation: move the date back to the path root → red.
    const paths = await dialEveryEndpoint();

    expect(paths).toContain(DOCUMENTED_PATHS.ownersList);
    expect(paths).toContain(DOCUMENTED_PATHS.objectsSearch);
    expect(paths).toContain(DOCUMENTED_PATHS.objectById);
    expect(paths).toContain(DOCUMENTED_PATHS.objectsCollection);
    expect(paths).toContain(DOCUMENTED_PATHS.exportCreate);
    expect(paths).toContain(DOCUMENTED_PATHS.exportStatus);
    expect(paths).toContain(DOCUMENTED_PATHS.marketingEmails);
    expect(paths).toContain(DOCUMENTED_PATHS.objectSchemas);

    // And nothing outside the documented set.
    const documented = new Set<string>(Object.values(DOCUMENTED_PATHS));
    expect([...new Set(paths)].filter((p) => !documented.has(p))).toEqual([]);
  });

  it("never puts the date version at the path root", async () => {
    // The exact shape shipped on stage today. Stated as its own assertion so
    // the failure names the defect rather than showing a string diff.
    // Mutation: revert hubspotPath() to `/${VERSION}${rest}` → red.
    for (const p of await dialEveryEndpoint()) {
      expect(p.startsWith(`/${HUBSPOT_API_VERSION}/`)).toBe(false);
      expect(p).not.toMatch(/^\/\d{4}-\d{2}\//);
    }
  });

  it("assembles each documented path from its route family, byte for byte", async () => {
    // hubspotPath() in isolation, against the spec strings. The connector-level
    // test above proves the call sites use it; this proves what it produces.
    // Mutation: swap any HUBSPOT_API_ROUTES value, or move the version to the
    //           front of the template → red.
    expect(hubspotPath("owners")).toBe(DOCUMENTED_PATHS.ownersList);
    expect(hubspotPath("objects", "contacts/search")).toBe(DOCUMENTED_PATHS.objectsSearch);
    expect(hubspotPath("objects", "contacts/101")).toBe(DOCUMENTED_PATHS.objectById);
    expect(hubspotPath("objects", "notes")).toBe(DOCUMENTED_PATHS.objectsCollection);
    expect(hubspotPath("exports", "export/async")).toBe(DOCUMENTED_PATHS.exportCreate);
    expect(hubspotPath("exports", "export/async/tasks/exp_1/status")).toBe(
      DOCUMENTED_PATHS.exportStatus,
    );
    expect(hubspotPath("marketingEmails")).toBe(DOCUMENTED_PATHS.marketingEmails);
    expect(hubspotPath("objectSchemas", "schemas")).toBe(DOCUMENTED_PATHS.objectSchemas);

    // The two families the allowlist names but no method dials yet.
    expect(hubspotPath("pipelines", "deals")).toBe("/crm/pipelines/2026-03/deals");
    expect(hubspotPath("properties", "contacts")).toBe("/crm/properties/2026-03/contacts");
  });

  it("documents every route family it can build, and builds none it has not documented", () => {
    // The docstring table on HUBSPOT_API_ROUTES is the record of what was
    // checked against HubSpot's published spec. A family present in the code
    // but missing from that table is an endpoint nobody verified.
    // Mutation: add a family to HUBSPOT_API_ROUTES without a table row → red.
    const src = readFileSync(join(HUBSPOT_DIR, "connector.ts"), "utf8");
    const table = src.slice(
      src.indexOf("| Connector call"),
      src.indexOf("export const HUBSPOT_API_ROUTES"),
    );
    expect(table).not.toBe("");

    for (const apiName of Object.values(HUBSPOT_API_ROUTES)) {
      expect(table).toContain(`/${apiName}/<version>`);
    }
  });

  it("refuses to resolve the pre-fix shape, so a stale path cannot ride the allowlist", () => {
    // `/2026-03/crm/v3/objects/contacts` is what stage shipped. It must map to
    // NO resource, or the readable-resource allowlist would wave through a path
    // that 404s at HubSpot.
    // Mutation: make hubspotResourceOf tolerate a leading version → red.
    expect(hubspotResourceOf(`/${HUBSPOT_API_VERSION}/crm/v3/objects/contacts`)).toBe("");
    expect(hubspotResourceOf(`/${HUBSPOT_API_VERSION}/crm/v3/owners`)).toBe("");
    expect(hubspotResourceOf(`/${HUBSPOT_API_VERSION}/marketing/v3/emails`)).toBe("");
    // And the naive half-fix that only swaps the token in place.
    expect(hubspotResourceOf(`/crm/${HUBSPOT_API_VERSION}/objects/contacts`)).toBe("");
  });

  it("carries the version as a path segment on every call, never as a header", async () => {
    // The spec declares zero header parameters, so a version header would be a
    // second, unversioned source of truth. Both halves matter: the pin must be
    // IN the path, and absent from the headers.
    // Mutation: send the version as an `X-HubSpot-Version` header instead → red.
    const { c, f } = connector({ routes: allEndpointRoutes() });
    await c.connect();
    await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });

    for (const call of f.calls) {
      expect(new URL(call.url).pathname.split("/")).toContain(HUBSPOT_API_VERSION);
      const headers = call.init.headers as Record<string, string>;
      expect(JSON.stringify(headers)).not.toContain(HUBSPOT_API_VERSION);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The 10,000-record cap and watermark re-anchoring (WARP-2347)
// ─────────────────────────────────────────────────────────────────────────────

describe("Search delta poller", () => {
  it("ingests 10,001 records by RE-ANCHORING, never by paging past the cap", async () => {
    // Crossing the cap does not truncate politely — HubSpot answers HTTP 400,
    // which reads at a glance like a malformed filter. The corpus stub below
    // reproduces that exactly, so the mutation is genuinely observable.
    // Mutation: replace re-anchoring with `after`-cursor deep pagination → red,
    //           with the HTTP 400 surfacing to the caller.
    const corpus = syntheticCorpus(10_001);
    const { c, f } = connector({ routes: [corpusSearchRoute(corpus)] });

    const out = await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });

    expect(out.records).toHaveLength(10_001);
    expect(new Set(out.records.map((r) => r.id)).size).toBe(10_001);

    const afters = f
      .searchCalls()
      .map((call) => Number(JSON.parse(String(call.init.body)).after ?? 0));
    expect(Math.max(...afters)).toBeLessThan(HUBSPOT_SEARCH_RESULT_CAP);
    // More than one anchor was actually used — otherwise the assertion above
    // would hold vacuously on a corpus that never reached the cap.
    expect(out.anchors).toBeGreaterThan(1);
  });

  it("holds the watermark BEHIND the newest record by the consistency overlap", async () => {
    // Search is eventually consistent and HubSpot documents no bound. A
    // watermark set to max(seen) drops every record that materialises a moment
    // later — permanently, because the next poll starts after them.
    // Mutation: set the watermark to the max seen → red.
    const corpus = syntheticCorpus(3);
    const { c } = connector({ routes: [corpusSearchRoute(corpus)] });
    const out = await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    const newest = Math.max(...corpus.map((r) => Number(r.properties.hs_lastmodifieddate)));
    expect(out.watermark).toBe(newest - HUBSPOT_SEARCH_CONSISTENCY_OVERLAP_MS);
    expect(out.watermark).toBeLessThan(newest);
  });

  it("picks up a record that only becomes visible on a LATER poll", async () => {
    // The consistency window made concrete, in the shape that actually loses
    // data: `late` was MODIFIED BEFORE `early` but only became queryable after
    // the first poll had already run. Its stamp is therefore behind the newest
    // record the first poll saw, so only the overlap can reach back for it.
    // Mutation: set the watermark to max(seen) with no overlap → the second
    //           poll's floor sits past `late`'s stamp and it is never seen
    //           again by any poll → red.
    const early = record("early", NOW - 600_000);
    const late = record("late", NOW - 660_000);
    let poll = 0;
    const { c } = connector({
      routes: [
        {
          match: /\/search$/,
          handler: (_u, init) => {
            const body = JSON.parse(String(init.body));
            const floor = Number(body.filterGroups[0].filters[0].value);
            poll += 1;
            const visible = poll === 1 ? [early] : [early, late];
            const results = visible.filter(
              (r) => Number(r.properties.hs_lastmodifieddate) >= floor,
            );
            return { body: { total: results.length, results } };
          },
        },
      ],
    });

    const first = await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    expect(first.records.map((r) => r.id)).toEqual(["early"]);

    const second = await c.pollObjectChanges({
      objectType: "contacts",
      watermark: first.watermark,
    });
    expect(second.records.map((r) => r.id)).toContain("late");
  });

  it("deduplicates the replayed overlap — the upsert key is the object id", async () => {
    // Every poll deliberately re-reads the overlap, so without id-keying the
    // same record is emitted twice per cycle forever.
    // Mutation: collect records into an array instead of a Map keyed on id → red.
    const dup = record("c-1", NOW - 300_000);
    const later = { ...dup, properties: { ...dup.properties, email: "later@example.test" } };
    const { c } = connector({
      routes: [{ match: /\/search$/, responses: [{ body: { total: 2, results: [dup, later] } }] }],
    });
    const out = await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    expect(out.records).toHaveLength(1);
    // Later wins, so the freshest copy of the row is the one upserted.
    expect(out.records[0].properties.email).toBe("later@example.test");
  });

  it("refuses to spin when a re-anchor cannot advance the floor", async () => {
    // >10,000 records sharing one hs_lastmodifieddate (a bulk import on the
    // customer's side) makes the floor un-advanceable. Looping forever there
    // would be a silent hang; this reports instead.
    // Mutation: drop the no-progress check → the suite hangs rather than fails,
    //           which is why the anchor ceiling is bounded too.
    const stuck = Array.from({ length: HUBSPOT_SEARCH_RESULT_CAP }, (_, i) =>
      record(`s-${i}`, NOW - 900_000),
    );
    const { c } = connector({ routes: [corpusSearchRoute(stuck, { allowStall: true })] });
    await expect(
      c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toBeInstanceOf(HubSpotWatermarkStallError);
  });

  it("sorts ascending on hs_lastmodifieddate — an unsorted feed cannot re-anchor", async () => {
    // Mutation: drop the `sorts` block from the search body → red. Without it
    // "the newest seen" is not the newest, and the re-anchored floor skips rows.
    const { c, f } = connector({ routes: searchRoute([record("c-1", NOW - 1000)]) });
    await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    const body = f.bodyOf(0);
    expect(body.sorts).toEqual([
      { propertyName: "hs_lastmodifieddate", direction: "ASCENDING" },
    ]);
    expect(body.limit).toBe(HUBSPOT_SEARCH_PAGE_SIZE);
    expect(body.filterGroups[0].filters[0].propertyName).toBe("hs_lastmodifieddate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The account-keyed 5 req/s Search governor (WARP-2350)
// ─────────────────────────────────────────────────────────────────────────────

describe("Search rate governor", () => {
  it("serialises two CONNECTIONS on one portal to 5 req/s combined", async () => {
    // Per ACCOUNT, not per app or per connection: a second private app buys
    // nothing, and neither does a second IntegrationConnection row. This is the
    // test the ticket names.
    // Mutation: key the governor by connection id (credentialsSecretRef)
    //           instead of portal id → red, because both connections then grant
    //           five calls at the same instant.
    const clock = fakeClock();
    const a = connector({
      clock,
      connectionId: "secret://hubspot/conn-A",
      routes: searchRoute([]),
    });
    const b = connector({
      clock,
      connectionId: "secret://hubspot/conn-B",
      routes: searchRoute([]),
    });

    await Promise.all([drivePolls(a.c, 5), drivePolls(b.c, 5)]);

    const timeline = [...a.f.searchCalls(), ...b.f.searchCalls()]
      .map((call) => call.at)
      .sort((x, y) => x - y);
    expect(timeline).toHaveLength(10);
    // The invariant, stated directly: no window of 1000 ms may contain more
    // than HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND grants.
    for (let i = HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND; i < timeline.length; i += 1) {
      expect(
        timeline[i] - timeline[i - HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND],
      ).toBeGreaterThanOrEqual(1000);
    }
  });

  it("keeps two DIFFERENT portals independent", async () => {
    // The ceiling is per account, so one customer's poll must not throttle
    // another's. This is the other half of "account-keyed": it is not a global
    // lock wearing an account's name.
    // Mutation: key the governor on a constant → red.
    const clock = fakeClock();
    const a = connector({ clock, portalId: "111", routes: searchRoute([]) });
    const b = connector({ clock, portalId: "222", routes: searchRoute([]) });
    await Promise.all([drivePolls(a.c, 5), drivePolls(b.c, 5)]);
    const all = [...a.f.searchCalls(), ...b.f.searchCalls()].map((c2) => c2.at);
    expect(Math.max(...all)).toBe(NOW);
  });

  it("does NOT meter non-Search calls against the Search ceiling", async () => {
    // The Search ceiling is Search's. Metering the ordinary object reads and
    // the Exports API against it would throttle the connector against a limit
    // that does not exist.
    // Mutation: acquire a governor slot in `request()` rather than only on the
    //           search path → red.
    const clock = fakeClock();
    const { c, f } = connector({ clock, routes: objectRoute() });
    for (let i = 0; i < 12; i += 1) await c.listAssociatedDeals("101");
    expect(f.calls.map((x) => x.at).every((t) => t === NOW)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Header-less 429 backoff (WARP-2350)
// ─────────────────────────────────────────────────────────────────────────────

describe("429 handling", () => {
  it("backs off exponentially on a BARE 429 that carries no headers at all", async () => {
    // Search responses carry NO rate-limit headers — not Retry-After, not a
    // remaining-quota hint. The 429 itself is the only signal, so backoff has
    // to be self-derived or this is a hot loop against an endpoint already
    // telling us to slow down.
    // Mutation: make the backoff conditional on a Retry-After header being
    //           present → red (sleeps is empty; the calls are a hot loop).
    const sleeps: number[] = [];
    const { c, f } = connector({
      sleeps,
      random: () => 1,
      routes: [{ match: /\/search$/, responses: [{ status: 429, body: {} }] }],
    });

    await expect(
      c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toBeInstanceOf(HubSpotSearchRateLimitedError);

    expect(f.searchCalls()).toHaveLength(HUBSPOT_MAX_RATE_LIMIT_RETRIES);
    expect(sleeps).toHaveLength(HUBSPOT_MAX_RATE_LIMIT_RETRIES - 1);
    expect(sleeps.every((s) => s > 0)).toBe(true);
    for (let i = 1; i < sleeps.length; i += 1) {
      expect(sleeps[i]).toBeGreaterThan(sleeps[i - 1]);
    }
  });

  it("jitters the backoff — two runs on different randomness do not agree", async () => {
    // Without jitter every box that hit the same 429 retries in lockstep
    // forever. The assertion is on the SLEEP TIMELINE, not the return value.
    // Mutation: drop the random term → the two arrays become equal → red.
    const low: number[] = [];
    const high: number[] = [];
    const route: Route[] = [{ match: /\/search$/, responses: [{ status: 429, body: {} }] }];
    const a = connector({ sleeps: low, random: () => 0, routes: route });
    await expect(
      a.c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toThrow();
    resetSearchGovernors();
    const b = connector({ sleeps: high, random: () => 1, routes: route });
    await expect(
      b.c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toThrow();

    expect(low).not.toEqual(high);
    for (let i = 0; i < low.length; i += 1) expect(high[i]).toBeGreaterThan(low[i]);
    // Still bounded by the un-jittered exponential, so jitter cannot become a
    // second, unbounded backoff.
    for (let i = 0; i < high.length; i += 1) {
      expect(high[i]).toBeLessThanOrEqual(HUBSPOT_BACKOFF_BASE_MS * 2 ** i);
    }
  });

  it("honours Retry-After when HubSpot does send one", async () => {
    // Absence of the header must not disable backoff; presence must not be
    // ignored. Both directions, because testing only one leaves the other free.
    // Mutation: ignore Retry-After → red.
    const sleeps: number[] = [];
    const { c } = connector({
      sleeps,
      routes: [
        {
          match: /\/search$/,
          responses: [{ status: 429, headers: { "Retry-After": "3" }, body: {} }],
        },
      ],
    });
    await expect(
      c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toThrow();
    expect(sleeps[0]).toBeGreaterThanOrEqual(3000);
  });

  it("reports the DAILY account limit as quota exhausted, and does not retry it", async () => {
    // The 250,000/day pool is shared with every other integration the customer
    // runs, so the box can be rate-limited by a limit it did not cause.
    // Retrying inside the same day cannot help, and reporting an empty CRM
    // would be a confident false statement.
    // Mutation: route the DAILY policy through the retry branch → red on the
    //           call count.
    const { c, f } = connector({
      routes: [
        {
          match: /\/search$/,
          responses: [
            {
              status: 429,
              body: {
                category: "RATE_LIMITS",
                policyName: "DAILY",
                message: "daily limit reached",
              },
            },
          ],
        },
      ],
    });
    await expect(
      c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toBeInstanceOf(HubSpotQuotaExhaustedError);
    expect(f.searchCalls()).toHaveLength(1);
  });

  it("never renders sustained rate limiting as an empty result set", async () => {
    // The ADR-041 never-empty contract.
    // Mutation: `catch { return { records: [] } }` around the poll → red.
    const { c } = connector({
      routes: [{ match: /\/search$/, responses: [{ status: 429, body: {} }] }],
    });
    const out = await c
      .pollObjectChanges({ objectType: "contacts", watermark: 0 })
      .catch((e) => e as unknown);
    expect(Array.isArray(out)).toBe(false);
    expect(out).toBeInstanceOf(HubSpotSearchRateLimitedError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The four failure states (WARP-2341)
// ─────────────────────────────────────────────────────────────────────────────

describe("failure states", () => {
  it("renders USER_DOES_NOT_HAVE_PERMISSIONS as its own super-admin-revoked state", async () => {
    // The failure most likely to be seen in the field: the office manager who
    // created the private app leaves, and six months later every call fails.
    // Nothing about the token changed and nothing about our config changed, so
    // a generic auth error sends the customer hunting the wrong thing.
    // Mutation: map it onto the generic auth-failure branch → red on the
    //           remediation-string assertion.
    const { c } = connector({ routes: [permissionDeniedRoute()] });
    let caught: unknown;
    try {
      await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HubSpotSuperAdminRevokedError);
    expect(caught).not.toBeInstanceOf(HubSpotReauthorizationRequiredError);
    const rendered = JSON.stringify({
      // Spread FIRST, explicit `message` last — see the note on the credential
      // test above. It matters more here: the assertions below read the message
      // text out of `rendered`, so `message` must deterministically be the real
      // one rather than whatever the declared spread type claims (TS2783).
      ...(caught as HubSpotSuperAdminRevokedError),
      message: (caught as Error).message,
    });
    expect(rendered).toContain("super admin");
    expect(rendered).toContain(HUBSPOT_SUPER_ADMIN_REMEDIATION);
  });

  it("gives that state an explicit enum value, distinct from disconnected", async () => {
    // "No guessing state": the status is an explicit value, never derived from
    // a NULL, an absence, or the fact that a read returned nothing.
    // Mutation: fold super_admin_revoked into disconnected → red.
    const { c } = connector({ routes: [permissionDeniedRoute()] });
    await c.pollObjectChanges({ objectType: "contacts", watermark: 0 }).catch(() => undefined);
    const status = await c.status();
    expect(status.state).toBe("super_admin_revoked");
    expect(status.state).not.toBe("disconnected");
    expect(status.ok).toBe(false);
    // It is emphatically NOT "not configured" — a token is present and valid.
    expect(status.hasToken).toBe(true);
    expect(JSON.stringify(status)).toContain("super admin");
  });

  it("keeps the super-admin case ahead of the tier gate on a gated resource", async () => {
    // A revoked super admin 403s on EVERYTHING, gated resources included.
    // Classifying by resource first would report "you need Marketing Hub Pro"
    // to a customer who actually needs to re-create the private app.
    // Mutation: check HUBSPOT_TIER_GATED_RESOURCES before the error category → red.
    const { c } = connector({
      routes: [{ match: /marketing\/emails/, responses: [permissionDeniedResponse()] }],
    });
    await expect(c.listMarketingEmails()).rejects.toBeInstanceOf(HubSpotSuperAdminRevokedError);
  });

  it("separates a revoked TOKEN (401) from a revoked super admin (403)", async () => {
    // Two different people do two different things to fix these.
    // Mutation: collapse the 401 branch into the super-admin class → red.
    const { c } = connector({
      routes: [{ match: /\/search$/, responses: [{ status: 401, body: { message: "expired" } }] }],
    });
    await expect(
      c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toBeInstanceOf(HubSpotReauthorizationRequiredError);
  });

  it("renders a Pro+/Enterprise-only read as a named capability state, not []", async () => {
    // Marketing emails need Marketing Hub Professional; custom object schemas
    // are Enterprise only. On a Free portal both 403. Returning [] would say
    // "you have no marketing emails", which is a confident false statement.
    // Mutation: return [] on the 403 instead of the capability state → red.
    const marketing = connector({
      routes: [
        {
          match: /marketing\/emails/,
          responses: [{ status: 403, body: { message: "not authorized" } }],
        },
      ],
    });
    await expectCapability(
      () => marketing.c.listMarketingEmails(),
      "Marketing Hub Professional",
    );

    resetSearchGovernors();
    const schemas = connector({
      routes: [
        {
          match: /object-schemas/,
          responses: [{ status: 403, body: { message: "not authorized" } }],
        },
      ],
    });
    await expectCapability(() => schemas.c.listCustomObjectSchemas(), "Enterprise");
  });

  it("names every gated resource in one table the connector actually reads", () => {
    // Mutation: add a gated resource to a request path without adding it here
    //           → red, because the resource is then absent from the table.
    for (const key of Object.keys(HUBSPOT_TIER_GATED_RESOURCES)) {
      expect(HUBSPOT_READABLE_RESOURCES.has(key)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exports API backfill (WARP-2356)
// ─────────────────────────────────────────────────────────────────────────────

describe("Exports API backfill", () => {
  it("issues Exports requests and ZERO Search calls", async () => {
    // Search caps at 10,000 per query and is governed at 5 req/s per account
    // that cannot be raised, so seeding a portal's history through it would
    // take hours and starve the delta poller the whole time.
    // Mutation: point backfill at the object search route → red on the
    //           per-path call count.
    const { c, f } = connector({ routes: exportRoutes() });
    const out = await c.runBackfill({ objectType: "contacts", properties: ["email"] });
    expect(out.state).toBe("succeeded");
    expect(f.paths().filter((p) => p.endsWith("/search"))).toHaveLength(0);
    expect(
      f.paths().filter((p) => p.startsWith(`/crm/exports/${HUBSPOT_API_VERSION}/export/async`))
        .length,
    ).toBeGreaterThan(0);
  });

  it("renders a still-processing export as in_progress, never as finished-and-empty", async () => {
    // An export that is still building is not an export that found nothing.
    // Mutation: return a succeeded state when attempts run out → red.
    const { c, f, sleeps } = connector({
      routes: [
        { match: /export\/async$/, responses: [{ body: { id: "exp_1" } }] },
        { match: /tasks\/exp_1\/status/, responses: [{ body: { status: "PROCESSING" } }] },
      ],
    });
    const out = await c.runBackfill({ objectType: "contacts", properties: ["email"] });
    expect(out.state).toBe("in_progress");
    expect(f.paths().filter((p) => p.includes("status"))).toHaveLength(
      HUBSPOT_BACKFILL_MAX_ATTEMPTS,
    );
    // Polled with backoff, not hammered.
    expect(sleeps).toHaveLength(HUBSPOT_BACKFILL_MAX_ATTEMPTS);
    for (let i = 1; i < sleeps.length; i += 1) expect(sleeps[i]).toBeGreaterThan(sleeps[i - 1]);
  });

  it("refuses to poll deltas while a backfill is in flight on the same connection", async () => {
    // The watermark may only advance once the export is fully ingested;
    // otherwise the poll jumps the floor past records the export has not
    // delivered yet, and they are lost for good.
    // Mutation: drop the in-flight guard → the poll runs, issues Search calls
    //           and returns a watermark → red on both assertions.
    const { c, f } = connector({
      routes: [
        { match: /export\/async$/, responses: [{ body: { id: "exp_1" } }] },
        { match: /tasks\/exp_1\/status/, responses: [{ body: { status: "PROCESSING" } }] },
        ...searchRoute([record("c-1", NOW - 1000)]),
      ],
    });
    const backfill = c.runBackfill({ objectType: "contacts", properties: ["email"] });
    await expect(
      c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toBeInstanceOf(HubSpotBackfillInProgressError);
    await backfill;
    expect(f.searchCalls()).toHaveLength(0);
  });

  it("releases the in-flight lock when the export fails", async () => {
    // A lock that outlives its holder is a connection that never syncs again.
    // Mutation: set the flag without a finally → red.
    const { c } = connector({
      routes: [
        { match: /export\/async$/, responses: [{ status: 500, body: {} }] },
        ...searchRoute([]),
      ],
    });
    await c.runBackfill({ objectType: "contacts", properties: ["email"] }).catch(() => undefined);
    await expect(
      c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).resolves.toBeTruthy();
  });

  it("returns the export's file REFERENCE rather than dialing an unregistered host", async () => {
    // HubSpot serves a completed export from a signed URL on a host that is
    // NOT in allowed-egress.yaml. Refusing to dial it is the correct default,
    // not an oversight — downloading it is a follow-up with its own egress
    // decision attached.
    // Mutation: fetch `result` → red, because the stub has no route for that
    //           host and the call throws.
    const { c, f } = connector({ routes: exportRoutes() });
    const out = await c.runBackfill({ objectType: "contacts", properties: ["email"] });
    expect(out.state === "succeeded" && out.fileRef).toBe(
      "https://hubspot-export-files.example.test/exp_1",
    );
    for (const call of f.calls) {
      expect(new URL(call.url).hostname).toBe("api.hubapi.com");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read/write allowlists — "destructive actions are blocked", enforced
// ─────────────────────────────────────────────────────────────────────────────

describe("readable/writable allowlists", () => {
  it("refuses any resource outside HUBSPOT_READABLE_RESOURCES rather than dialing it", () => {
    // An ALLOWLIST enforced at request time, not a denylist of forbidden words
    // in source. Request paths here are assembled at runtime
    // (`/crm/objects/<version>/${objectType}`), so a denylist is blind to exactly the
    // case that matters — the Stripe track proved that by mutation.
    // Mutation: make assertReadableHubspotObject a no-op → red.
    for (const bad of [
      `/crm/objects/${HUBSPOT_API_VERSION}/quotes`,
      `/settings/users/${HUBSPOT_API_VERSION}`,
      `/automation/workflows/${HUBSPOT_API_VERSION}`,
      `/crm/objects/${HUBSPOT_API_VERSION}/deals/merge`,
    ]) {
      expect(() => assertReadableHubspotObject(bad)).toThrow(ConnectorBlockedError);
    }
    for (const ok of [
      `/crm/objects/${HUBSPOT_API_VERSION}/contacts/search`,
      `/crm/objects/${HUBSPOT_API_VERSION}/deals/501`,
      `/crm/exports/${HUBSPOT_API_VERSION}/export/async`,
      `/crm/owners/${HUBSPOT_API_VERSION}`,
      `/marketing/emails/${HUBSPOT_API_VERSION}`,
    ]) {
      expect(() => assertReadableHubspotObject(ok)).not.toThrow();
    }
  });

  it("wires that guard into the request builder, not just into this test", () => {
    // A guard nobody calls is decoration. Reaching the call site through the
    // public API would need a source mutation the suite cannot perform, so the
    // wiring is asserted directly.
    // Mutation: delete the assertReadableHubspotObject(path) call from
    //           `request()` → red.
    const src = readFileSync(hubspotSourcePath("connector.ts"), "utf8");
    expect(src).toContain("assertReadableHubspotObject(path);");
  });

  it("maps an unknown path shape to no resource at all — deny by default", () => {
    // Mutation: return the first path segment as a fallback resource → red.
    expect(hubspotResourceOf(`/nonsense/v9/${HUBSPOT_API_VERSION}`)).toBe("");
    expect(hubspotResourceOf("/crm/v3/objects/contacts")).toBe("");
  });

  it("admits notes and tasks as the ONLY writable objects", () => {
    // Deal-stage changes, contact merges and deletions are absent by
    // construction. "We didn't build it" is not enforceable; a red build is.
    // Mutation: add "deals" to HUBSPOT_WRITABLE_OBJECTS → red.
    expect([...HUBSPOT_WRITABLE_OBJECTS].sort()).toEqual(["notes", "tasks"]);
    for (const bad of ["deals", "contacts", "companies", "tickets"]) {
      expect(() => assertWritableHubspotObject(bad)).toThrow(ConnectorBlockedError);
    }
    for (const ok of ["notes", "tasks"]) {
      expect(() => assertWritableHubspotObject(ok)).not.toThrow();
    }
  });

  it("exposes no method whose name implies a destructive CRM operation", async () => {
    // Mutation: add `mergeContacts()` or `archiveDeal()` to HubSpotConnector → red.
    const mod = (await import("../src/hubspot/connector.js")) as Record<string, unknown>;
    const surface = [
      ...Object.keys(mod),
      ...Object.getOwnPropertyNames(HubSpotConnector.prototype),
    ];
    for (const name of surface) {
      expect(name).not.toMatch(/merge|archive|gdpr|purge|destroy/i);
      expect(name).not.toMatch(/^delete/i);
    }
  });

  it("never issues an HTTP DELETE, at any call site", async () => {
    // Mutation: add a delete path → red.
    const { c, f } = connector({
      routes: [searchRoute([]), objectRoute(), exportRoutes()].flat(),
    });
    await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    await c.listAssociatedDeals("101");
    await c.runBackfill({ objectType: "contacts", properties: ["email"] });
    for (const call of f.calls) {
      expect(String(call.init.method ?? "GET").toUpperCase()).not.toBe("DELETE");
    }
    const src = readFileSync(hubspotSourcePath("connector.ts"), "utf8");
    expect(src).not.toMatch(/"DELETE"|'DELETE'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Confirmed writes — notes and tasks only
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmed writes", () => {
  it("refuses a note write before confirmation, on ZERO fetch calls", async () => {
    // "Writes ask for a thumbs-up" has to be a property of the code. The
    // generic interceptor is WARP-2214's; this is the local gate that makes the
    // promise true today.
    // Mutation: default `confirmed` to true → red on the call count.
    const { c, f } = connector({ routes: [writeRoute("notes")] });
    await expect(
      c.createNote({ body: "call summary", associatedContactId: "101" }),
    ).rejects.toBeInstanceOf(HubSpotConfirmationRequiredError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a task write before confirmation, on ZERO fetch calls", async () => {
    // Mutation: gate only createNote and leave createTask open → red.
    const { c, f } = connector({ routes: [writeRoute("tasks")] });
    await expect(
      c.createTask({ subject: "follow up", associatedContactId: "101" }),
    ).rejects.toBeInstanceOf(HubSpotConfirmationRequiredError);
    expect(f.calls).toHaveLength(0);
  });

  it("posts to the documented notes object route once confirmed", async () => {
    // Mutation: send the write to the deals object route → red on the path.
    const { c, f } = connector({ routes: [writeRoute("notes")] });
    const out = await c.createNote(
      { body: "call summary", associatedContactId: "101" },
      { confirmed: true },
    );
    expect(out.id).toBe("n_1");
    expect(f.paths()[0]).toBe(`/crm/objects/${HUBSPOT_API_VERSION}/notes`);
    expect(String(f.calls[0].init.method)).toBe("POST");
  });

  it("refuses applyWrite outright — the named write registry is not this track's", async () => {
    // Mutation: let applyWrite fall through to a request → red.
    const { c, f } = connector();
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toBeInstanceOf(Error);
    expect(f.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocked boundary + capability honesty
// ─────────────────────────────────────────────────────────────────────────────

describe("blocked boundary", () => {
  it("rejects every I/O method with ConnectorBlockedError when nothing is wired", async () => {
    // Nothing is mocked here: with no token resolver the connector IS the stub.
    // Mutation: let health() return { ok: false } instead of rejecting → red.
    const { c, f } = connector({ blocked: true });
    await expect(c.connect()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.runRead("get_open_invoices", {})).rejects.toBeInstanceOf(Error);
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toBeInstanceOf(Error);
    await expect(
      c.pollObjectChanges({ objectType: "contacts", watermark: 0 }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(
      c.runBackfill({ objectType: "contacts", properties: ["email"] }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(
      c.createNote({ body: "x", associatedContactId: "1" }, { confirmed: true }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("reports disconnected — not connected, and not an error — before a token exists", async () => {
    // ADR-041 §2: the connector ships OFF and says so. "Disconnected" is a
    // state, not a fault, and must be distinguishable from every fault.
    // Mutation: default the state to "connected" → red.
    const { c } = connector({ blocked: true });
    const status = await c.status();
    expect(status.state).toBe("disconnected");
    expect(status.hasToken).toBe(false);
    expect(status.ok).toBe(false);
  });

  it("introspects without any network at all", async () => {
    // HubSpot's schema is HubSpot's — published and versioned — so there is
    // nothing to discover. The fingerprint still has to exist so drift-freeze
    // semantics stay coherent across every track, and it pins the API version
    // INTO itself: a version bump can change field shapes without changing the
    // column list, and a fingerprint blind to that reports "no drift".
    // Mutation: drop the version from the fingerprint → red.
    const { c, f } = connector({ blocked: true });
    const out = await c.introspect();
    expect(f.calls).toHaveLength(0);
    expect(out.tables.map((t) => t.name).sort()).toEqual([...HUBSPOT_DATASETS].sort());
    expect(out.fingerprint).toContain(HUBSPOT_API_VERSION);
    expect(c.schemaFingerprint).toBe(out.fingerprint);
  });

  it("serves the CRM datasets and refuses the accounting/practice reads", async () => {
    // Before WARP-2466 this track declared `crm_*` names outside the union and
    // served NOTHING the read registry could reach. The reconciliation showed
    // four of them ARE canonical CRM shapes, so the track now serves them —
    // and still refuses the accounting and practice reads, which is the part
    // that matters: `[]` from get_open_invoices reads as "you are owed
    // nothing", a confident false statement about money.
    // Mutation: widen HUBSPOT_DATASETS to include "invoice" → red.
    const { c, f } = connector();
    for (const q of ["get_open_invoices", "get_open_bills", "get_schedule_today"]) {
      await expect(c.runRead(q, {})).rejects.toBeInstanceOf(DatasetNotServedError);
    }
    expect(f.calls).toHaveLength(0);
    // Every declared name is now IN the shared vocabulary — the reconciliation
    // this suite used to assert the absence of.
    // Mutation: declare a name outside DATASETS → tsc red at the connector,
    // and this red here.
    for (const d of HUBSPOT_DATASETS) expect(DATASETS).toContain(d);
    expect([...HUBSPOT_DATASETS]).toEqual(["contact", "company", "deal", "ticket", "engagement"]);
  });

  it("sends the token as a bearer credential and never in a URL", async () => {
    // A credential in a query string is a credential in every proxy log.
    // Mutation: append the token as a query parameter → red.
    const { c, f } = connector({ routes: searchRoute([]) });
    await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    for (const call of f.calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(call.url).not.toContain("pat-");
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      // Never follow a redirect: the fetch spec strips Authorization on a
      // cross-origin hop, but the token's safety must not rest on every
      // runtime implementing that correctly.
      expect(call.init.redirect).toBe("error");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

const HUBSPOT_DIR = join(fileURLToPath(new URL("../src/hubspot/", import.meta.url)));

function hubspotSourcePath(f: string): string {
  return join(HUBSPOT_DIR, f);
}
function hubspotSources(): string[] {
  return readdirSync(HUBSPOT_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(HUBSPOT_DIR, f));
}

async function expectCapability(call: () => Promise<unknown>, tier: string): Promise<void> {
  let caught: unknown;
  try {
    await call();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(HubSpotCapabilityUnavailableError);
  expect((caught as HubSpotCapabilityUnavailableError).requiredTier).toBe(tier);
  expect(Array.isArray(caught)).toBe(false);
}

describe("updated_at — the canonical modification time (WARP-2494)", () => {
  const MODIFIED_MS = Date.UTC(2026, 7, 20, 9, 30, 0);

  it("emits updated_at as a UTC ISO instant parsed from hs_lastmodifieddate", async () => {
    // `hs_lastmodifieddate` is a PROPERTY on the object (it is the Search
    // filter and sort key at connector.ts:1430/1438, and the fixture carries it
    // inside `properties`), and it arrives as epoch milliseconds. The canonical
    // column is a full UTC ISO instant, matching every other track.
    // Mutation: drop the `updated_at` mapping from toRecord → red (undefined).
    // Mutation: parse `createdate` instead → red (2026-07-21, not 2026-08-20).
    const { c } = connector({ routes: searchRoute([record("c-1", MODIFIED_MS)]) });
    const out = await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    expect(out.records).toHaveLength(1);
    expect(out.records[0].updated_at).toBe("2026-08-20T09:30:00.000Z");
    // The creation time is present on the record and is a DIFFERENT instant, so
    // the assertion above cannot pass by coincidence.
    expect(out.records[0].properties.createdate).not.toBe(
      String(MODIFIED_MS),
    );
  });

  it("every produced updated_at parses as an ISO instant (COLUMN_KIND.timestamp)", async () => {
    // Mutation: emit the raw epoch-ms string instead of the ISO form → red.
    const { c } = connector({
      routes: searchRoute([record("c-1", MODIFIED_MS), record("c-2", MODIFIED_MS + 1000)]),
    });
    const out = await c.pollObjectChanges({ objectType: "contacts", watermark: 0 });
    expect(out.records).toHaveLength(2);
    for (const r of out.records) {
      expect(typeof r.updated_at).toBe("string");
      // Round-trips: a real UTC ISO instant, not merely something parseable.
      expect(new Date(r.updated_at).toISOString()).toBe(r.updated_at);
    }
  });

  it("requests hs_lastmodifieddate even when the caller names its own properties", async () => {
    // A caller asking for `["email"]` is not asking to LOSE the modification
    // stamp — but a plain `??` fallback gives exactly that, and `toRecord` then
    // drops every returned row for want of a parseable stamp. The failure
    // surfaces as an empty poll or a watermark stall, never as "you forgot a
    // property", which is why this is asserted on the outgoing REQUEST.
    // Mutation: restore `input.properties ?? [LAST_MODIFIED_PROPERTY]` → red.
    const { c, f } = connector({ routes: searchRoute([record("c-1", MODIFIED_MS)]) });
    await c.pollObjectChanges({
      objectType: "contacts",
      watermark: 0,
      properties: ["email"],
    });
    const body = f.bodyOf(0);
    expect(body.properties).toContain("hs_lastmodifieddate");
    expect(body.properties).toContain("email");
  });

  it("does not ask for hs_lastmodifieddate twice when the caller already named it", async () => {
    // Mutation: append unconditionally instead of checking membership → red.
    const { c, f } = connector({ routes: searchRoute([record("c-1", MODIFIED_MS)]) });
    await c.pollObjectChanges({
      objectType: "contacts",
      watermark: 0,
      properties: ["hs_lastmodifieddate", "email"],
    });
    const asked = f.bodyOf(0).properties as string[];
    expect(asked.filter((x) => x === "hs_lastmodifieddate")).toHaveLength(1);
  });

  it("a caller-supplied property list still yields rows, not a watermark stall", async () => {
    // The end-to-end consequence of the bug above, stated as behaviour: before
    // the fix this threw HubSpotWatermarkStallError with zero records.
    // Mutation: restore the `??` fallback → red.
    const { c } = connector({ routes: searchRoute([record("c-1", MODIFIED_MS)]) });
    const out = await c.pollObjectChanges({
      objectType: "contacts",
      watermark: 0,
      properties: ["email"],
    });
    expect(out.records).toHaveLength(1);
    expect(out.records[0].updated_at).toBe("2026-08-20T09:30:00.000Z");
  });

  it("puts hs_lastmodifieddate in a backfill export's property list too", async () => {
    // An Exports CSV without the modification column cannot produce updated_at
    // for a single backfilled row.
    // Mutation: send `[...input.properties]` verbatim → red.
    const { c, f } = connector({ routes: exportRoutes() });
    await c.runBackfill({ objectType: "contacts", properties: ["email"] });
    const body = f.bodyOf(0);
    expect(body.objectProperties).toContain("hs_lastmodifieddate");
    expect(body.objectProperties).toContain("email");
  });
});

function record(id: string, modifiedAtMs: number) {
  return {
    id,
    properties: {
      hs_lastmodifieddate: String(modifiedAtMs),
      // Thirty days BEFORE the modification stamp, on purpose: a projection
      // that reaches for the creation time instead of the modification time
      // must not be able to pass by coincidence (WARP-2494).
      createdate: String(modifiedAtMs - 30 * 24 * 60 * 60 * 1000),
      email: `${id}@example.test`,
    },
  };
}

/** N records, one millisecond apart, oldest first. */
function syntheticCorpus(n: number) {
  const base = NOW - n - 1_000_000;
  return Array.from({ length: n }, (_, i) => record(`c-${i}`, base + i));
}

function searchRoute(results: ReturnType<typeof record>[]): Route[] {
  return [{ match: /\/search$/, responses: [{ body: { total: results.length, results } }] }];
}

/**
 * A Search stub that behaves like HubSpot: it honours the filter floor and the
 * `after` offset, and it answers **HTTP 400** — not a truncation — once the
 * offset would cross the 10,000-record cap. That 400 is what makes the
 * deep-pagination mutation observable rather than merely slower.
 */
function corpusSearchRoute(
  corpus: ReturnType<typeof record>[],
  opts: { allowStall?: boolean } = {},
): Route {
  return {
    match: /\/search$/,
    handler: (_url, init) => {
      const body = JSON.parse(String(init.body));
      const floor = Number(body.filterGroups[0].filters[0].value);
      const after = Number(body.after ?? 0);
      if (after >= HUBSPOT_SEARCH_RESULT_CAP) {
        return {
          status: 400,
          body: { category: "VALIDATION_ERROR", message: "The value for after is too large" },
        };
      }
      const matching = corpus.filter((r) => Number(r.properties.hs_lastmodifieddate) >= floor);
      const page = matching.slice(after, after + HUBSPOT_SEARCH_PAGE_SIZE);
      const nextOffset = after + page.length;
      // `allowStall` models the pathological portal: a bulk import that stamped
      // more than the cap's worth of records with one identical timestamp, so
      // the feed always claims more and the floor can never advance.
      const hasMore = opts.allowStall
        ? nextOffset < matching.length || matching.length >= HUBSPOT_SEARCH_RESULT_CAP
        : nextOffset < matching.length;
      return {
        body: {
          total: matching.length,
          results: page,
          ...(hasMore && page.length > 0
            ? { paging: { next: { after: String(nextOffset) } } }
            : {}),
        },
      };
    },
  };
}

function objectRoute(): Route[] {
  return [
    {
      // Matched on the record tail: under DBV the object name no longer sits
      // adjacent to `objects/` (it is `objects/<version>/contacts/101`), so a
      // regex spanning that join would silently stop matching.
      match: /contacts\/101/,
      responses: [
        {
          body: {
            id: "101",
            properties: { email: "a@example.test" },
            associations: { deals: { results: [{ id: "501" }, { id: "502" }] } },
          },
        },
      ],
    },
  ];
}

function exportRoutes(): Route[] {
  return [
    { match: /export\/async$/, responses: [{ body: { id: "exp_1" } }] },
    {
      match: /tasks\/exp_1\/status/,
      responses: [
        { body: { status: "PROCESSING" } },
        {
          body: {
            status: "COMPLETE",
            result: "https://hubspot-export-files.example.test/exp_1",
          },
        },
      ],
    },
  ];
}

function writeRoute(object: string): Route {
  return {
    match: new RegExp(`crm/objects/${HUBSPOT_API_VERSION}/${object}$`),
    responses: [{ body: { id: object === "notes" ? "n_1" : "t_1" } }],
  };
}

function permissionDeniedResponse(): StubResponse {
  return {
    status: 403,
    body: {
      status: "error",
      message: "This app hasn't been granted all required scopes",
      category: "USER_DOES_NOT_HAVE_PERMISSIONS",
    },
  };
}

function permissionDeniedRoute(): Route {
  return { match: /.*/, responses: [permissionDeniedResponse()] };
}

/** Drive N Search round trips through one connector. */
async function drivePolls(c: HubSpotConnector, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await c.pollObjectChanges({ objectType: "contacts", watermark: i });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical row mappers (WARP-2497)
//
// `runRead` threw by design until this story, so every dataset this track
// declares produced raw vendor JSON and no canonical rows at all — WARP-2218's
// scheduled sync ran, reported success, and landed nothing.
//
// The properties below are what "a row mapper" has to mean, and each is
// asserted for EVERY served dataset rather than for a representative one,
// because the failure mode is per-dataset: a mapper that forgets `currency` on
// `deal` is invisible to a `contact` test.
// ─────────────────────────────────────────────────────────────────────────────

/** ISO-8601 as `canonicalInstant` emits it: always UTC, always milliseconds. */
const UTC_INSTANT = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 2026-08-20T09:30:00Z — the modification stamp every fixture below shares. */
const MODIFIED_MS = Date.UTC(2026, 7, 20, 9, 30, 0);
/** Thirty days earlier, so a mapper reaching for `createdate` where it wants
 *  `hs_lastmodifieddate` cannot pass by coincidence. */
const CREATED_MS = MODIFIED_MS - 30 * 24 * 60 * 60 * 1000;

/**
 * One vendor record per served dataset, in HubSpot's own property spellings.
 *
 * Every fixture carries `hs_object_source` and `hs_all_owner_ids` — properties
 * this product never asked for. They are the leak detector: a mapper written as
 * `{ ...record.properties, ... }` passes a key-set test that only checks the
 * canonical names are PRESENT, and fails the one below that checks nothing else
 * is.
 */
const HUBSPOT_FIXTURES: ReadonlyArray<{
  dataset: string;
  readQuery: string;
  properties: Record<string, string>;
}> = [
  {
    dataset: "contact",
    readQuery: "find_contact",
    properties: {
      createdate: String(CREATED_MS),
      firstname: "Ada",
      lastname: "Lovelace",
      email: "ada@example.test",
      associatedcompanyid: "co-77",
      lifecyclestage: "customer",
      hs_object_source: "IMPORT",
      hs_all_owner_ids: "9911",
    },
  },
  {
    dataset: "company",
    readQuery: "get_company",
    properties: {
      createdate: String(CREATED_MS),
      name: "Analytical Engines Ltd",
      domain: "engines.example.test",
      hs_object_source: "IMPORT",
      hs_all_owner_ids: "9911",
    },
  },
  {
    dataset: "deal",
    readQuery: "get_deals_by_stage",
    properties: {
      createdate: String(CREATED_MS),
      closedate: String(MODIFIED_MS + 86_400_000),
      dealname: "Difference Engine renewal",
      dealstage: "presentationscheduled",
      // A grouped decimal, which is what a portal with a formatting locale
      // returns: `Number("1,500.00")` is NaN, so a mapper that skips the
      // comma-tolerant read drops the amount silently.
      amount: "1,500.00",
      deal_currency_code: "USD",
      hs_object_source: "IMPORT",
      hs_all_owner_ids: "9911",
    },
  },
  {
    dataset: "ticket",
    readQuery: "get_tickets_by_status",
    properties: {
      createdate: String(CREATED_MS),
      closed_date: String(MODIFIED_MS + 3_600_000),
      subject: "Punch card reader jams",
      hs_pipeline_stage: "open",
      hs_ticket_priority: "HIGH",
      hs_object_source: "IMPORT",
      hs_all_owner_ids: "9911",
    },
  },
  {
    dataset: "engagement",
    readQuery: "get_engagements",
    properties: {
      hs_timestamp: String(MODIFIED_MS - 7_200_000),
      hs_object_source: "IMPORT",
      hs_all_owner_ids: "9911",
    },
  },
];

/** A Search stub answering every object type from one fixture record. */
function fixtureSearchRoute(properties: Record<string, string>): Route[] {
  return [
    {
      match: /\/search$/,
      responses: [
        {
          body: {
            total: 1,
            results: [
              {
                id: "rec-1",
                properties: { ...properties, hs_lastmodifieddate: String(MODIFIED_MS) },
              },
            ],
          },
        },
      ],
    },
  ];
}

describe("canonical row mappers", () => {
  for (const fx of HUBSPOT_FIXTURES) {
    it(`${fx.dataset}: emits EXACTLY the canonical columns, no more and no fewer`, async () => {
      // Mutation A (drop): delete `case "currency":` from `hubspotLookup`, or
      //   remove a name from CANONICAL_COLUMNS.deal → the key set shrinks → red.
      // Mutation B (leak): make the mapper spread the property bag
      //   (`{ ...record.properties, ...row }`) → `hs_object_source` and
      //   `hs_all_owner_ids` appear → red.
      // The two mutations are opposite directions and BOTH are caught, which a
      // `toContain`-style assertion would not do.
      const { c } = connector({ routes: fixtureSearchRoute(fx.properties) });
      const rows = (await c.runRead(fx.readQuery, {})) as Record<string, unknown>[];

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(
          [...CANONICAL_COLUMNS[fx.dataset as never]].sort(),
        );
      }
    });

    it(`${fx.dataset}: every value matches its COLUMN_KIND`, async () => {
      // Mutation: drop the `money`/`count` branch from projectCanonicalRow → the
      // deal row's amount is the string "1,500.00" → red. A money column read as
      // text serialises an amount as a grouped string and breaks every aggregate
      // over it, which is exactly the defect COLUMN_KIND exists for.
      const { c } = connector({ routes: fixtureSearchRoute(fx.properties) });
      const rows = (await c.runRead(fx.readQuery, {})) as Record<string, unknown>[];

      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (value === undefined) continue;
          switch (COLUMN_KIND[column]) {
            case "timestamp":
              expect(String(value), `${fx.dataset}.${column}`).toMatch(UTC_INSTANT);
              break;
            case "money":
            case "count":
              expect(typeof value, `${fx.dataset}.${column}`).toBe("number");
              break;
            default:
              expect(typeof value, `${fx.dataset}.${column}`).toBe("string");
              break;
          }
        }
      }
    });
  }

  it("fills every column HubSpot has a property for, so the shape is not vacuously right", async () => {
    // A key-set test passes just as well on a mapper that returns every column
    // undefined. This is the other half: the values below come from four
    // DIFFERENT places — the object id, a property, a RENAMED property, and the
    // already-parsed modification stamp — so a mapper that lost any one of
    // those routes is caught.
    // Mutation: map `name` from `p.name` on deals (instead of `p.dealname`) →
    //           undefined → red.
    const fx = HUBSPOT_FIXTURES.find((f) => f.dataset === "deal")!;
    const { c } = connector({ routes: fixtureSearchRoute(fx.properties) });
    const [row] = (await c.runRead("get_deals_by_stage", {})) as Record<string, unknown>[];

    expect(row).toMatchObject({
      deal_id: "rec-1",
      created_at: new Date(CREATED_MS).toISOString(),
      name: "Difference Engine renewal",
      stage: "presentationscheduled",
      amount: 1500,
      currency: "USD",
      updated_at: new Date(MODIFIED_MS).toISOString(),
    });
  });

  it("takes updated_at from hs_lastmodifieddate, never from createdate", async () => {
    // The WARP-2494 contract, restated at the ROW level: a watermark trusts
    // this column, so a record created and never touched must not advance it.
    // Mutation: `case "updated_at": return p.createdate;` → red.
    const fx = HUBSPOT_FIXTURES.find((f) => f.dataset === "contact")!;
    const { c } = connector({ routes: fixtureSearchRoute(fx.properties) });
    const [row] = (await c.runRead("find_contact", {})) as Record<string, unknown>[];

    expect(row.updated_at).toBe(new Date(MODIFIED_MS).toISOString());
    expect(row.updated_at).not.toBe(row.created_at);
  });

  it("unions all five engagement object types and labels each with its type", async () => {
    // `engagement` is the one dataset that is not one HubSpot object: a
    // timeline activity is a call, an email, a meeting, a note or a task.
    // Mutation: drop "tasks" from HUBSPOT_DATASET_OBJECT_TYPES.engagement →
    //           four rows come back → red. Mutation: return a constant for
    //           `type` → the set collapses to one value → red.
    const { c, f } = connector({
      routes: [
        {
          match: /\/search$/,
          handler: (url) => {
            const kind = /objects\/([a-z]+)\/search/.exec(url)?.[1] ?? "?";
            return {
              body: {
                total: 1,
                results: [
                  {
                    id: `${kind}-1`,
                    properties: {
                      hs_lastmodifieddate: String(MODIFIED_MS),
                      hs_timestamp: String(MODIFIED_MS - 7_200_000),
                    },
                  },
                ],
              },
            };
          },
        },
      ],
    });

    const rows = (await c.runRead("get_engagements", {})) as Record<string, unknown>[];

    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.type))).toEqual(
      new Set(["call", "email", "meeting", "note", "task"]),
    );
    // Five object types means five searches, each against its own endpoint.
    expect(new Set(f.searchCalls().map((call) => new URL(call.url).pathname)).size).toBe(5);
  });

  it("passes `since` to HubSpot as the hs_lastmodifieddate floor", async () => {
    // The poller's watermark has to reach the VENDOR, not be applied to rows
    // after a full enumeration — otherwise every tick re-reads the whole portal
    // and the incremental path is incremental in name only.
    // Mutation: ignore `params.since` (the shipped `_params` signature) → the
    //           filter floor is 0 → red.
    const fx = HUBSPOT_FIXTURES.find((f) => f.dataset === "contact")!;
    const { c, f } = connector({ routes: fixtureSearchRoute(fx.properties) });

    await c.runRead("find_contact", { since: "2026-08-19T00:00:00Z" });

    const body = f.bodyOf(0);
    expect(body.filterGroups[0].filters[0].propertyName).toBe("hs_lastmodifieddate");
    expect(Number(body.filterGroups[0].filters[0].value)).toBe(Date.UTC(2026, 7, 19));
  });

  it("requests the properties each dataset's row is actually built from", async () => {
    // HubSpot returns ONLY the properties a request names, so an unrequested
    // property is an unfillable column — and one that fails silently, because
    // the row still has the key.
    // Mutation: drop "deal_currency_code" from HUBSPOT_DATASET_PROPERTIES.deal
    //           → red here, and the deal row's `currency` goes undefined.
    const fx = HUBSPOT_FIXTURES.find((f) => f.dataset === "deal")!;
    const { c, f } = connector({ routes: fixtureSearchRoute(fx.properties) });

    await c.runRead("get_deals_by_stage", {});

    const asked = f.bodyOf(0).properties as string[];
    for (const p of [
      "createdate",
      "closedate",
      "dealname",
      "dealstage",
      "amount",
      "deal_currency_code",
    ]) {
      expect(asked, `deal must request ${p}`).toContain(p);
    }
    // Still guaranteed by withLastModifiedProperty, not by this table.
    expect(asked).toContain("hs_lastmodifieddate");
  });

  it("filters on a supplied param and enumerates without one", async () => {
    // The registry's queries carry mandatory filters written for the SQL track;
    // the sync runner passes `{}` and wants the dataset enumerated. Both have to
    // work off one read name.
    // Mutation: make the stage filter unconditional → the `{}` call returns
    //           nothing → red.
    const routes: Route[] = [
      {
        match: /\/search$/,
        responses: [
          {
            body: {
              total: 2,
              results: [
                {
                  id: "d-1",
                  properties: {
                    hs_lastmodifieddate: String(MODIFIED_MS),
                    dealstage: "closedwon",
                    amount: "10",
                  },
                },
                {
                  id: "d-2",
                  properties: {
                    hs_lastmodifieddate: String(MODIFIED_MS),
                    dealstage: "qualified",
                    amount: "20",
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    const all = (await connector({ routes }).c.runRead("get_deals_by_stage", {})) as Record<
      string,
      unknown
    >[];
    expect(all.map((r) => r.deal_id).sort()).toEqual(["d-1", "d-2"]);

    const filtered = (await connector({ routes }).c.runRead("get_deals_by_stage", {
      stage: "closedwon",
    })) as Record<string, unknown>[];
    expect(filtered.map((r) => r.deal_id)).toEqual(["d-1"]);
  });

  it("reproduces each read's documented ORDER BY", async () => {
    // `get_deals_by_stage` is `ORDER BY amount DESC, deal_id`. Sorting ascending
    // and reversing would also reverse the id tiebreak.
    // Mutation: drop the descending pass → red.
    const routes: Route[] = [
      {
        match: /\/search$/,
        responses: [
          {
            body: {
              total: 3,
              results: ["a", "b", "c"].map((id, i) => ({
                id,
                properties: {
                  hs_lastmodifieddate: String(MODIFIED_MS),
                  dealstage: "qualified",
                  amount: String([100, 300, 200][i]),
                },
              })),
            },
          },
        ],
      },
    ];
    const rows = (await connector({ routes }).c.runRead("get_deals_by_stage", {})) as Record<
      string,
      unknown
    >[];
    expect(rows.map((r) => r.deal_id)).toEqual(["b", "c", "a"]);
  });

  it("still refuses a read whose dataset this track does not serve", async () => {
    // The capability statement WARP-2466 established must survive the mappers:
    // `[]` from get_open_invoices reads as "you are owed nothing".
    // Mutation: drop the assertDatasetsServed call → the switch's default throws
    //           a blocked error instead of DatasetNotServedError → red.
    const { c, f } = connector();
    await expect(c.runRead("get_open_invoices", {})).rejects.toBeInstanceOf(DatasetNotServedError);
    expect(f.calls).toHaveLength(0);
  });
});
