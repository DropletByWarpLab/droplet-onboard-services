/**
 * KlaviyoConnector.
 *
 * `fetch` is INJECTED, never patched globally, and every test asserts on the
 * CALLS the connector made — not only on what it returned. Two classes of
 * failure make that distinction load-bearing here:
 *
 *  1. **The credential.** A test that inspects a returned error still passes if
 *     the request already went out carrying the customer's private API key. So
 *     every guard's test asserts on ZERO fetch calls.
 *  2. **The silent ones.** Klaviyo's delta filters are PER-ENDPOINT and are not
 *     spelled alike — `/api/profiles` filters `updated`, `/api/campaigns`
 *     filters `updated_at`, `/api/events` filters `datetime`, and
 *     `/api/lists/{id}/profiles` has no modification filter at all. A wrong
 *     parameter is the classic full-scan-reported-as-a-delta: the rows come
 *     back looking perfectly correct. So the delta tests assert on the OUTGOING
 *     REQUEST and each one cites the vendor page that states the literal.
 *
 * Every test names the mutation that must turn it red.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  DailyCallBudget,
  InvalidKlaviyoCredentialError,
  KLAVIYO_ALLOWED_API_HOSTS,
  KLAVIYO_API_BASE_PATH,
  KLAVIYO_API_BASE_URL,
  KLAVIYO_API_REVISION,
  KLAVIYO_AUTHORIZATION_SCHEME,
  KLAVIYO_CAMPAIGN_CHANNEL_FILTER,
  KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE,
  KLAVIYO_CAMPAIGN_MESSAGE_TYPE,
  KLAVIYO_CURSOR_PARAM,
  KLAVIYO_DATASETS,
  KLAVIYO_DELTA_FILTERS,
  KLAVIYO_ENDPOINTS,
  KLAVIYO_EVENT_METRIC_INCLUDE,
  KLAVIYO_FALL_FORWARD_OPT_OUT_HEADER,
  KLAVIYO_FALL_FORWARD_OPT_OUT_VALUE,
  KLAVIYO_LIST_PROFILES_FILTERS,
  KLAVIYO_LIST_PROFILES_SORT,
  KLAVIYO_MAX_RETRIES,
  KLAVIYO_PAGE_SIZE_PARAM,
  KLAVIYO_POST_QUERY_PATHS,
  KLAVIYO_PROFILE_COUNT_FIELD,
  KLAVIYO_PROFILE_COUNT_VALUE,
  KLAVIYO_PROVIDER,
  KLAVIYO_RATE_LIMITS,
  KLAVIYO_READABLE_RESOURCES,
  KLAVIYO_REPORT_CALLS_PER_DAY,
  KLAVIYO_REPORT_STATISTICS,
  KLAVIYO_REVISION_HEADER,
  KLAVIYO_SCAN_MODE,
  KLAVIYO_UNRESOLVED_OBLIGATIONS,
  KlaviyoCapabilityMissingError,
  KlaviyoConnector,
  KlaviyoRateLimitedError,
  KlaviyoReauthorizationRequiredError,
  KlaviyoReportBudgetExhaustedError,
  KlaviyoRevisionRetiredError,
  KlaviyoTimeoutError,
  UnsafeKlaviyoBaseUrlError,
  assertKlaviyoDatasetsCarryNoMoney,
  assertKlaviyoDeltaClause,
  assertKlaviyoMemberFilterField,
  assertKlaviyoMethod,
  assertKlaviyoProfileCountPath,
  assertReadableKlaviyoResource,
  assertSafeKlaviyoBaseUrl,
  klaviyoDeltaClause,
  klaviyoInstant,
  klaviyoLookup,
  klaviyoWatermark,
  parseKlaviyoApiKey,
  type KlaviyoPurgeStore,
} from "../src/klaviyo/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { CANONICAL_COLUMNS, COLUMN_KIND, REQUIRED_CANONICAL } from "../src/export-drop/profiles.js";
import { projectCanonicalRow } from "../src/canonical-row.js";

/** 2026-09-03T12:00:00Z, the clock every test runs on. */
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

/**
 * A well-formed fixture key. Not a real credential.
 *
 * COMPOSED FROM PARTS ON PURPOSE, and deliberately NOT 34 characters after the
 * prefix — do not "tidy" it back into one literal. This file is path-allowlisted
 * in `.gitleaks.toml`, so local `gitleaks` passes either way, but GitHub PUSH
 * PROTECTION runs its own Klaviyo detector that no repo config can allowlist and
 * that matches a contiguous `pk_` + long-alphanumeric literal. Keeping the
 * prefix and the body in separate tokens means the matching string never exists
 * in the source while every test still exercises a realistically-shaped key.
 */
const KEY = "pk_" + "fixturenotarealkey" + "000111222";
const HOST = new URL(KLAVIYO_API_BASE_URL).hostname;

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
interface Route {
  match: RegExp;
  responses: StubResponse[];
}
interface Recorded {
  url: string;
  init: Record<string, unknown>;
}

/** A routed fetch stub that records every call. */
function stubFetch(routes: Route[]) {
  const calls: Recorded[] = [];
  const seen = new Map<number, number>();

  const impl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    const idx = routes.findIndex((r) => r.match.test(url));
    if (idx === -1) throw new Error(`test stub has no route for ${url}`);
    const n = seen.get(idx) ?? 0;
    seen.set(idx, n + 1);
    const list = routes[idx].responses;
    const r = list[Math.min(n, list.length - 1)];
    const status = r.status ?? 200;
    const headers = r.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => {
          const hit = Object.entries(headers).find(
            ([k]) => k.toLowerCase() === name.toLowerCase(),
          );
          return hit ? hit[1] : null;
        },
      },
      json: async () => r.body ?? {},
    } as unknown as Response;
  };

  return {
    impl,
    calls,
    urls: () => calls.map((c) => c.url),
    paths: () => calls.map((c) => new URL(c.url).pathname),
    params: (i: number) => new URL(calls[i].url).searchParams,
    headers: (i: number) => calls[i].init.headers as Record<string, string>,
    method: (i: number) => calls[i].init.method as string,
    body: (i: number) => JSON.parse(String(calls[i].init.body)) as Record<string, unknown>,
  };
}

function connector(
  opts: {
    routes?: Route[];
    baseUrl?: string;
    key?: string;
    blocked?: boolean;
    timeoutMs?: number;
    apiRevision?: string;
    conversionMetricId?: string;
    reportBudget?: DailyCallBudget;
    purgeStore?: KlaviyoPurgeStore;
    audit?: (e: { action: string; scope: Record<string, unknown> }) => void;
    connectionId?: string;
    sleeps?: number[];
  } = {},
) {
  const f = stubFetch(opts.routes ?? [{ match: /.*/, responses: [{ body: { data: [] } }] }]);
  const sleeps = opts.sleeps ?? [];
  const c = new KlaviyoConnector(
    {
      credentialsSecretRef: "secret://klaviyo/acct_fixture",
      connectionId: opts.connectionId ?? "conn_a",
      conversionMetricId: opts.conversionMetricId,
      apiRevision: opts.apiRevision,
      baseUrl: opts.baseUrl,
    },
    {
      fetchImpl: f.impl,
      now: () => NOW,
      // Deterministic: no real waiting, and jitter of zero so a backoff figure
      // is exactly the vendor's own Retry-After.
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0,
      timeoutMs: opts.timeoutMs,
      reportBudget: opts.reportBudget,
      purgeStore: opts.purgeStore,
      audit: opts.audit,
      // `blocked` leaves the default resolver in place, which is the shipped-off
      // state: nothing wired, so every I/O path blocks honestly.
      resolveApiKey: opts.blocked ? undefined : async () => opts.key ?? KEY,
    },
  );
  return { c, f, sleeps };
}

const KLAVIYO_DIR = join(fileURLToPath(new URL("../src/klaviyo/", import.meta.url)));

function klaviyoSource(file = "connector.ts"): string {
  return readFileSync(join(KLAVIYO_DIR, file), "utf8");
}

function klaviyoSources(): string[] {
  return readdirSync(KLAVIYO_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(KLAVIYO_DIR, f), "utf8"));
}

/** A JSON:API collection page. `next` absent ⇒ this is the last page. */
function page(data: unknown[], next?: string, included?: unknown[]) {
  return {
    data,
    ...(included === undefined ? {} : { included }),
    links: { self: `${KLAVIYO_API_BASE_URL}${KLAVIYO_API_BASE_PATH}/x`, next: next ?? null },
  };
}

function profile(id: string, attrs: Record<string, unknown> = {}) {
  return { type: "profile", id, attributes: { email: `${id}@example.test`, ...attrs } };
}

// ─────────────────────────────────────────────────────────────────────────────
// The host guard — one static host, and the code-side half of the registry
// ─────────────────────────────────────────────────────────────────────────────

describe("static host guard", () => {
  it("derives the allowed-host set FROM the base-URL literal, never a hand-written list", () => {
    // Mutation: replace the derivation with `new Set(["a.klaviyo.com"])` → this
    // stays green, so the REAL protection is the next test: a second host
    // cannot be added without a second whole-string literal for the egress
    // scanner to find.
    expect([...KLAVIYO_ALLOWED_API_HOSTS]).toEqual([HOST]);
    expect(KLAVIYO_ALLOWED_API_HOSTS.size).toBe(1);
  });

  it("keeps the base URL as a WHOLE-STRING https literal the egress scanner can extract", () => {
    // Unlike Mailchimp — whose host is assembled at runtime and whose registry
    // entry is `kind: dynamic` and therefore enforces nothing — this vendor has
    // one global endpoint, so `kind: egress` genuinely constrains it. The
    // scanner is a static text scan: it can only see what it literally reads.
    // Mutation: rewrite as "https://" + "a.klaviyo" + ".com" → red.
    expect(klaviyoSource()).toContain(`"${KLAVIYO_API_BASE_URL}"`);
    expect(KLAVIYO_API_BASE_URL).toBe("https://a.klaviyo.com");
  });

  it("refuses a SUFFIX-ATTACK host on ZERO fetch calls", () => {
    // The attack exact-match exists to stop: a host that ends with the real one
    // but is owned by someone else.
    // Mutation: change `KLAVIYO_ALLOWED_API_HOSTS.has(host)` to
    // `host.endsWith("klaviyo.com")` → red here AND red on the zero-fetch
    // assertion, which is the half proving the key never left.
    const f = stubFetch([{ match: /.*/, responses: [{ body: {} }] }]);
    expect(
      () =>
        new KlaviyoConnector(
          { credentialsSecretRef: "s", connectionId: "c", baseUrl: `https://${HOST}.evil.test` },
          { fetchImpl: f.impl, now: () => NOW, resolveApiKey: async () => KEY },
        ),
    ).toThrow(UnsafeKlaviyoBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses plain http, userinfo, a non-443 port, a path, a query and a fragment", () => {
    // Mutation: drop any one check → red. A private API key over http is the
    // key given away; a base URL carrying a path silently re-targets every
    // request the connector will ever make.
    const f = stubFetch([{ match: /.*/, responses: [{ body: {} }] }]);
    for (const bad of [
      `http://${HOST}`,
      `https://evil@${HOST}`,
      `https://${HOST}:8443`,
      `https://${HOST}/api-proxy`,
      `https://${HOST}/?x=1`,
      `https://${HOST}/#f`,
      "not-a-url",
    ]) {
      expect(() => assertSafeKlaviyoBaseUrl(bad)).toThrow(UnsafeKlaviyoBaseUrlError);
      // ...and each reason refuses through the CONSTRUCTOR too, on zero fetch
      // calls. Testing the pure guard proves the rejection; only this half
      // proves the key never left, which is the property that matters when the
      // base URL is a `https://evil@…` that would put the credential in a URL.
      expect(
        () =>
          new KlaviyoConnector(
            { credentialsSecretRef: "s", connectionId: "c", baseUrl: bad },
            { fetchImpl: f.impl, now: () => NOW, resolveApiKey: async () => KEY },
          ),
      ).toThrow(UnsafeKlaviyoBaseUrlError);
    }
    expect(f.calls).toHaveLength(0);
    expect(assertSafeKlaviyoBaseUrl(`https://${HOST}`)).toBe(`https://${HOST}`);
    expect(assertSafeKlaviyoBaseUrl(`https://${HOST}:443/`)).toBe(`https://${HOST}`);
  });

  it("re-validates the destination on EVERY request, not once at construction", async () => {
    // A guard that ran only at construction is defeated by anything that
    // changes the connection afterwards — a re-read row, a long-lived instance,
    // a refactor that assigns the base URL per call.
    //
    // Reaching past `private` is deliberate: the invariant under test is "the
    // destination is checked at request time", and the only way to observe it
    // is to make construction-time validation insufficient.
    //
    // Mutation: use `this.baseUrl` directly in request() instead of passing it
    // back through the guard → red, and red on ZERO fetch calls.
    const { c, f } = connector();
    (c as unknown as { baseUrl: string }).baseUrl = `https://${HOST}.evil.test`;
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(UnsafeKlaviyoBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a links.next pointing off the registered host — and stops there", async () => {
    // `links.next` arrives in a RESPONSE BODY. A connector that dialled it
    // would have its destination chosen by whatever answered the last request.
    // Mutation: fetch `links.next` directly instead of lifting the cursor out
    // and rebuilding from our own base → red, and the call count would grow.
    const { c, f } = connector({
      routes: [
        {
          match: /\/api\/profiles/,
          responses: [
            {
              body: {
                data: [profile("p1")],
                links: { next: `https://${HOST}.evil.test/api/profiles?page%5Bcursor%5D=c2` },
              },
            },
          ],
        },
      ],
    });
    await expect(c.listProfiles()).rejects.toBeInstanceOf(UnsafeKlaviyoBaseUrlError);
    // Exactly the ONE page that was legitimately fetched. Nothing followed.
    expect(f.calls).toHaveLength(1);
  });

  it("refuses a resource that is not on the allowlist, before the key is resolved", () => {
    // An allowlist at the point of use, never a denylist in source: every id in
    // these paths is interpolated at runtime.
    // Mutation: add "campaign-send-jobs" to KLAVIYO_READABLE_RESOURCES → the
    // first expectation goes green, which is exactly the reviewed change this
    // shape forces somebody to make deliberately.
    expect(() =>
      assertReadableKlaviyoResource(`${KLAVIYO_API_BASE_PATH}/campaign-send-jobs`),
    ).toThrow(ConnectorBlockedError);
    expect(() => assertReadableKlaviyoResource(`${KLAVIYO_API_BASE_PATH}/profiles`)).not.toThrow();
    for (const forbidden of [
      "campaign-send-jobs",
      "profile-import-jobs",
      "profile-subscription-bulk-create-jobs",
      "profile-suppression-bulk-create-jobs",
      "templates",
      "flows",
    ]) {
      expect(KLAVIYO_READABLE_RESOURCES.has(forbidden)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth and the mandatory constant headers
// ─────────────────────────────────────────────────────────────────────────────

describe("auth and mandatory headers", () => {
  it("sends the auth header character for character", async () => {
    // developers.klaviyo.com/en/docs/authenticate_ —
    //   "Authorization: Klaviyo-API-Key your-private-api-key"
    // NOT Bearer, NOT Basic. Mutation: `Bearer ${apiKey}` → red.
    const { c, f } = connector({
      routes: [{ match: /\/api\/metrics/, responses: [{ body: page([]) }] }],
    });
    await c.probePlanAccess();
    expect(f.headers(0).Authorization).toBe(`Klaviyo-API-Key ${KEY}`);
    expect(KLAVIYO_AUTHORIZATION_SCHEME).toBe("Klaviyo-API-Key");
  });

  it("sends the revision header on EVERY request — omitting it is an error, not a default", async () => {
    // The revision header is listed as a header parameter on every endpoint
    // reference and appears in every documented example.
    // (Honest caveat, in the connector docstring too: no page checked for this
    // build states in words that it is MANDATORY, so it is sent unconditionally
    // and asserted empirically at connect time rather than claimed as verified.)
    // Mutation: send it only when config.apiRevision is set → red.
    const { c, f } = connector({
      routes: [
        { match: /\/api\/lists\/[^/?]+\?/, responses: [{ body: { data: singleList("l1", 7) } }] },
        { match: /\/api\/lists/, responses: [{ body: page([list("l1")]) }] },
      ],
    });
    await c.listAudiences();
    expect(f.calls.length).toBeGreaterThan(1);
    for (let i = 0; i < f.calls.length; i += 1) {
      expect(f.headers(i)[KLAVIYO_REVISION_HEADER]).toBe(KLAVIYO_API_REVISION);
    }
    expect(KLAVIYO_API_REVISION).toBe("2026-07-15");
  });

  it("sends the fall-forward OPT-OUT header, which is what makes a retired pin loud", async () => {
    // developers.klaviyo.com/en/docs/api_versioning_and_deprecation_policy —
    //   fall-forward is the DEFAULT: a retired revision is answered "with the
    //   same behavior as the next oldest revision". The opt-out header
    //   "results in 410 errors instead".
    //
    // Without this header the worst failure in this vendor is SILENT: a box in
    // a back office keeps getting 200s carrying a different response shape,
    // roughly two years after anybody last looked at it. One line converts that
    // into a named state.
    // Mutation: drop the header → red here, and the 410 test below stops being
    // reachable at all.
    const { c, f } = connector({
      routes: [{ match: /\/api\/metrics/, responses: [{ body: page([]) }] }],
    });
    await c.probePlanAccess();
    expect(f.headers(0)[KLAVIYO_FALL_FORWARD_OPT_OUT_HEADER]).toBe(
      KLAVIYO_FALL_FORWARD_OPT_OUT_VALUE,
    );
    expect(KLAVIYO_FALL_FORWARD_OPT_OUT_HEADER).toBe("X-Klaviyo-Revision-Fall-Forward-Opt-Out");
    expect(KLAVIYO_FALL_FORWARD_OPT_OUT_VALUE).toBe("1");
  });

  it("sends accept: application/json and never follows a redirect", async () => {
    // The fetch spec strips Authorization on cross-origin redirects, but the
    // key's safety must not rest on every runtime implementing that correctly.
    // This API has no legitimate redirect, so one is a fault, not a hop.
    // Mutation: drop `redirect: "error"` → red.
    const { c, f } = connector({
      routes: [{ match: /\/api\/metrics/, responses: [{ body: page([]) }] }],
    });
    await c.probePlanAccess();
    expect(f.headers(0).accept).toBe("application/json");
    expect(f.calls[0].init.redirect).toBe("error");
  });

  it("lets a fielded box move past a retired revision without a firmware change", async () => {
    // The apiRevision override is the REMEDIATION for a 410, not the primary
    // defence — the opt-out header is. Mutation: ignore config.apiRevision → red.
    const { c, f } = connector({
      apiRevision: "2027-01-15",
      routes: [{ match: /\/api\/metrics/, responses: [{ body: page([]) }] }],
    });
    await c.probePlanAccess();
    expect(f.headers(0)[KLAVIYO_REVISION_HEADER]).toBe("2027-01-15");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The credential
// ─────────────────────────────────────────────────────────────────────────────

describe("credential handling", () => {
  it("blocks EVERY I/O method with no credential resolved, on zero fetch calls", async () => {
    // The shipped-off state (ADR-041 §2): nothing wired, so the connector
    // degrades honestly rather than half-authenticating.
    // Mutation: default `resolveApiKey` to something that returns "" → red.
    const { c, f } = connector({ blocked: true });
    await expect(c.connect()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listProfiles()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listAudiences()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listMembers("l1")).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listCampaigns()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listEvents()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.runRead("find_contact", { query: "smith" })).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    expect(f.calls).toHaveLength(0);
  });

  it("reports disconnected — not connected — when nothing is wired", async () => {
    // An absent value defaulted into "connected" is the looks-connected-
    // syncs-nothing failure ADR-041 §5 exists to prevent.
    // Mutation: derive `ok` independently of `state` → red.
    const { c } = connector({ blocked: true });
    const status = await c.status();
    expect(status.state).toBe("disconnected");
    expect(status.ok).toBe(false);
    expect(status.hasApiKey).toBe(false);
  });

  it("refuses a PUBLIC key, which reads nothing", () => {
    // help.klaviyo.com — a private key begins `pk_`; the public key is the
    // six-character site ID used in browser tracking snippets.
    // Mutation: accept any non-empty string → red.
    expect(() => parseKlaviyoApiKey("XyZ123")).toThrow(InvalidKlaviyoCredentialError);
    expect(() => parseKlaviyoApiKey("")).toThrow(InvalidKlaviyoCredentialError);
    expect(() => parseKlaviyoApiKey(null)).toThrow(InvalidKlaviyoCredentialError);
    expect(parseKlaviyoApiKey(`  ${KEY}  `)).toBe(KEY);
  });

  it("refuses a key carrying CR, LF or a control character — header injection", () => {
    // The key is interpolated into an HTTP header value, so a newline in it is
    // a header-injection primitive, and the likeliest source is a copy-paste
    // that wrapped across two lines.
    // Mutation: relax the class to /^pk_.+$/ → red.
    expect(() => parseKlaviyoApiKey("pk_abc\r\nX-Evil: 1")).toThrow(InvalidKlaviyoCredentialError);
    expect(() => parseKlaviyoApiKey("pk_abc def")).toThrow(InvalidKlaviyoCredentialError);
    expect(() => parseKlaviyoApiKey("pk_abc\u0000def")).toThrow(InvalidKlaviyoCredentialError);
  });

  it("NEVER echoes the credential in a rejection message", () => {
    // A validation error that quotes the credential writes it into every log
    // line that renders the error.
    // Mutation: interpolate the offered value into the message → red.
    for (const bad of ["XyZ123", "pk_abc\r\nX-Evil: 1", "pk_abc def"]) {
      try {
        parseKlaviyoApiKey(bad);
        throw new Error("expected a rejection");
      } catch (err) {
        expect((err as Error).message).not.toContain(bad);
        expect((err as Error).message).not.toContain("XyZ123");
      }
    }
  });

  it("never puts the key in a thrown URL, a status object or an error message", async () => {
    // Rule 19: never log a captured secret. The failure paths are where this
    // slips — a thrown message that interpolates the request URL, or a status
    // object that reports a "prefix" for debugging.
    // Mutation: include the key (or its first eight characters) anywhere → red.
    const { c } = connector({
      routes: [{ match: /\/api\/metrics/, responses: [{ status: 500, body: {} }] }],
    });
    await expect(c.probePlanAccess()).rejects.toThrow();
    try {
      await c.probePlanAccess();
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY);
      expect((err as Error).message).not.toContain(KEY.slice(0, 12));
    }
    expect(JSON.stringify(await c.status())).not.toContain(KEY.slice(0, 12));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The delta filters — PER-ENDPOINT, and the failure mode is SILENT
// ─────────────────────────────────────────────────────────────────────────────

describe("delta filters: the literal, per dataset", () => {
  it("/api/profiles sends greater-than(updated,…) with an ascending updated sort", async () => {
    // developers.klaviyo.com/en/reference/get_profiles —
    //   filter on `updated` exists with operators greater-than and less-than
    //   ONLY. There is NO greater-or-equal on that field.
    //
    // THIS IS THE TEST THAT CATCHES A MISLABELLED SCAN. If the parameter is
    // wrong the rows still come back and still look correct; only the outgoing
    // request tells you the read was a full scan reported as a delta.
    // Mutation: send `filter=greater-or-equal(updated,…)`, or spell the field
    // `updated_at` the way /api/campaigns does → red.
    const { c, f } = connector({
      routes: [{ match: /\/api\/profiles/, responses: [{ body: page([profile("p1")]) }] }],
    });
    await c.listProfiles({ since: "2026-08-01T00:00:00.750Z" });
    expect(f.params(0).get("filter")).toBe("greater-than(updated,2026-08-01T00:00:00Z)");
    expect(f.params(0).get("sort")).toBe("updated");
  });

  it("/api/lists sends greater-than(updated,…) — the operator set there is even tighter", async () => {
    // developers.klaviyo.com/en/reference/get_lists —
    //   filter on `updated` with operator greater-than ONLY. Not even
    //   less-than. Mutation: reuse the profiles operator table here → still
    //   green today (both use greater-than), which is why the OPERATOR SET is
    //   pinned separately below.
    const { c, f } = connector({
      routes: [
        { match: /\/api\/lists\/[^/?]+\?/, responses: [{ body: { data: singleList("l1", 3) } }] },
        { match: /\/api\/lists/, responses: [{ body: page([list("l1")]) }] },
      ],
    });
    await c.listAudiences({ since: "2026-08-01T00:00:00Z" });
    expect(f.params(0).get("filter")).toBe("greater-than(updated,2026-08-01T00:00:00Z)");
    expect(f.params(0).get("sort")).toBe("updated");
  });

  it("/api/campaigns ANDs the delta onto the MANDATORY channel filter, on updated_at", async () => {
    // developers.klaviyo.com/en/reference/get_campaigns —
    //   "A channel filter is required to list campaigns" (omitting it is an
    //   ERROR, not an unfiltered list), and the delta field is spelled
    //   `updated_at` HERE ONLY, with all four operators.
    // Mutation: replace the channel filter with the delta instead of ANDing →
    // red. Mutation: spell the field `updated` → red.
    const { c, f } = connector({
      routes: [{ match: /\/api\/campaigns/, responses: [{ body: page([]) }] }],
    });
    await c.listCampaigns({ since: "2026-08-01T00:00:00Z" });
    expect(f.params(0).get("filter")).toBe(
      `and(${KLAVIYO_CAMPAIGN_CHANNEL_FILTER},greater-or-equal(updated_at,2026-08-01T00:00:00Z))`,
    );
    expect(f.params(0).get("sort")).toBe("updated_at");
    expect(f.params(0).get("include")).toBe(KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE);
    // The include and the resource TYPE are not the same string, and reading
    // the wrong one of the two blanks every subject silently.
    expect(KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE).toBe("campaign-messages");
    expect(KLAVIYO_CAMPAIGN_MESSAGE_TYPE).toBe("campaign-message");
  });

  it("/api/campaigns still sends the channel filter when there is no delta", async () => {
    // Mutation: make the whole `filter` conditional on `since` → red, and the
    // vendor answers with an error rather than an unfiltered list.
    const { c, f } = connector({
      routes: [{ match: /\/api\/campaigns/, responses: [{ body: page([]) }] }],
    });
    await c.listCampaigns();
    expect(f.params(0).get("filter")).toBe(KLAVIYO_CAMPAIGN_CHANNEL_FILTER);
    expect(KLAVIYO_CAMPAIGN_CHANNEL_FILTER).toBe('equals(messages.channel,"email")');
  });

  it("/api/events sends greater-or-equal(datetime,…) and includes the metric", async () => {
    // developers.klaviyo.com/en/reference/get_events —
    //   filter on `datetime` with all four operators (and `timestamp` as a
    //   number with the same four). The metric include is what carries the
    //   human-readable event name that becomes `type`.
    // Mutation: filter on `occurred_at`, or on `updated` → red.
    const { c, f } = connector({
      routes: [{ match: /\/api\/events/, responses: [{ body: page([]) }] }],
    });
    await c.listEvents({ since: "2026-08-01T00:00:00Z" });
    expect(f.params(0).get("filter")).toBe("greater-or-equal(datetime,2026-08-01T00:00:00Z)");
    expect(f.params(0).get("sort")).toBe("datetime");
    expect(f.params(0).get("include")).toBe(KLAVIYO_EVENT_METRIC_INCLUDE);
    expect(KLAVIYO_EVENT_METRIC_INCLUDE).toBe("metric");
  });

  it("/api/lists/{id}/profiles sends NO filter at all — membership has no delta", async () => {
    // developers.klaviyo.com/en/reference/get_list_profiles —
    //   the COMPLETE documented filter set is email, phone_number, push_token,
    //   _kx, joined_group_at. There is no `updated`, so an incremental read of
    //   membership is IMPOSSIBLE, not unimplemented. And joined_group_at is a
    //   JOIN time: it can find new members but can never see one who LEFT or
    //   whose consent changed — which is the half that matters for the one
    //   dataset whose purpose is not mailing somebody who opted out.
    // Mutation: add a `since` option that emits filter=greater-than(updated,…)
    // → red on the filter assertion, which is the whole point: the vendor would
    // have answered, and the scan would have been labelled a delta.
    const { c, f } = connector({
      routes: [
        { match: /\/api\/lists\/[^/?]+\/profiles/, responses: [{ body: page([profile("p1")]) }] },
      ],
    });
    await c.listMembers("l1");
    expect(f.params(0).get("filter")).toBeNull();
    expect(f.params(0).get("sort")).toBe("joined_group_at");
    expect(KLAVIYO_SCAN_MODE.audience_member).toBe("full_scan_only");
  });

  it("asks for subscriptions on membership — the free additional field, not the metered one", async () => {
    // `subscriptions` is reachable as fields[profile] OR additional-fields[profile]
    // and carries NO rate penalty; only `predictive_analytics` drops that
    // endpoint to 10/s + 150/m. `audience_member` exists for the consent state,
    // so this parameter is not optional in practice.
    // Mutation: request predictive_analytics as well → the tier changes and the
    // guide's cadence advice becomes wrong.
    const { c, f } = connector({
      routes: [
        { match: /\/api\/lists\/[^/?]+\/profiles/, responses: [{ body: page([profile("p1")]) }] },
      ],
    });
    await c.listMembers("l1");
    expect(f.params(0).get("additional-fields[profile]")).toBe("subscriptions");
    expect(f.urls()[0]).not.toContain("predictive_analytics");
  });

  it("refuses to BUILD a membership delta at all", () => {
    // Mutation: give audience_member a delta filter entry → red. There is no
    // honest one to give it.
    expect(() => klaviyoDeltaClause("audience_member", "2026-08-01T00:00:00Z")).toThrow(
      ConnectorBlockedError,
    );
    expect(KLAVIYO_DELTA_FILTERS.audience_member).toBeNull();
  });

  it("refuses an `updated` filter field on the membership endpoint", () => {
    // The guard, not the comment, is what stops the next engineer adding one.
    // Mutation: delete assertKlaviyoMemberFilterField's call site → red.
    expect(() => assertKlaviyoMemberFilterField("updated")).toThrow(ConnectorBlockedError);
    expect(() => assertKlaviyoMemberFilterField("updated_at")).toThrow(ConnectorBlockedError);
    for (const ok of KLAVIYO_LIST_PROFILES_FILTERS) {
      expect(() => assertKlaviyoMemberFilterField(ok)).not.toThrow();
    }
    expect([...KLAVIYO_LIST_PROFILES_FILTERS].sort()).toEqual([
      "_kx",
      "email",
      "joined_group_at",
      "phone_number",
      "push_token",
    ]);
  });

  it("pins each endpoint's COMPLETE documented operator set, which is not uniform", () => {
    // The table is what stops somebody copying the campaigns clause onto
    // profiles. Carrying the FULL set rather than only the operator we use is
    // the difference between "we happen to send greater-than" and
    // "greater-or-equal DOES NOT EXIST on this field".
    // Mutation: give `contact` the four-operator set → the next test goes green
    // and a greater-or-equal profile filter ships.
    expect(KLAVIYO_DELTA_FILTERS.contact?.operators).toEqual(["greater-than", "less-than"]);
    expect(KLAVIYO_DELTA_FILTERS.audience?.operators).toEqual(["greater-than"]);
    expect(KLAVIYO_DELTA_FILTERS.campaign?.field).toBe("updated_at");
    expect(KLAVIYO_DELTA_FILTERS.engagement?.field).toBe("datetime");
    expect(KLAVIYO_DELTA_FILTERS.contact?.field).toBe("updated");
    expect(KLAVIYO_DELTA_FILTERS.audience?.field).toBe("updated");
  });

  it("refuses the campaigns clause on profiles — both the operator and the field", () => {
    // The exact copy-paste this guard exists for.
    // Mutation: drop either half of assertKlaviyoDeltaClause → red.
    expect(() =>
      assertKlaviyoDeltaClause("contact", "greater-or-equal(updated,2026-08-01T00:00:00Z)"),
    ).toThrow(/not a documented operator/);
    expect(() =>
      assertKlaviyoDeltaClause("contact", "greater-than(updated_at,2026-08-01T00:00:00Z)"),
    ).toThrow(/not the delta field/);
    expect(() =>
      assertKlaviyoDeltaClause("audience", "less-than(updated,2026-08-01T00:00:00Z)"),
    ).toThrow(/not a documented operator/);
    expect(() => assertKlaviyoDeltaClause("contact", "updated > 2026")).toThrow(
      /not a Klaviyo filter expression/,
    );
    expect(() =>
      assertKlaviyoDeltaClause("campaign", "greater-or-equal(updated_at,2026-08-01T00:00:00Z)"),
    ).not.toThrow();
  });

  it("floors an instant to whole seconds, which is the SAFE direction", () => {
    // Klaviyo's documented filter examples are second-precision. Truncation
    // moves the bound EARLIER, so it can only ever re-read rows — never skip
    // them — under both greater-than and greater-or-equal.
    // Mutation: round instead of truncate → a millisecond-level watermark can
    // move FORWARD past rows that were never returned.
    expect(klaviyoInstant("2026-08-01T00:00:00.750Z")).toBe("2026-08-01T00:00:00Z");
    expect(klaviyoInstant(Date.UTC(2026, 7, 1, 0, 0, 0, 999))).toBe("2026-08-01T00:00:00Z");
    expect(klaviyoInstant("")).toBeUndefined();
    expect(klaviyoInstant("not a date")).toBeUndefined();
  });

  it("declares a scan mode for every dataset it serves", () => {
    // Declared, not inferred: a scheduler needs to know which datasets can only
    // be full-scanned so it can give them a slower cadence.
    // Mutation: drop audience_member from the table → red.
    expect(Object.keys(KLAVIYO_SCAN_MODE).sort()).toEqual([...KLAVIYO_DATASETS].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The profile_count trap
// ─────────────────────────────────────────────────────────────────────────────

describe("member_count: additional-fields[list] only exists on a SINGLE list", () => {
  it("refuses the parameter on the COLLECTION endpoint", () => {
    // developers.klaviyo.com/en/reference/get_lists — the complete query set is
    // fields[flow], fields[list], fields[tag], filter, include, page[cursor],
    // page[size], sort. There is no additional-fields[list].
    // developers.klaviyo.com/en/reference/get_list — this is where
    // profile_count lives, and where the 1/s + 15/m block lives.
    //
    // The damage is silent: JSON:API endpoints do not reliably 400 on an
    // unrecognised query parameter, so this would return lists with no counts
    // while the connector believed it had asked for them — leaving the REQUIRED
    // member_count column empty under a successful-looking read.
    // Mutation: attach the parameter to the collection read → red.
    expect(() => assertKlaviyoProfileCountPath(KLAVIYO_ENDPOINTS.lists.path)).toThrow(
      ConnectorBlockedError,
    );
    expect(() =>
      assertKlaviyoProfileCountPath(`${KLAVIYO_API_BASE_PATH}/lists/l1/profiles`),
    ).toThrow(ConnectorBlockedError);
    expect(() =>
      assertKlaviyoProfileCountPath(`${KLAVIYO_API_BASE_PATH}/lists/l1`),
    ).not.toThrow();
  });

  it("does the two-stage read: one collection page, then one request PER LIST", async () => {
    // 200 lists is 20 collection pages PLUS 200 individual reads at 15/m —
    // roughly fourteen minutes of wall clock for the counts alone, from a
    // bucket shared with the customer's other integrations. That is a cadence
    // decision, and it is only visible if the fan-out is asserted.
    // Mutation: collapse it into one collection call → red.
    const { c, f } = connector({
      routes: [
        {
          match: /\/api\/lists\/[^/?]+\?/,
          responses: [{ body: { data: singleList("l1", 11) } }, { body: { data: singleList("l2", 22) } }],
        },
        { match: /\/api\/lists/, responses: [{ body: page([list("l1"), list("l2")]) }] },
      ],
    });
    const rows = await c.listAudiences();
    expect(f.calls).toHaveLength(3);
    expect(f.paths()).toEqual([
      "/api/lists",
      "/api/lists/l1",
      "/api/lists/l2",
    ]);
    expect(f.params(1).get(KLAVIYO_PROFILE_COUNT_FIELD)).toBe(KLAVIYO_PROFILE_COUNT_VALUE);
    expect(f.params(0).get(KLAVIYO_PROFILE_COUNT_FIELD)).toBeNull();
    expect(rows.map((r) => r.profile_count)).toEqual([11, 22]);
  });

  it("leaves ONE refused list's count absent and still serves every other list", async () => {
    // The docstring calls the count BEST-EFFORT per list. It has to be TRUE, not
    // claimed: the singular read draws on the 1/s + 15/m bucket the customer's
    // other integrations share, so on an account with a couple of hundred lists
    // one 403 or one exhausted 429 would otherwise throw away the whole audience
    // read — including the counts that had already come back.
    // Mutation: drop the try/catch → red, and `get_audiences` returns NOTHING
    // rather than two lists out of three.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/lists\/[^/?]+\?/,
          responses: [
            { body: { data: singleList("l1", 11) } },
            { status: 403, body: { errors: [{ code: "not_authorized" }] } },
            { body: { data: singleList("l3", 33) } },
          ],
        },
        {
          match: /\/api\/lists/,
          responses: [{ body: page([list("l1"), list("l2"), list("l3")]) }],
        },
      ],
    });
    const rows = await c.listAudiences();
    expect(rows.map((r) => [r.id, r.profile_count])).toEqual([
      ["l1", 11],
      // Absent, not zero. Zero is a confident false statement about the size of
      // somebody's mailing list.
      ["l2", undefined],
      ["l3", 33],
    ]);
  });

  it("leaves an EXHAUSTED 429 absent too, after the documented retries", async () => {
    // A rate limit on the most expensive endpoint in the connector is the
    // likeliest single failure here, and it is per-list by nature.
    // Mutation: let KlaviyoRateLimitedError escape the loop → the whole read
    // fails because one list was busy.
    const sleeps: number[] = [];
    const { c } = connector({
      sleeps,
      routes: [
        {
          match: /\/api\/lists\/[^/?]+\?/,
          responses: [{ status: 429, headers: { "Retry-After": "1" }, body: {} }],
        },
        { match: /\/api\/lists/, responses: [{ body: page([list("l1")]) }] },
      ],
    });
    const rows = await c.listAudiences();
    expect(rows.map((r) => [r.id, r.profile_count])).toEqual([["l1", undefined]]);
    // It really did back off the documented number of times before giving up on
    // that one count — this is a swallowed exhaustion, not a skipped request.
    expect(sleeps).toHaveLength(KLAVIYO_MAX_RETRIES);
  });

  it("does NOT swallow a 401 mid-fan-out — a dead key is not an absent count", async () => {
    // The catch is scoped to faults about ONE LIST. A 401 is a fact about the
    // CONNECTION: swallowing it would fire one more doomed request per remaining
    // list and then hand back a full set of lists with every count missing — a
    // dead connection wearing a successful read's shape.
    // Mutation: `catch { count = undefined }` with no class check → red here,
    // and red on the call count, which is where the extra doomed requests show.
    const { c, f } = connector({
      routes: [
        {
          match: /\/api\/lists\/[^/?]+\?/,
          responses: [
            { body: { data: singleList("l1", 11) } },
            { status: 401, body: { errors: [{ code: "not_authenticated" }] } },
          ],
        },
        {
          match: /\/api\/lists/,
          responses: [{ body: page([list("l1"), list("l2"), list("l3")]) }],
        },
      ],
    });
    await expect(c.listAudiences()).rejects.toBeInstanceOf(KlaviyoReauthorizationRequiredError);
    // The collection page, l1, and the l2 read that failed. l3 was never dialled.
    expect(f.paths()).toEqual(["/api/lists", "/api/lists/l1", "/api/lists/l2"]);
  });

  it("prices the singular list read at 50x the collection's, in the rate table", () => {
    // Mutation: copy the collection tier onto the singular entry → red, and a
    // scheduler sized from this table would 429 the customer's whole account.
    expect(KLAVIYO_RATE_LIMITS.lists).toEqual({ burstPerSecond: 75, steadyPerMinute: 750 });
    expect(KLAVIYO_RATE_LIMITS.list).toEqual({ burstPerSecond: 1, steadyPerMinute: 15 });
    expect(KLAVIYO_ENDPOINTS.lists.maxPageSize).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

describe("cursor pagination", () => {
  it("takes page[cursor] OPAQUELY from links.next and stops when it is absent", async () => {
    // Klaviyo cursors are opaque. A client that constructs one reads the wrong
    // page silently. And `links.next` absent is the ONLY termination signal a
    // cursor API offers.
    // Mutation: derive the cursor from an offset, or keep paging while `data`
    // is a full page → red.
    const cursor = "WzE2OTk5OTk5OTksIjAxSCJd";
    const { c, f } = connector({
      routes: [
        {
          match: /\/api\/profiles/,
          responses: [
            {
              body: {
                data: [profile("p1")],
                links: {
                  next: `${KLAVIYO_API_BASE_URL}/api/profiles?page%5Bcursor%5D=${cursor}`,
                },
              },
            },
            { body: page([profile("p2")]) },
          ],
        },
      ],
    });
    const result = await c.listProfiles();
    expect(f.calls).toHaveLength(2);
    expect(f.params(0).get(KLAVIYO_CURSOR_PARAM)).toBeNull();
    expect(f.params(1).get(KLAVIYO_CURSOR_PARAM)).toBe(cursor);
    expect(result.rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(result.complete).toBe(true);
  });

  it("sends each endpoint's own page[size] ceiling — they differ sharply", async () => {
    // Verified ceilings: profiles 100, lists 10 (the tightest in the API),
    // list-profiles 100, campaigns 100, events 1000.
    // Mutation: use one shared page size → red on whichever endpoint it is not.
    const { c: c1, f: f1 } = connector({
      routes: [{ match: /\/api\/profiles/, responses: [{ body: page([]) }] }],
    });
    await c1.listProfiles();
    expect(f1.params(0).get(KLAVIYO_PAGE_SIZE_PARAM)).toBe("100");

    const { c: c2, f: f2 } = connector({
      routes: [{ match: /\/api\/events/, responses: [{ body: page([]) }] }],
    });
    await c2.listEvents();
    expect(f2.params(0).get(KLAVIYO_PAGE_SIZE_PARAM)).toBe("1000");

    const { c: c3, f: f3 } = connector({
      routes: [
        { match: /\/api\/lists\/[^/?]+\/profiles/, responses: [{ body: page([]) }] },
      ],
    });
    await c3.listMembers("l1");
    expect(f3.params(0).get(KLAVIYO_PAGE_SIZE_PARAM)).toBe("100");

    expect(KLAVIYO_ENDPOINTS.campaigns.maxPageSize).toBe(100);
  });

  it("sends NO page[size] to /api/metrics, which has no such parameter", async () => {
    // developers.klaviyo.com/en/reference/get_metrics — cursor only; the
    // endpoint "returns a maximum of 200 results per page" and exposes no
    // page[size] at all. Sending one would be a parameter the endpoint ignores.
    // Mutation: give metrics a non-zero maxPageSize → red.
    const { c, f } = connector({
      routes: [{ match: /\/api\/metrics/, responses: [{ body: page([]) }] }],
    });
    await c.probePlanAccess();
    expect(f.params(0).get(KLAVIYO_PAGE_SIZE_PARAM)).toBeNull();
    expect(KLAVIYO_ENDPOINTS.metrics.maxPageSize).toBe(0);
  });

  it("refuses a response whose `data` is not an array rather than guessing a shape", async () => {
    // Mutation: coerce a non-array into [] → the read reports success and lands
    // nothing, which is exactly the confidently-empty answer ADR-041 forbids.
    const { c } = connector({
      routes: [{ match: /\/api\/profiles/, responses: [{ body: { data: { id: "p1" } } }] }],
    });
    await expect(c.listProfiles()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("REFUSES to advance a watermark from an interrupted walk", () => {
    // THE boundary rule, and the reason it is enforced by a signature rather
    // than a comment. Profiles and lists offer only STRICT greater-than, so a
    // watermark advanced from a partial walk permanently skips every row
    // sharing that exact `updated` value which had not yet been returned —
    // a silent hole, not an error.
    // Mutation: drop the `complete` parameter and always return the max → red.
    const rows = [{ updated: "2026-08-01T00:00:00Z" }, { updated: "2026-08-03T00:00:00Z" }];
    expect(klaviyoWatermark(rows, "updated", true)).toBe("2026-08-03T00:00:00Z");
    expect(klaviyoWatermark(rows, "updated", false)).toBeUndefined();
    expect(klaviyoWatermark([], "updated", true)).toBeUndefined();
  });

  it("RETURNS the watermark to the caller rather than persisting it", async () => {
    // ADR-041 §4 / WARP-2028: this track writes nothing, so it does not become
    // the first writer of a model whose encryption promise is not yet kept.
    // Mutation: store the watermark on the connector → there is nowhere for it
    // to appear in the returned page, and this goes red.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/profiles/,
          responses: [
            {
              body: page([
                profile("p1", { updated: "2026-08-01T00:00:00Z" }),
                profile("p2", { updated: "2026-08-09T00:00:00Z" }),
              ]),
            },
          ],
        },
      ],
    });
    const result = await c.listProfiles();
    expect(result.watermark).toBe("2026-08-09T00:00:00Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical projection
// ─────────────────────────────────────────────────────────────────────────────

describe("canonical projection", () => {
  it("projects EXACTLY the canonical columns and leaks no vendor field", async () => {
    // A Klaviyo profile carries a location guess, an IP, the whole custom
    // property bag and — on some accounts — a predictive lifetime-value model.
    // A mapper written as `{ ...profile, … }` persists all of it on the box.
    // Mutation: spread the vendor record onto the row → red.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/profiles/,
          responses: [
            {
              body: page([
                profile("p1", {
                  first_name: "Ada",
                  last_name: "Lovelace",
                  organization: "Analytical Engines",
                  created: "2026-01-02T03:04:05Z",
                  updated: "2026-08-09T00:00:00Z",
                  location: { ip: "203.0.113.9", city: "London" },
                  properties: { favourite_colour: "green" },
                  predictive_analytics: { predicted_clv: 1234.5 },
                }),
              ]),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("find_contact", { query: "love" })) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.contact].sort());
    expect(rows[0].contact_id).toBe("p1");
    expect(rows[0].last_name).toBe("Lovelace");
    expect(rows[0].email).toBe("p1@example.test");
    expect(rows[0].updated_at).toBe("2026-08-09T00:00:00.000Z");
    // No Klaviyo equivalent: mapping `organization` onto `company_id` would
    // invent a foreign key into a company table Klaviyo does not have.
    expect(rows[0].company_id).toBeUndefined();
    expect(rows[0].lifecycle_stage).toBeUndefined();
    expect(JSON.stringify(rows[0])).not.toContain("203.0.113.9");
    expect(JSON.stringify(rows[0])).not.toContain("predicted_clv");
  });

  it("satisfies REQUIRED_CANONICAL for contact — last_name really is on the object", () => {
    // This is what distinguishes Klaviyo from the Mailchimp refusal recorded in
    // export-drop/profiles.ts: `find_contact` is a LAST-NAME PREFIX search, a
    // Mailchimp member has no name at all, and a Klaviyo profile does.
    // Mutation: declare `audience_member` for profiles instead → the prefix
    // search resolves against a schema map with no last_name column.
    expect(REQUIRED_CANONICAL.contact).toEqual(["contact_id"]);
    expect(CANONICAL_COLUMNS.contact).toContain("last_name");
    expect(KLAVIYO_DATASETS).toContain("contact");
  });

  it("maps consent out of subscriptions.email.marketing — the reason the row exists", async () => {
    // Mailing somebody who unsubscribed is the one unrecoverable mistake this
    // dataset can cause, so `subscription_status` is REQUIRED and `opted_in_at`
    // is consent evidence kept separate from `updated_at`.
    // Mutation: read `record.status` (which is what a campaign has) → red.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/lists\/[^/?]+\/profiles/,
          responses: [
            {
              body: page([
                profile("m1", {
                  updated: "2026-08-02T00:00:00Z",
                  subscriptions: {
                    email: {
                      marketing: {
                        consent: "SUBSCRIBED",
                        consent_timestamp: "2026-02-03T04:05:06Z",
                      },
                    },
                  },
                }),
              ]),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_audience_members", {
      audienceId: "l1",
    })) as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.audience_member].sort());
    expect(rows[0].subscription_status).toBe("SUBSCRIBED");
    expect(rows[0].opted_in_at).toBe("2026-02-03T04:05:06.000Z");
    // The id the read was SCOPED BY, never one off the payload: a profile does
    // not know which list it was fetched through.
    expect(rows[0].audience_id).toBe("l1");
  });

  it("takes the engagement `type` from the INCLUDED metric, and leaves updated_at absent", async () => {
    // A Klaviyo event is immutable, so there is no modification time to lose.
    // Backfilling `updated_at` from `occurred_at` would make a watermark
    // comparison look meaningful when it is not.
    // Mutation: set updated_at = datetime → red.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/events/,
          responses: [
            {
              body: page(
                [
                  {
                    type: "event",
                    id: "e1",
                    attributes: { datetime: "2026-08-05T09:00:00Z" },
                    relationships: {
                      profile: { data: { type: "profile", id: "p9" } },
                      metric: { data: { type: "metric", id: "m9" } },
                    },
                  },
                ],
                undefined,
                [{ type: "metric", id: "m9", attributes: { name: "Opened Email" } }],
              ),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_engagements", {})) as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.engagement].sort());
    expect(rows[0].engagement_id).toBe("e1");
    expect(rows[0].type).toBe("Opened Email");
    expect(rows[0].contact_id).toBe("p9");
    expect(rows[0].occurred_at).toBe("2026-08-05T09:00:00.000Z");
    expect(rows[0].updated_at).toBeUndefined();
    // No pipeline model in Klaviyo, so no deal to point at.
    expect(rows[0].deal_id).toBeUndefined();
  });

  it("takes campaign.subject from the INCLUDED campaign-message, never from attributes", async () => {
    // developers.klaviyo.com/en/reference/get_campaigns — a campaign resource
    // carries NO subject. The recipient-visible line lives on the campaign's
    // MESSAGE at definition.content.subject, which is the entire reason
    // `include=campaign-messages` is paid for on every campaigns request.
    // Mutation: read `attributes.subject` — a key the vendor never sends → red.
    // Before this test existed the fixture fabricated that key, so the mutation
    // WAS the shipped code and the whole suite stayed green while every
    // campaign the box ever showed had a blank subject.
    const { c } = connector({
      conversionMetricId: "MetricABC",
      routes: [
        reportRoute([
          {
            groupings: { campaign_id: "c1", send_channel: "email" },
            statistics: { recipients: 900, opens_unique: 300, clicks_unique: 40 },
          },
        ]),
        {
          match: /\/api\/campaigns/,
          responses: [
            {
              body: page([campaign("c1")], undefined, [
                campaignMessage("c1", "August newsletter"),
              ]),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_campaign_performance", {})) as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.campaign].sort());
    expect(rows[0].subject).toBe("August newsletter");
    expect(rows[0].campaign_id).toBe("c1");
    expect(rows[0].status).toBe("Sent");
    expect(rows[0].sent_at).toBe("2026-08-10T12:00:00.000Z");
    expect(rows[0].emails_sent).toBe(900);
  });

  it("joins each campaign to ITS OWN message, never to the first one in `included`", async () => {
    // `included` is a FLAT bag of every sideloaded resource across the whole
    // page, in no guaranteed order. Resolving it by position — or by "the first
    // campaign-message in the array" — attaches one customer's subject line to
    // another campaign's row, which is worse than a blank column because it
    // looks right.
    // Mutation: `subjects.values().next()` instead of the relationship walk →
    // red, because the messages here arrive in the opposite order to the rows.
    const { c } = connector({
      conversionMetricId: "MetricABC",
      routes: [
        reportRoute([]),
        {
          match: /\/api\/campaigns/,
          responses: [
            {
              body: page([campaign("c1"), campaign("c2")], undefined, [
                campaignMessage("c2", "Second campaign's subject"),
                campaignMessage("c1", "First campaign's subject"),
              ]),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_campaign_performance", {})) as Record<string, unknown>[];
    expect(rows.map((r) => [r.campaign_id, r.subject])).toEqual([
      ["c1", "First campaign's subject"],
      ["c2", "Second campaign's subject"],
    ]);
  });

  it("takes campaign.audience_id from attributes.audiences.included — never `excluded`", async () => {
    // The lists a send went to arrive as `attributes.audiences =
    // { included: [...], excluded: [...] }`. There is no `list_id` anywhere on
    // a campaign, so a lookup that falls through to `record.list_id` leaves the
    // column undefined on every row and no campaign can ever be joined to the
    // list it went to.
    // Mutation: read `audiences.excluded` → red, and the row claims a send
    // reached the one audience it was deliberately kept away from.
    const { c } = connector({
      conversionMetricId: "MetricABC",
      routes: [
        reportRoute([]),
        {
          match: /\/api\/campaigns/,
          responses: [
            {
              body: page(
                [
                  campaign("c1", {
                    audiences: { included: ["Lg7QpX", "SecondList"], excluded: ["NeverThis"] },
                  }),
                ],
                undefined,
                [campaignMessage("c1", "August newsletter")],
              ),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_campaign_performance", {})) as Record<string, unknown>[];
    // FIRST included audience: the canonical column is singular, and a campaign
    // joinable to one of its two lists beats one joinable to none.
    expect(rows[0].audience_id).toBe("Lg7QpX");
    expect(JSON.stringify(rows[0])).not.toContain("NeverThis");
  });

  it("refuses a 200 that carries campaigns and NO `included` — rather than blanking every subject", async () => {
    // The `GET /api/files` lesson: that endpoint answered `200 []` through an
    // outage and every consumer read it as "there are no files". A collection
    // key ABSENT from an otherwise-successful body is a FAULT, and here it is
    // indistinguishable downstream from "these campaigns have no subject".
    // Mutation: drop the envelope check → green, and a retired include member
    // or a scope that silently drops sideloads ships blank subjects forever.
    const { c } = connector({
      conversionMetricId: "MetricABC",
      routes: [
        reportRoute([]),
        {
          match: /\/api\/campaigns/,
          responses: [{ body: page([campaign("c1"), campaign("c2")]) }],
        },
      ],
    });
    await expect(c.listCampaigns()).rejects.toBeInstanceOf(ConnectorBlockedError);
    // An EMPTY page is exempt: no rows means nothing to sideload, and JSON:API
    // does not require an empty `included`.
    const { c: c2 } = connector({
      routes: [{ match: /\/api\/campaigns/, responses: [{ body: page([]) }] }],
    });
    await expect(c2.listCampaigns()).resolves.toEqual([]);
  });

  it("refuses a 200 that carries events and NO `included` — rather than blanking every type", async () => {
    // `include=metric` is flagged UNVERIFIED in the connector: the relationship
    // is documented, the enum member `include` accepts was not confirmed
    // against a live account. What makes an unverified literal supportable is
    // that it fails LOUDLY — this is the highest-volume dataset in the track,
    // and a wrong member would otherwise leave `type` undefined on every row.
    // Mutation: drop the envelope check → green and silent.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/events/,
          responses: [
            {
              body: page([
                { type: "event", id: "e1", attributes: { datetime: "2026-08-05T09:00:00Z" } },
              ]),
            },
          ],
        },
      ],
    });
    await expect(c.listEvents()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("leaves an absent count ABSENT, never zero", async () => {
    // Zero members is a confident false statement about the size of somebody's
    // mailing list; absent is the truth when the detail read gave nothing back.
    // Mutation: `?? 0` on profile_count → red.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/lists\/[^/?]+\?/,
          responses: [{ body: { data: { type: "list", id: "l1", attributes: { name: "News" } } } }],
        },
        { match: /\/api\/lists/, responses: [{ body: page([list("l1")]) }] },
      ],
    });
    const rows = (await c.runRead("get_audiences", {})) as Record<string, unknown>[];
    expect(rows[0].member_count).toBeUndefined();
    // Klaviyo publishes no unsubscribe total on a list, so this stays honestly
    // absent rather than being reconstructed by subtraction.
    expect(rows[0].unsubscribe_count).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Money — there is none here, and that is enforced rather than remembered
// ─────────────────────────────────────────────────────────────────────────────

describe("money and counts", () => {
  it("serves NO money column on any dataset, and fails at module load if that changes", () => {
    // Every number in these five is a COUNT. `ecommerce_order` was declined
    // deliberately: a Klaviyo "Placed Order" event is an untyped property bag
    // with no guaranteed currency, and REQUIRED_CANONICAL demands total_amount
    // AND currency — inferring them would be guessing at a schema.
    //
    // The startup assertion is the part that survives a future edit: the day
    // somebody adds a money-carrying dataset here, the connector refuses to
    // load until they have written the major-units conversion at this boundary
    // and given the amount an explicit sibling currency.
    // Mutation: delete the assertion's call site → this stays green, so the
    // NEXT test (that it actually throws) is the one that bites.
    for (const dataset of KLAVIYO_DATASETS) {
      for (const column of CANONICAL_COLUMNS[dataset]) {
        expect(COLUMN_KIND[column]).not.toBe("money");
      }
    }
    expect(() => assertKlaviyoDatasetsCarryNoMoney()).not.toThrow();
  });

  it("names the major-units rule in the failure it would raise", () => {
    // The guard's message is the documentation somebody actually reads — at the
    // moment they break it. Mutation: soften it to "money not allowed" → red.
    const src = klaviyoSource();
    expect(src).toContain("MAJOR units (12.34, never");
    expect(src).toContain("explicit sibling currency");
  });

  it("counts project as NUMBERS through the `count` kind, never as money strings", () => {
    // profiles.ts declares `count` separately from `money` precisely because a
    // money column must carry a sibling currency and a count must not:
    // declaring member_count as money would compile, parse correctly, and then
    // demand a currency for a number of people.
    // Mutation: file emails_sent as money → assertMoneyColumnsCarryCurrency
    // starts demanding a currency column `campaign` does not have.
    expect(COLUMN_KIND.emails_sent).toBe("count");
    expect(COLUMN_KIND.opens_unique).toBe("count");
    expect(COLUMN_KIND.clicks_unique).toBe("count");
    expect(COLUMN_KIND.member_count).toBe("count");
    const row = projectCanonicalRow(
      "campaign",
      klaviyoLookup("campaign", {
        id: "c1",
        recipients: 1234,
        opens_unique: 56,
        clicks_unique: 7,
      }),
    );
    expect(row.emails_sent).toBe(1234);
    expect(row.opens_unique).toBe(56);
    expect(typeof row.emails_sent).toBe("number");
    expect("currency" in row).toBe(false);
  });

  it("never projects a Klaviyo money-shaped value onto a canonical row", async () => {
    // `$value` on an event and `conversion_value` on a report are money-shaped
    // and are deliberately not carried: there is no guaranteed currency beside
    // either of them, and money whose currency has to be guessed is not a
    // number.
    // Mutation: map `$value` onto anything → red, because no canonical column
    // in these five datasets could receive it without also carrying a currency.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/events/,
          responses: [
            {
              body: page(
                [
                  {
                    type: "event",
                    id: "e1",
                    attributes: {
                      datetime: "2026-08-05T09:00:00Z",
                      event_properties: { $value: 99.99, currency: "GBP" },
                    },
                    relationships: { metric: { data: { type: "metric", id: "m9" } } },
                  },
                ],
                undefined,
                [{ type: "metric", id: "m9", attributes: { name: "Placed Order" } }],
              ),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_engagements", {})) as Record<string, unknown>[];
    expect(JSON.stringify(rows[0])).not.toContain("99.99");
    expect(JSON.stringify(rows[0])).not.toContain("GBP");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vendor errors — the CODE, never the message
// ─────────────────────────────────────────────────────────────────────────────

describe("vendor errors", () => {
  it("surfaces the vendor's CODE and status, never its `detail`", async () => {
    // Klaviyo's JSON:API errors carry a `detail` that quotes the request back —
    // the filter expression, the field, the offending value — and that state
    // can contain customer data. It is dropped rather than carried into a
    // message that gets logged.
    // Mutation: use `detail ?? title` the way the Mailchimp track does for its
    // own vendor → red, and a customer's email address lands in the log.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/profiles/,
          responses: [
            {
              status: 400,
              body: {
                errors: [
                  {
                    id: "b1",
                    code: "invalid_filter",
                    title: "Invalid filter",
                    detail:
                      'Invalid filter for profile "ada@example.test": greater-or-equal(updated,…)',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    try {
      await c.listProfiles();
      throw new Error("expected a rejection");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("invalid_filter");
      expect(message).toContain("400");
      expect(message).not.toContain("ada@example.test");
      expect(message).not.toContain("Invalid filter for profile");
    }
  });

  it("turns 401 into a named reauthorize state", async () => {
    // Retrying cannot fix a deleted key, and Klaviyo will never redisplay one —
    // so the remedy is "create a new key", not "wait".
    // Mutation: fold 401 into the generic blocked error → red.
    const { c } = connector({
      routes: [{ match: /\/api\/metrics/, responses: [{ status: 401, body: {} }] }],
    });
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(KlaviyoReauthorizationRequiredError);
  });

  it("turns 403 into CAPABILITY_MISSING carrying the vendor code — never an empty list", async () => {
    // ADR-041's never-empty contract matters more here than usual: "no
    // contacts" is a plausible-looking answer for a small business and is
    // unfalsifiable from the outside. And Klaviyo cannot EDIT a key's scope, so
    // the remedy is delete-and-recreate, which is why this is not a reauth.
    // Mutation: return [] on a 403 → red.
    const { c } = connector({
      routes: [
        {
          match: /\/api\/metrics/,
          responses: [{ status: 403, body: { errors: [{ code: "not_authorized" }] } }],
        },
      ],
    });
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(KlaviyoCapabilityMissingError);
    try {
      await c.probePlanAccess();
    } catch (err) {
      expect((err as KlaviyoCapabilityMissingError).vendorCode).toBe("not_authorized");
      expect((err as KlaviyoCapabilityMissingError).status).toBe(403);
    }
    const status = await c.status();
    expect(status.state).toBe("capability_missing");
    expect(status.planProbe.state).toBe("forbidden");
  });

  it("turns 410 into REVISION_RETIRED — reachable ONLY because of the opt-out header", async () => {
    // Without the fall-forward opt-out this failure does not exist as an error
    // at all: Klaviyo would answer 200 with the next oldest revision's
    // behaviour, and the box would drift silently for months.
    // Mutation: drop the opt-out header → the vendor stops sending 410 and this
    // whole state becomes unreachable.
    const { c } = connector({
      routes: [{ match: /\/api\/metrics/, responses: [{ status: 410, body: {} }] }],
    });
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(KlaviyoRevisionRetiredError);
  });

  it("retries a 429 on the vendor's own Retry-After, then reports it", async () => {
    // Klaviyo meters per ACCOUNT, not per key, so this bucket is shared with
    // the customer's other integrations — a 429 is not proof of a bug on our
    // side. Its guidance is exponential backoff WITH randomness; the jitter is
    // added UPWARD from the vendor's figure, never subtracted, because retrying
    // earlier than we were asked to turns one 429 into several.
    // Mutation: subtract jitter, or ignore Retry-After → red on the sleep list.
    const sleeps: number[] = [];
    const { c } = connector({
      sleeps,
      routes: [
        {
          match: /\/api\/metrics/,
          responses: [{ status: 429, headers: { "Retry-After": "7" }, body: {} }],
        },
      ],
    });
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(KlaviyoRateLimitedError);
    expect(sleeps).toEqual([7000, 7000, 7000]);
    expect(sleeps).toHaveLength(KLAVIYO_MAX_RETRIES);
  });

  it("recovers when the retry succeeds", async () => {
    // Mutation: throw on the first 429 instead of retrying → red, and every
    // busy customer account looks broken.
    const { c, f } = connector({
      routes: [
        {
          match: /\/api\/metrics/,
          responses: [{ status: 429, headers: { "Retry-After": "1" }, body: {} }, { body: page([]) }],
        },
      ],
    });
    const probe = await c.probePlanAccess();
    expect(probe.state).toBe("ok");
    expect(f.calls).toHaveLength(2);
  });

  it("caps an absurd Retry-After rather than wedging a worker", async () => {
    // Mutation: honour the header verbatim → a mistaken or hostile 86400 parks
    // a worker for a day.
    const sleeps: number[] = [];
    const { c } = connector({
      sleeps,
      routes: [
        {
          match: /\/api\/metrics/,
          responses: [{ status: 429, headers: { "Retry-After": "86400" }, body: {} }],
        },
      ],
    });
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(KlaviyoRateLimitedError);
    expect(sleeps.every((ms) => ms <= 60_000)).toBe(true);
  });

  it("surfaces a stalled request as a TIMEOUT, never as an empty result", async () => {
    // An empty result here would read as "nothing to sync" when the truth is
    // that nothing was read. The deadline is OURS — Klaviyo documents no
    // per-request timeout — and it is raced against our own timer so it holds
    // even when the fetch implementation ignores the abort signal.
    // Mutation: rely on `signal` alone → red under a fetch that ignores it.
    const c = new KlaviyoConnector(
      { credentialsSecretRef: "s", connectionId: "c" },
      {
        fetchImpl: () => new Promise<Response>(() => {}),
        now: () => NOW,
        timeoutMs: 5,
        resolveApiKey: async () => KEY,
      },
    );
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(KlaviyoTimeoutError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read-only
// ─────────────────────────────────────────────────────────────────────────────

describe("read-only posture", () => {
  it("refuses applyWrite outright", async () => {
    // Not "later" — not in this connector. Sending a campaign is irreversible
    // and externally visible to every contact a business has.
    // Mutation: implement any write path → red.
    // A REGISTERED command name, so the refusal is the track's own and not an
    // UnknownWriteCommandError that would pass this test for the wrong reason.
    const { c, f } = connector();
    await expect(
      c.applyWrite("reschedule_appointment", { appt_id: "a1", appt_time: "2026-09-04T09:00:00Z" }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("allows POST to the report path ONLY, and no other verb anywhere", () => {
    // The report is a QUERY Klaviyo happens to shape as a POST. "It's really a
    // read" is a claim, so the verb is checked against a one-element set before
    // a request is built.
    // Mutation: allow POST wherever the resource allowlist allows → red.
    expect([...KLAVIYO_POST_QUERY_PATHS]).toEqual([`${KLAVIYO_API_BASE_PATH}/campaign-values-reports`]);
    expect(() =>
      assertKlaviyoMethod("POST", `${KLAVIYO_API_BASE_PATH}/campaign-values-reports`),
    ).not.toThrow();
    expect(() => assertKlaviyoMethod("GET", `${KLAVIYO_API_BASE_PATH}/profiles`)).not.toThrow();
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => assertKlaviyoMethod(verb, `${KLAVIYO_API_BASE_PATH}/profiles`)).toThrow(
        ConnectorBlockedError,
      );
    }
    expect(() =>
      assertKlaviyoMethod("DELETE", `${KLAVIYO_API_BASE_PATH}/campaign-values-reports`),
    ).toThrow(ConnectorBlockedError);
  });

  it("carries no send, subscribe, suppress or import path anywhere in the directory", () => {
    // "We didn't build it" is not enforceable; a red build is. The check is on
    // the SOURCE rather than on behaviour because a mutation surface added in a
    // helper would never be reached by a behavioural test until it shipped.
    //
    // EVERY needle is paired with a POSITIVE CONTROL: a hand-written line of the
    // code that would introduce it, transcribed in full rather than composed
    // from the needle. That pairing is not decoration — this test previously
    // built its needles as `${KLAVIYO_API_BASE_PATH}/${forbidden}` over a list
    // that already contained absolute paths, so two of the six searched for
    // "/api//api/templates", a string that can never occur in any source. Two
    // more used shortened resource names ("subscription-bulk-create") that are
    // not substrings of the real endpoints. Four of the six checks were
    // unfailable; only campaign-send-jobs and profile-import-jobs were live.
    //
    // Mutation: shorten, double-prefix or misspell any needle → red on its own
    // control, BEFORE it can pass vacuously against the real source.
    const FORBIDDEN: readonly [needle: string, wouldIntroduce: string][] = [
      [`${KLAVIYO_API_BASE_PATH}/campaign-send-jobs`, 'path: "/api/campaign-send-jobs",'],
      [`${KLAVIYO_API_BASE_PATH}/profile-import-jobs`, 'path: "/api/profile-import-jobs",'],
      [
        `${KLAVIYO_API_BASE_PATH}/profile-subscription-bulk-create-jobs`,
        'path: "/api/profile-subscription-bulk-create-jobs",',
      ],
      [
        `${KLAVIYO_API_BASE_PATH}/profile-suppression-bulk-create-jobs`,
        'path: "/api/profile-suppression-bulk-create-jobs",',
      ],
      [`${KLAVIYO_API_BASE_PATH}/templates`, 'const p = `/api/templates/${id}`;'],
      [`${KLAVIYO_API_BASE_PATH}/flows`, 'const p = `/api/flows/${id}`;'],
    ];
    const sources = klaviyoSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const [needle, wouldIntroduce] of FORBIDDEN) {
      // The needle can actually match something. Without this half the loop
      // below is six assertions that cannot fail.
      expect(wouldIntroduce).toContain(needle);
      // Named in the negative-space comment and in KLAVIYO_READABLE_RESOURCES'
      // docstring as prose — neither builds a path, so the assertion is that no
      // PATH contains them.
      for (const src of sources) expect(src).not.toContain(needle);
    }
    // ...and the resource allowlist, which is the control this test is only the
    // belt for, still names exactly the six readable resources.
    expect([...KLAVIYO_READABLE_RESOURCES].sort()).toEqual([
      "campaign-values-reports",
      "campaigns",
      "events",
      "lists",
      "metrics",
      "profiles",
    ]);
    for (const [needle] of FORBIDDEN) {
      const resource = needle.slice(`${KLAVIYO_API_BASE_PATH}/`.length);
      expect(KLAVIYO_READABLE_RESOURCES.has(resource)).toBe(false);
      expect(() => assertReadableKlaviyoResource(needle)).toThrow(ConnectorBlockedError);
    }
  });

  it("keeps its own source free of raw control bytes — the escape is written, never embedded", () => {
    // A literal 0x00 sat in the control-character fixture below, and the damage
    // was to everything that reads this file rather than to anything it tests:
    // file(1) called the suite `data`, grep and ripgrep called it "Binary file
    // … matches" and printed nothing, so every repo-wide search without -a
    // silently skipped it. GitHub renders a 0x00 as a SPACE, so a reviewer
    // reading the diff saw "pk_abc def" and could not tell it from the real
    // space case on the line above.
    // Mutation: paste a raw control byte into a fixture instead of escaping it
    // → red, with the byte offset that names it.
    const files = [fileURLToPath(import.meta.url), join(KLAVIYO_DIR, "connector.ts")];
    for (const file of files) {
      const bytes = readFileSync(file);
      const offending: string[] = [];
      for (let i = 0; i < bytes.length; i += 1) {
        const b = bytes[i];
        // Tab, LF and CR are the only C0 bytes source may carry literally.
        if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
          offending.push(`${file}@${i}=0x${b.toString(16).padStart(2, "0")}`);
        }
      }
      expect(offending).toEqual([]);
    }
    // ...and the escaped form still denotes the byte the guard must refuse, so
    // the fix did not quietly weaken the fixture it came from.
    expect("pk_abc\u0000def".charCodeAt(6)).toBe(0);
    expect(() => parseKlaviyoApiKey("pk_abc\u0000def")).toThrow(InvalidKlaviyoCredentialError);
  });

  it("refuses a read whose dataset this track does not serve", async () => {
    // Asking a marketing track for a vendor bill is not a connection fault and
    // must not be reported as one.
    // Mutation: drop the assertDatasetsServed call → the read attempts I/O and
    // fails with something that reads like a broken connection.
    const { c, f } = connector();
    await expect(c.runRead("get_open_bills", {})).rejects.toBeInstanceOf(DatasetNotServedError);
    expect(f.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The campaign report and its DAILY budget
// ─────────────────────────────────────────────────────────────────────────────

describe("campaign values report", () => {
  it("refuses the campaign dataset with no conversion metric id — on zero fetch calls", async () => {
    // developers.klaviyo.com/en/reference/query_campaign_values —
    //   conversion_metric_id is in the schema's required array
    //   ["statistics","timeframe","conversion_metric_id"].
    // And emails_sent is REQUIRED for `campaign`, so serving the dataset with
    // an empty count would be a campaign row that cannot answer the only
    // question anyone asks of it.
    // Mutation: omit conversion_metric_id and send the report anyway → the
    // vendor rejects it and a daily-budget call is burned for nothing.
    const { c, f } = connector({
      routes: [{ match: /\/api\/campaigns/, responses: [{ body: page([campaign("c1")]) }] }],
    });
    await expect(c.campaignValues()).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("asks for the counts ONCE per read, grouped by campaign — never once per campaign", async () => {
    // 225 calls a DAY for the whole account. A per-campaign loop exhausts that
    // on an account with a few hundred sends, and a daily cap is not something
    // you back off from.
    // Mutation: call the report inside the campaign loop → red on the call
    // count, which is the only place the difference is visible.
    const { c, f } = connector({
      conversionMetricId: "MetricABC",
      routes: [
        reportRoute([
          {
            groupings: { campaign_id: "c1", send_channel: "email" },
            statistics: { recipients: 900, opens_unique: 300, clicks_unique: 40 },
          },
          {
            groupings: { campaign_id: "c2", send_channel: "email" },
            statistics: { recipients: 12, opens_unique: 3, clicks_unique: 0 },
          },
        ]),
        {
          match: /\/api\/campaigns/,
          responses: [
            {
              body: page([campaign("c1"), campaign("c2")], undefined, [
                campaignMessage("c1", "August newsletter"),
                campaignMessage("c2", "September newsletter"),
              ]),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_campaign_performance", {})) as Record<string, unknown>[];
    expect(f.paths().filter((p) => p.includes("campaign-values-reports"))).toHaveLength(1);
    expect(f.method(1)).toBe("POST");
    const body = f.body(1);
    const attributes = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
    expect(attributes.statistics).toEqual([...KLAVIYO_REPORT_STATISTICS]);
    expect(attributes.conversion_metric_id).toBe("MetricABC");
    expect(attributes.timeframe).toEqual({ key: "last_12_months" });
    // Counts, joined onto the right campaign, and the ENGAGEMENT figures are
    // the unique ones — a raw open total makes an open rate exceed 100%.
    expect(rows.map((r) => [r.campaign_id, r.emails_sent, r.opens_unique])).toEqual([
      ["c1", 900, 300],
      ["c2", 12, 3],
    ]);
    expect(KLAVIYO_REPORT_STATISTICS).toEqual(["recipients", "opens_unique", "clicks_unique"]);
  });

  it("refuses a report response that does not match the documented shape", async () => {
    // Flagged UNVERIFIED in the connector: the results/groupings/statistics
    // shape was not confirmed against a live account for this build. It fails
    // LOUDLY rather than quietly, which is what makes an unverified fact
    // supportable.
    // Mutation: default the counts to zero on an unrecognised shape → every
    // campaign reports reaching nobody, confidently.
    const { c } = connector({
      conversionMetricId: "MetricABC",
      routes: [
        { match: /campaign-values-reports/, responses: [{ body: { data: { attributes: {} } } }] },
      ],
    });
    await expect(c.campaignValues()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("spends the daily budget and then reports it as its own state", () => {
    // Not a throttle: no amount of backing off produces more of them, and the
    // ceiling is shared with the customer's other integrations.
    // Mutation: retry on exhaustion → an infinite loop against a hard cap.
    let clock = NOW;
    const budget = new DailyCallBudget(3, () => clock);
    budget.charge();
    budget.charge();
    budget.charge();
    expect(budget.remaining).toBe(0);
    expect(() => budget.charge()).toThrow(KlaviyoReportBudgetExhaustedError);
    // ...and it refills on the window, not on a retry.
    clock += 24 * 60 * 60 * 1000;
    expect(budget.remaining).toBe(3);
    expect(() => budget.charge()).not.toThrow();
    expect(KLAVIYO_REPORT_CALLS_PER_DAY).toBe(225);
    expect(KLAVIYO_RATE_LIMITS.campaignValuesReport.perDay).toBe(225);
  });

  it("charges the budget BEFORE the attempt loop, so a retried 429 costs one call", async () => {
    // Mutation: charge inside the retry loop → a rate-limited account burns its
    // daily report budget four times faster than it thinks it does.
    const budget = new DailyCallBudget(2, () => NOW);
    const { c } = connector({
      conversionMetricId: "MetricABC",
      reportBudget: budget,
      routes: [
        {
          match: /campaign-values-reports/,
          responses: [
            { status: 429, headers: { "Retry-After": "1" }, body: {} },
            { body: { data: { attributes: { results: [] } } } },
          ],
        },
      ],
    });
    await c.campaignValues();
    expect(budget.remaining).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connect-time probe, purge, status
// ─────────────────────────────────────────────────────────────────────────────

describe("connect-time probe and compliance", () => {
  it("keeps the Free-plan question as an explicit UNVERIFIED state until probed", async () => {
    // Klaviyo's pricing page addresses INTEGRATIONS and is silent on the
    // developer API, so nothing anywhere says a Free account may issue API
    // calls. A probe result defaulting to "ok" would encode an assumption this
    // connector refuses to make.
    // Mutation: initialise the probe to `ok` → red.
    const { c } = connector({ blocked: true });
    const before = await c.status();
    expect(before.planProbe.state).toBe("unverified");

    const { c: c2 } = connector({
      routes: [{ match: /\/api\/metrics/, responses: [{ body: page([{ id: "m1" }]) }] }],
    });
    const probe = await c2.probePlanAccess();
    expect(probe.state).toBe("ok");
  });

  it("keeps both unresolved obligations on the record", () => {
    // Klaviyo's API terms were NOT read for this build, and the Mailchimp
    // track's equivalent list is not boilerplate — that vendor's policy granted
    // Intuit audit rights over our systems and facilities. Nothing about
    // Klaviyo may be assumed by analogy in either direction.
    // Mutation: delete either entry → red.
    expect(KLAVIYO_UNRESOLVED_OBLIGATIONS.some((o) => o.includes("terms of use"))).toBe(true);
    expect(KLAVIYO_UNRESOLVED_OBLIGATIONS.some((o) => o.includes("Free-plan"))).toBe(true);
  });

  it("purges by CONNECTION id and enumerates from servesDatasets", async () => {
    // On a box with two Klaviyo connections a provider-scoped delete destroys
    // the other customer's data. And a hand-kept dataset list drifts, leaving
    // data behind under a successful-looking report.
    // Mutation: pass `this.provider` instead of the connection id → red.
    const seen: [string, string][] = [];
    const audits: { action: string; scope: Record<string, unknown> }[] = [];
    const { c } = connector({
      connectionId: "conn_b",
      purgeStore: {
        deleteByConnection: async (connectionId, dataset) => {
          seen.push([connectionId, dataset]);
          return 2;
        },
      },
      audit: (e) => {
        audits.push(e);
      },
    });
    const result = await c.purgeAccount();
    expect(seen.map(([id]) => id)).toEqual(KLAVIYO_DATASETS.map(() => "conn_b"));
    expect(seen.map(([, d]) => d)).toEqual([...KLAVIYO_DATASETS]);
    expect(result.totalDeleted).toBe(2 * KLAVIYO_DATASETS.length);
    // Counts only. No address, no profile content, no campaign text.
    expect(audits[0].action).toBe("klaviyo.purge_account");
    expect(JSON.stringify(audits[0].scope)).not.toContain("@example.test");
  });

  it("refuses to report a vacuous purge success with no store wired", async () => {
    // Mutation: return a zero-count receipt → the deletion obligation looks
    // discharged when nothing was deleted.
    const { c } = connector();
    await expect(c.purgeAccount()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("reports a status that carries no key material and derives ok from state", async () => {
    // Mutation: add a `keyPrefix` field for debugging → red.
    const { c } = connector({ conversionMetricId: "MetricABC" });
    await c.listProfiles();
    const status = await c.status();
    expect(status.state).toBe("connected");
    expect(status.ok).toBe(true);
    expect(status.hasApiKey).toBe(true);
    expect(status.hasConversionMetricId).toBe(true);
    expect(status.apiRevision).toBe(KLAVIYO_API_REVISION);
    expect(status.fallForwardOptOut).toBe(true);
    expect(status.reportCallsRemainingToday).toBe(KLAVIYO_REPORT_CALLS_PER_DAY);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("declares the provider key and the five datasets, and introspects to that shape", async () => {
    // Mutation: invent a dataset name → `tsc` refuses it (the union is closed),
    // and this goes red on the column list.
    const { c } = connector();
    expect(c.provider).toBe(KLAVIYO_PROVIDER);
    expect([...c.servesDatasets].sort()).toEqual(
      ["audience", "audience_member", "campaign", "contact", "engagement"].sort(),
    );
    const { tables, fingerprint } = await c.introspect();
    expect(tables.map((t) => t.name).sort()).toEqual([...KLAVIYO_DATASETS].sort());
    expect(tables[0].columns.map((col) => col.name)).toEqual([...CANONICAL_COLUMNS.contact]);
    expect(fingerprint).toMatch(/^[0-9a-f]+$/);
    expect(c.schemaFingerprint).toBe(fingerprint);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function list(id: string, attrs: Record<string, unknown> = {}) {
  return {
    type: "list",
    id,
    attributes: { name: `List ${id}`, created: "2026-01-01T00:00:00Z", ...attrs },
  };
}

function singleList(id: string, profileCount: number) {
  return {
    type: "list",
    id,
    attributes: { name: `List ${id}`, created: "2026-01-01T00:00:00Z", profile_count: profileCount },
  };
}

/**
 * A campaign in the VENDOR's shape — and the absences are the whole point.
 *
 * There is NO `subject` on a campaign's attributes: Klaviyo publishes the
 * recipient-visible line on the campaign's MESSAGE, at
 * `definition.content.subject`, reachable only through
 * `include=campaign-messages`. And there is no `list_id` either — the lists a
 * send went to arrive as `attributes.audiences = { included, excluded }`.
 *
 * This fixture USED to fabricate `subject` straight onto `attributes`, and that
 * one line hid a permanently blank column behind a green suite: the connector
 * read `record.subject`, the fixture supplied `record.subject`, and no test in
 * the file ever touched the sideload the request was actually paying for. A
 * fixture that is not the vendor's shape tests the fixture.
 */
function campaign(id: string, attrs: Record<string, unknown> = {}) {
  return {
    type: "campaign",
    id,
    attributes: {
      name: `Campaign ${id}`,
      status: "Sent",
      send_time: "2026-08-10T12:00:00Z",
      updated_at: "2026-08-11T12:00:00Z",
      audiences: { included: [`list-${id}`], excluded: [`suppressed-${id}`] },
      ...attrs,
    },
    relationships: {
      [KLAVIYO_CAMPAIGN_MESSAGE_INCLUDE]: {
        data: [{ type: KLAVIYO_CAMPAIGN_MESSAGE_TYPE, id: `msg-${id}` }],
      },
    },
  };
}

/** The sideloaded resource that carries the subject. Three levels down —
 *  `attributes.definition.content.subject` — and the ONLY source of the
 *  canonical `subject` column. */
function campaignMessage(campaignId: string, subject: string) {
  return {
    type: KLAVIYO_CAMPAIGN_MESSAGE_TYPE,
    id: `msg-${campaignId}`,
    attributes: { definition: { channel: "email", content: { subject } } },
  };
}

/** A campaign-values report body, so the counts route is not retyped per test. */
function reportRoute(results: unknown[]): Route {
  return {
    match: /campaign-values-reports/,
    responses: [
      { body: { data: { type: "campaign-values-report", attributes: { results } } } },
    ],
  };
}
