/**
 * PipedriveConnector.
 *
 * `fetch` is INJECTED, never patched globally, and every test asserts on the
 * CALLS the connector made — not only on what it returned. That distinction
 * carries the same weight here as on the Mailchimp and Shopify tracks, for the
 * same reason:
 *
 * Pipedrive's host is PER CUSTOMER — `{companyDomain}.pipedrive.com` — so
 * `docs/security/allowed-egress.yaml` has to register it as `kind: dynamic`,
 * and a `kind: dynamic` entry contributes ZERO host patterns to
 * `scripts/check-egress-allowlist.py`. Nothing in CI verifies where this
 * connector dials. `assertSafePipedriveBaseUrl` is the entire control, so its
 * tests assert on ZERO fetch calls: a test that inspected the returned error
 * would still pass if the request had already gone out carrying the customer's
 * API token, which IS full access to their CRM.
 *
 * A second theme runs through this file: **the vendor facts that fail
 * silently.** Pipedrive ignores an unknown query parameter and answers HTTP 200
 * with the whole collection, so a misspelt delta parameter, or an activities
 * `type` filter that was never a query parameter, produces a FULL SCAN reported
 * as an incremental read — correct-looking rows, no error, and a customer's
 * daily API token budget spent. Those tests assert on the outgoing REQUEST and
 * cite the vendor doc that settles the fact.
 *
 * Every test names the mutation that must turn it red.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import {
  InvalidPipedriveCredentialError,
  PIPEDRIVE_ACTIVITY_QUERY_PARAMS,
  PIPEDRIVE_ALLOWED_HOST_PATTERN,
  PIPEDRIVE_API_BASE_PATH,
  PIPEDRIVE_API_HOST_SUFFIX,
  PIPEDRIVE_AUTH_HEADER,
  PIPEDRIVE_BURST_LIMIT,
  PIPEDRIVE_BURST_WINDOW_MS,
  PIPEDRIVE_CONSTANT_HEADERS,
  PIPEDRIVE_DATASETS,
  PIPEDRIVE_DATASETS_WITHOUT_UPPER_BOUND,
  PIPEDRIVE_DATASET_ENDPOINTS,
  PIPEDRIVE_DEFAULT_PAGE_SIZE,
  PIPEDRIVE_DELETED_DEAL_WINDOW_NOTE,
  PIPEDRIVE_DELETION_VISIBILITY,
  PIPEDRIVE_DELTA_PARAM,
  PIPEDRIVE_FORBIDDEN_PATH_SEGMENT,
  PIPEDRIVE_MAX_BURST_CEILING,
  PIPEDRIVE_MAX_PAGE_SIZE,
  PIPEDRIVE_PROVIDER,
  PIPEDRIVE_SCAN_MODE,
  PIPEDRIVE_SENDABLE_QUERY_PARAMS,
  PIPEDRIVE_SORT_DIRECTION,
  PIPEDRIVE_SORT_FIELD,
  PIPEDRIVE_UNRECONCILED_COLUMNS,
  PIPEDRIVE_USERS_ME_PATH,
  PIPEDRIVE_WINDOW_END_PARAM,
  PipedriveApiError,
  PipedriveBurstGovernor,
  PipedriveCapabilityMissingError,
  PipedriveColumnNotAvailableError,
  PipedriveCompanyDomainChangedError,
  PipedriveConnector,
  PipedriveRateLimitedError,
  PipedriveReauthorizationRequiredError,
  PipedriveTimeoutError,
  UnsafePipedriveBaseUrlError,
  assertPipedriveActivityParams,
  assertPipedriveCompanyDomain,
  assertPipedriveSendableParams,
  assertPipedriveWindow,
  assertReadablePipedrivePath,
  assertSafePipedriveBaseUrl,
  parsePipedriveApiToken,
  pipedriveActivityInstant,
  pipedriveBaseUrlFor,
  pipedriveGovernorFor,
  pipedriveInstant,
  pipedriveMajorUnits,
  pipedriveMoneyPair,
  pipedriveWireInstant,
  resetPipedriveGovernors,
  selectPipedrivePrice,
  selectPipedrivePrimaryValue,
  type PipedriveConnectorDeps,
} from "../src/pipedrive/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import {
  CANONICAL_COLUMNS,
  COLUMN_KIND,
  REQUIRED_CANONICAL,
  type DatasetName,
} from "../src/export-drop/profiles.js";

/** 2026-09-03T12:00:00Z, the clock every test runs on. */
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

/** The fixture tenant. Not a real account. */
const DOMAIN = "acme-sales";
const HOST = `${DOMAIN}${PIPEDRIVE_API_HOST_SUFFIX}`;

/**
 * A fixture token.
 *
 * COMPOSED FROM PARTS ON PURPOSE — do not inline it back into one literal.
 * Pipedrive tokens are commonly 40 hex characters, which is the shape secret
 * scanners look for, and a contiguous literal of that shape in a tracked file
 * is the kind of thing that gets a push rejected. Split, it never exists as a
 * matchable string in source while the tests still exercise a realistic value.
 */
const TOKEN = "a1b2c3d4e5f60718" + "293a4b5c6d7e8f90" + "a1b2c3d4";

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Return a body that is not JSON, to exercise the unparseable path. */
  bad?: boolean;
}
interface Route {
  match: RegExp;
  responses: StubResponse[];
}
interface Recorded {
  url: string;
  init: Record<string, unknown>;
}

/** A routed fetch stub that records every call — url, method, headers and the
 *  redirect policy — so a test can assert what actually went on the wire. */
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
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => {
        if (r.bad) throw new SyntaxError("not JSON");
        return r.body ?? {};
      },
    } as unknown as Response;
  };

  return {
    impl,
    calls,
    urls: () => calls.map((c) => c.url),
    paths: () => calls.map((c) => new URL(c.url).pathname),
    params: (i: number) => new URL(calls[i].url).searchParams,
    headers: (i: number) => (calls[i].init.headers ?? {}) as Record<string, string>,
  };
}

/** Everything is routed to a single body unless a test says otherwise. */
const ANY: Route[] = [{ match: /.*/, responses: [{ body: { data: [] } }] }];

function connector(
  opts: {
    routes?: Route[];
    baseUrl?: string;
    companyDomain?: string;
    token?: string;
    /** Leave the default resolver in place — the shipped-off state. */
    blocked?: boolean;
    timeoutMs?: number;
    burstCeiling?: number;
    /** Use the module-level governor rather than the roomy per-test one. */
    realGovernor?: boolean;
    fetchImpl?: PipedriveConnectorDeps["fetchImpl"];
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const f = stubFetch(opts.routes ?? ANY);
  const sleeps: number[] = [];
  const sleep =
    opts.sleep ??
    (async (ms: number) => {
      sleeps.push(ms);
    });
  const domain = opts.companyDomain ?? DOMAIN;
  const c = new PipedriveConnector(
    {
      credentialsSecretRef: "secret://pipedrive/acct_fixture",
      companyDomain: domain,
      connectionId: "conn_a",
      baseUrl: opts.baseUrl,
      burstCeiling: opts.burstCeiling,
    },
    {
      fetchImpl: opts.fetchImpl ?? f.impl,
      now: () => NOW,
      sleep,
      timeoutMs: opts.timeoutMs,
      resolveApiToken: opts.blocked ? undefined : async () => opts.token ?? TOKEN,
      // A roomy governor by default: the burst ceiling is exercised in its own
      // describe block, and a frozen clock plus the real ceiling would throttle
      // every other test for reasons that have nothing to do with what they
      // assert.
      governor: opts.realGovernor
        ? undefined
        : new PipedriveBurstGovernor(domain, () => NOW, sleep, 10_000),
    },
  );
  return { c, f, sleeps };
}

const SRC_DIR = fileURLToPath(new URL("../src/pipedrive/", import.meta.url));
const sourceOf = (file: string): string => readFileSync(join(SRC_DIR, file), "utf8");

/** One page of vendor rows plus the cursor envelope. `null` next_cursor is the
 *  documented end-of-dataset signal. */
function page(rows: unknown[], nextCursor: string | null) {
  return { success: true, data: rows, additional_data: { next_cursor: nextCursor } };
}

/**
 * Enumerate exactly one vendor row through the PUBLIC read path and return the
 * canonical row it produced.
 *
 * Deliberately not a direct call into the mapper: the projection is the thing
 * under test only insofar as it is what a caller actually receives, and routing
 * through `runRead` keeps the registry lookup, the dataset check and the
 * canonical projector all in the path a real read takes.
 */
async function projectThrough(
  dataset: DatasetName,
  record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // `product` has no entry: there is no registry read this track can answer for
  // it (see the get_low_stock_products refusal), so it goes through the
  // enumerate path the sync runner uses instead.
  const reads: Partial<Record<DatasetName, string>> = {
    contact: "find_contact",
    company: "get_company",
    deal: "get_deals_by_stage",
    engagement: "get_engagements",
  };
  const read = reads[dataset];
  const { c } = connector({
    routes: [{ match: /.*/, responses: [{ body: page([record], null) }] }],
  });
  if (read === undefined) {
    const rows = await (
      c as unknown as {
        enumerate: (d: string, s: string | undefined) => Promise<Record<string, unknown>[]>;
      }
    ).enumerate(dataset, undefined);
    return rows[0];
  }
  const rows = (await c.runRead(read, {})) as Record<string, unknown>[];
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-customer host guard — the ONLY enforcement, because CI cannot see
// this host. Every assertion here checks ZERO fetch calls.
// ─────────────────────────────────────────────────────────────────────────────

describe("the per-customer host guard", () => {
  it("refuses a SUFFIX-ATTACK host on ZERO fetch calls", () => {
    // The attack the anchoring exists to stop: a host that ends with the real
    // one but is owned by someone else.
    // Mutation: change the guard from anchored equality to
    // `host.endsWith(".pipedrive.com")` → red here, AND red on the zero-fetch
    // assertion, which is the half that proves the token never left.
    const f = stubFetch(ANY);
    expect(
      () =>
        new PipedriveConnector(
          {
            credentialsSecretRef: "secret://pipedrive/acct_fixture",
            companyDomain: DOMAIN,
            connectionId: "conn_a",
            baseUrl: `https://${HOST}.evil.test`,
          },
          { fetchImpl: f.impl, now: () => NOW, resolveApiToken: async () => TOKEN },
        ),
    ).toThrow(UnsafePipedriveBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a MULTI-LABEL host that still ends with the real suffix — zero fetch calls", async () => {
    // The other half of the anchoring, and the one an `endsWith` check does NOT
    // catch: `evil.acme-sales.pipedrive.com` genuinely ends with
    // `.pipedrive.com`, so a suffix test accepts it. Only the leftmost-label
    // anchor refuses it.
    //
    // The zero-fetch half is asserted against a stub the CONNECTOR was actually
    // given, on the path that would have dialled. An earlier version of this
    // test built a stub, handed it to nobody, called the pure guard directly
    // and then asserted the untouched stub had recorded nothing — an assertion
    // that would have stayed green with the guard deleted, which is worse than
    // no assertion because it reads as proof.
    // Mutation: replace the anchored pattern with
    // `host.endsWith(PIPEDRIVE_API_HOST_SUFFIX)` → red on the throws. Delete
    // the assertSafePipedriveBaseUrl call from request() → red on the ZERO
    // fetch calls, which is the half proving the customer's token — full access
    // to their CRM — never left the box.
    for (const evil of [`https://evil.${HOST}`, `https://a.b.${HOST}`]) {
      // 1. The pure guard refuses it.
      expect(() => assertSafePipedriveBaseUrl(evil, DOMAIN), evil).toThrow(
        UnsafePipedriveBaseUrlError,
      );
      // 2. A connection configured for it fails to BUILD, with the stub it
      //    would have used recording nothing.
      const built = stubFetch(ANY);
      expect(
        () =>
          new PipedriveConnector(
            {
              credentialsSecretRef: "secret://pipedrive/acct_fixture",
              companyDomain: DOMAIN,
              connectionId: "conn_a",
              baseUrl: evil,
            },
            { fetchImpl: built.impl, now: () => NOW, resolveApiToken: async () => TOKEN },
          ),
        evil,
      ).toThrow(UnsafePipedriveBaseUrlError);
      expect(built.calls, evil).toHaveLength(0);
      // 3. And a live connector whose destination is moved to it afterwards
      //    refuses at REQUEST time, on the wired stub, which is where a fetch
      //    would actually have been recorded. The outcome is captured rather
      //    than asserted inline so the ZERO-FETCH claim is checked FIRST: it is
      //    the claim this test's title makes, and a version that asserted the
      //    error class first would abort before ever looking at the wire.
      const { c, f } = connector();
      (c as unknown as { baseUrl: string }).baseUrl = evil;
      const outcome = await c.listDataset("contact").then(
        () => "resolved",
        (err: unknown) => err,
      );
      expect(f.calls, evil).toHaveLength(0);
      expect(outcome, evil).toBeInstanceOf(UnsafePipedriveBaseUrlError);
    }
  });

  it("refuses a DIFFERENT tenant's host — one customer's token cannot be pointed at another's", () => {
    // A tampered `providerConfig` must not be able to redirect traffic to a
    // different (real, well-formed) Pipedrive tenant. This is the sharpest
    // version of the risk: `other-co.pipedrive.com` passes every shape check.
    // Mutation: drop the `host !== expected` check and keep only the shape
    // regex → red.
    expect(() =>
      assertSafePipedriveBaseUrl(`https://other-co${PIPEDRIVE_API_HOST_SUFFIX}`, DOMAIN),
    ).toThrow(UnsafePipedriveBaseUrlError);
    expect(() => assertSafePipedriveBaseUrl(`https://${HOST}`, DOMAIN)).not.toThrow();
  });

  it("refuses an ARBITRARY host smuggled in through the company domain", () => {
    // The sharp edge of a per-customer host: whatever lands in the company
    // domain field becomes the leftmost label. A value carrying a dot, a slash
    // or a colon would make the "host" someone else's domain entirely.
    // Mutation: relax PIPEDRIVE_COMPANY_DOMAIN_PATTERN to /^[a-z0-9.\/:-]+$/ → red.
    for (const evil of [
      "evil.com",
      "evil.com/",
      "acme.evil",
      "../acme",
      "acme:443",
      "-acme",
      "acme-",
      "",
      "acme sales",
      "acme_sales",
      "a".repeat(64),
    ]) {
      expect(() => assertPipedriveCompanyDomain(evil), evil).toThrow(UnsafePipedriveBaseUrlError);
    }
    // Non-strings too: `providerConfig` is free-text JSON, so a number or an
    // object can arrive here.
    for (const evil of [null, undefined, 42, { host: "evil.test" }]) {
      expect(() => assertPipedriveCompanyDomain(evil), String(evil)).toThrow(
        UnsafePipedriveBaseUrlError,
      );
    }
    expect(assertPipedriveCompanyDomain(DOMAIN)).toBe(DOMAIN);
    // Case-folded on the way through, because a hostname label is
    // case-insensitive and the exact-equality check below it is not. The
    // folding happens BEFORE the shape test, so an uppercase domain is
    // normalised rather than refused — a customer who typed their domain with a
    // capital should not be told it is invalid.
    expect(assertPipedriveCompanyDomain(" Acme-Sales ")).toBe(DOMAIN);
    expect(assertPipedriveCompanyDomain("ACME")).toBe("acme");
  });

  it("refuses plain http, userinfo and a non-443 port", () => {
    // Mutation: drop any one of the three checks → red. A standing account
    // credential over http is the credential given away.
    expect(() => assertSafePipedriveBaseUrl(`http://${HOST}`, DOMAIN)).toThrow(
      UnsafePipedriveBaseUrlError,
    );
    expect(() => assertSafePipedriveBaseUrl(`https://evil@${HOST}`, DOMAIN)).toThrow(
      UnsafePipedriveBaseUrlError,
    );
    expect(() => assertSafePipedriveBaseUrl(`https://${HOST}:8443`, DOMAIN)).toThrow(
      UnsafePipedriveBaseUrlError,
    );
    // An explicit :443 is the https default and the URL parser drops it.
    expect(() => assertSafePipedriveBaseUrl(`https://${HOST}:443`, DOMAIN)).not.toThrow();
  });

  it("builds the origin from the company domain and re-validates it", () => {
    // Mutation: have pipedriveBaseUrlFor return its constructed string without
    // passing it back through the guard → red, because one code path would then
    // be untested.
    expect(pipedriveBaseUrlFor(DOMAIN)).toBe(`https://${HOST}`);
    expect(() => pipedriveBaseUrlFor("evil.com")).toThrow(UnsafePipedriveBaseUrlError);
    // The origin carries NO path: this connector dials two prefixes, /api/v2
    // for the datasets and /api/v1/users/me for the domain check.
    expect(pipedriveBaseUrlFor(DOMAIN)).not.toContain(PIPEDRIVE_API_BASE_PATH);
  });

  it("re-validates the destination on EVERY request, not once at construction — zero fetch calls", async () => {
    // A guard that ran only at construction is defeated by anything that
    // changes the connection afterwards. `providerConfig` is free-text JSON, so
    // "it was valid when we built it" is not a property this connector may rely
    // on. Reaching past `private` is deliberate: the invariant under test is
    // "the destination is checked at request time", and the only way to observe
    // it is to make construction-time validation insufficient.
    //
    // Mutation: replace the per-request assertSafePipedriveBaseUrl(...) in
    // request() with a bare `this.baseUrl` → red, and red on ZERO fetch calls,
    // which is the half proving the token never went out.
    const { c, f } = connector();
    (c as unknown as { baseUrl: string }).baseUrl = `https://${HOST}.evil.test`;
    await expect(c.listDataset("contact")).rejects.toBeInstanceOf(UnsafePipedriveBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("keeps the invariant host suffix as ONE whole-string literal", () => {
    // The static scanner can only extract what it literally sees. The company
    // domain is unknowable at build time, so the invariant tail is the most it
    // can ever be given.
    // Mutation: rewrite it as a concatenation ("." + "pipedrive" + ".com") → red.
    expect(sourceOf("connector.ts")).toContain(
      'PIPEDRIVE_API_HOST_SUFFIX = ".pipedrive.com"',
    );
    expect(PIPEDRIVE_API_HOST_SUFFIX).toBe(".pipedrive.com");
  });

  it("carries NO scheme-URL literal for a Pipedrive host anywhere in the connector directory", () => {
    // The `kind: dynamic` allowlist entry registers NO host patterns, so a
    // `https://acme.pipedrive.com` literal would be extracted by
    // scripts/check-egress-allowlist.py as an unregistered destination and fail
    // egress-gate. That includes `api.pipedrive.com`, which Pipedrive DOES
    // still document (as a bootstrap host for GET /users/me) but which this
    // connector deliberately never dials — it always has the customer's domain
    // in hand by the time it makes that call.
    // Mutation: add one → red here AND in the gate.
    for (const file of readdirSync(SRC_DIR)) {
      expect(sourceOf(file), file).not.toMatch(/https?:\/\/[A-Za-z0-9.-]*pipedrive\.com/);
    }
  });

  it("anchors the host pattern at both ends", () => {
    // Mutation: drop either anchor → red.
    expect(PIPEDRIVE_ALLOWED_HOST_PATTERN.test(HOST)).toBe(true);
    expect(PIPEDRIVE_ALLOWED_HOST_PATTERN.test(`${HOST}.evil.test`)).toBe(false);
    expect(PIPEDRIVE_ALLOWED_HOST_PATTERN.test(`evil.test.${HOST}`)).toBe(false);
    expect(PIPEDRIVE_ALLOWED_HOST_PATTERN.test(`sub.${HOST}`)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The credential: header shape, and the token never anywhere else
// ─────────────────────────────────────────────────────────────────────────────

describe("the auth header", () => {
  it("sends the token in `x-api-token`, character for character, and in no other header", async () => {
    // https://pipedrive.readme.io/docs/core-api-concepts-authentication —
    // "The API token must be provided in the `x-api-token` header for all
    // requests".
    // Mutation: rename the header, change its case to `X-Api-Token` on a
    // case-sensitive client, or move to `Authorization: Bearer` → red.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    await c.listDataset("contact");
    const headers = f.headers(0);
    expect(PIPEDRIVE_AUTH_HEADER).toBe("x-api-token");
    expect(headers[PIPEDRIVE_AUTH_HEADER]).toBe(TOKEN);
    expect(Object.keys(headers)).toContain("x-api-token");
    expect(Object.keys(headers)).not.toContain("Authorization");
    expect(Object.keys(headers)).not.toContain("authorization");
  });

  it("sends every mandatory constant header, and nothing else besides the token", async () => {
    // Mutation: drop `Accept: application/json` → red. Pipedrive answers JSON
    // regardless, so this is exactly the kind of header a tidy-up removes.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    await c.listDataset("deal");
    const headers = f.headers(0);
    for (const [k, v] of Object.entries(PIPEDRIVE_CONSTANT_HEADERS)) {
      expect(headers[k]).toBe(v);
    }
    expect(new Set(Object.keys(headers))).toEqual(
      new Set([PIPEDRIVE_AUTH_HEADER, ...Object.keys(PIPEDRIVE_CONSTANT_HEADERS)]),
    );
    expect(PIPEDRIVE_CONSTANT_HEADERS.Accept).toBe("application/json");
  });

  it("never puts the token in a URL — not as `api_token`, not as anything", async () => {
    // The v1 `?api_token=` form still works on the endpoints that still exist,
    // and it puts a standing full-account credential into every proxy log,
    // referrer header and browser history between here and Pipedrive.
    // Mutation: add `api_token` to the query string → red twice.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    for (const dataset of PIPEDRIVE_DATASETS) {
      await c.listDataset(dataset);
    }
    await c.verifyCompanyDomain();
    for (const url of f.urls()) {
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain("api_token");
    }
    // And the sendable-parameter allowlist makes it unrepresentable, not merely
    // absent today.
    expect(PIPEDRIVE_SENDABLE_QUERY_PARAMS.has("api_token")).toBe(false);
  });

  it("never follows a redirect — a 30x off the configured host is a refusal, not a hop", async () => {
    // The fetch spec strips credential headers on cross-origin redirects, but
    // the token's safety must not rest on every runtime implementing that
    // correctly. A 30x here is also exactly what a renamed company domain looks
    // like, which is a state this connector reports rather than follows.
    // Mutation: drop `redirect: "error"` → red.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    await c.listDataset("company");
    expect(f.calls[0].init.redirect).toBe("error");
    expect(f.calls[0].init.method).toBe("GET");
  });

  it("refuses a header-unsafe token at intake, naming only the rejection class", () => {
    // Pipedrive publishes no token format, so this is a HEADER-SAFETY floor
    // rather than a claimed vendor shape — a value carrying a newline is a
    // header-injection primitive, and one carrying a space is a copy-paste that
    // wrapped across two lines.
    // Mutation: drop the whitespace test → red on the wrapped-paste cases.
    for (const bad of ["", "   ", "abc def", "abc\ndef", "abc\tdef", "tiny"]) {
      expect(() => parsePipedriveApiToken(bad), JSON.stringify(bad)).toThrow(
        InvalidPipedriveCredentialError,
      );
    }
    expect(parsePipedriveApiToken(` ${TOKEN} `)).toBe(TOKEN);
    // And the error never quotes the offered value — a validation error that
    // did would write the credential into every log line that renders it.
    try {
      parsePipedriveApiToken(`${TOKEN} extra`);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The delta parameter — the fact that fails SILENTLY
// ─────────────────────────────────────────────────────────────────────────────

describe("the delta parameter", () => {
  it("is `updated_since`, verbatim, on every one of the five datasets", async () => {
    // THE test this connector exists to pass. A wrong delta parameter is not an
    // error on this vendor: Pipedrive ignores an unknown query parameter and
    // answers HTTP 200 with the WHOLE collection, so the connector runs a full
    // scan while reporting an incremental read — correct-looking rows, no error
    // anywhere, and the customer's daily token budget spent.
    //
    // Verified character-by-character on all five v2 endpoints, each with the
    // identical wording "If set, only <entity> with an `update_time` later than
    // or equal to this time are returned. In RFC3339 format, e.g.
    // 2025-01-01T10:20:00Z.":
    //   https://developers.pipedrive.com/docs/api/v1/Deals
    //   https://developers.pipedrive.com/docs/api/v1/Persons
    //   https://developers.pipedrive.com/docs/api/v1/Organizations
    //   https://developers.pipedrive.com/docs/api/v1/Activities
    //   https://developers.pipedrive.com/docs/api/v1/Products
    //
    // Mutation: rename the constant to `modified_since`, `since`, or
    // `updated_after` → red on all five. Drop the parameter from listDataset →
    // red on all five.
    const since = "2026-09-01T00:00:00Z";
    for (const dataset of PIPEDRIVE_DATASETS) {
      const { c, f } = connector({
        routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
      });
      await c.listDataset(dataset, { updatedSince: since });
      expect(f.params(0).get(PIPEDRIVE_DELTA_PARAM), dataset).toBe(since);
      expect(f.calls[0].url, dataset).toContain(`updated_since=${encodeURIComponent(since)}`);
    }
    expect(PIPEDRIVE_DELTA_PARAM).toBe("updated_since");
  });

  it("sends the delta in the vendor's documented SECOND-precision form, truncating never rounding", async () => {
    // Pipedrive documents one example and one only: "In RFC3339 format, e.g.
    // 2025-01-01T10:20:00Z." RFC 3339 permits a fraction and Pipedrive very
    // probably accepts one, but nothing in this connector has been exercised
    // against a live tenant, and this is the single wire value whose silent
    // mishandling is the full-scan-reported-as-a-delta class — a rejected or
    // misparsed filter does not have to fail loudly on a vendor that answers
    // HTTP 200 with the whole collection for anything it cannot use.
    //
    // The DIRECTION is the load-bearing half. `updated_since` is inclusive
    // ("later than or equal to"), so truncating a fraction moves the boundary
    // at most one second EARLIER: rows can be re-read — which watermarkIds
    // de-duplicates — and can never be stepped over. Rounding up would skip
    // whatever was written inside that second, permanently and silently.
    // Mutation: change the truncation to a round → red on the 999ms case, and
    // a delta would start losing rows nobody could name.
    for (const dataset of PIPEDRIVE_DATASETS) {
      const { c, f } = connector({
        routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
      });
      await c.listDataset(dataset, { updatedSince: "2026-09-01T10:20:00.999Z" });
      const sent = f.params(0).get(PIPEDRIVE_DELTA_PARAM);
      expect(sent, dataset).toBe("2026-09-01T10:20:00Z");
      expect(sent, dataset).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(f.calls[0].url, dataset).not.toContain(".999");
    }
    // Direct, so the property is pinned on the function as well as on the wire.
    expect(pipedriveWireInstant(PIPEDRIVE_DELTA_PARAM, "2026-09-01T10:20:00.999Z")).toBe(
      "2026-09-01T10:20:00Z",
    );
    expect(pipedriveWireInstant(PIPEDRIVE_DELTA_PARAM, undefined)).toBeUndefined();
    // The vendor's OWN watermark string — space-separated, no zone marker — is
    // what a caller feeds back from PipedrivePage, and it has to survive the
    // round trip as the same instant rather than being read as local time.
    // Mutation: parse it with a bare Date.parse → red on any box not on UTC.
    expect(pipedriveWireInstant(PIPEDRIVE_DELTA_PARAM, "2026-09-02 09:00:00")).toBe(
      "2026-09-02T09:00:00Z",
    );
    // The upper bound gets the same rendering, on the datasets that have one.
    const { c: bounded, f: boundedFetch } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    await bounded.listDataset("deal", { updatedUntil: "2026-09-02T09:00:00.500Z" });
    expect(boundedFetch.params(0).get(PIPEDRIVE_WINDOW_END_PARAM)).toBe("2026-09-02T09:00:00Z");
  });

  it("REFUSES a timestamp it cannot render rather than dropping the filter", async () => {
    // The failure this closes is the one the whole file is arranged around:
    // Pipedrive ignores a parameter it cannot use and answers 200 with the
    // entire collection. A value that could not be rendered and was quietly
    // omitted would therefore produce a full scan reported as an incremental
    // read — correct-looking rows, no error, the customer's daily token budget
    // spent.
    // Mutation: return `undefined` for an unrenderable value instead of
    // throwing → red here, and red on the zero-fetch assertion.
    const { c, f } = connector();
    await expect(c.listDataset("deal", { updatedSince: "last tuesday" })).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    expect(f.calls).toHaveLength(0);
    expect(() => pipedriveWireInstant(PIPEDRIVE_WINDOW_END_PARAM, "nonsense")).toThrow(
      ConnectorBlockedError,
    );
  });

  it("walks each dataset at its own v2 endpoint, and no dataset path is v1", async () => {
    // v1 for Activities, Deals, Persons, Organizations and Products went OUT OF
    // SUPPORT on 2026-08-01 (changelog:
    // https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints,
    // effective-date confirmed by
    // https://devcommunity.pipedrive.com/t/reminder-deprecated-api-v1-endpoints-are-now-out-of-support/20466
    // — note the changelog page itself still shows the stale December 2025
    // date; August 2026 is the live one, do not "correct" it back).
    // Mutation: point any dataset at /api/v1/... → red.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    for (const dataset of PIPEDRIVE_DATASETS) {
      await c.listDataset(dataset);
    }
    expect(f.paths()).toEqual([
      `${PIPEDRIVE_API_BASE_PATH}/persons`,
      `${PIPEDRIVE_API_BASE_PATH}/organizations`,
      `${PIPEDRIVE_API_BASE_PATH}/deals`,
      `${PIPEDRIVE_API_BASE_PATH}/activities`,
      `${PIPEDRIVE_API_BASE_PATH}/products`,
    ]);
    for (const path of Object.values(PIPEDRIVE_DATASET_ENDPOINTS)) {
      expect(path.startsWith(`${PIPEDRIVE_API_BASE_PATH}/`), path).toBe(true);
    }
  });

  it("sorts every walk by update_time ascending so the watermark advances monotonically", async () => {
    // A descending or unsorted walk cannot produce a watermark that is safe to
    // persist before the last page has been read.
    // Mutation: drop sort_by/sort_direction, or flip to `desc` → red.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    await c.listDataset("deal", { updatedSince: "2026-09-01T00:00:00Z" });
    expect(f.params(0).get("sort_by")).toBe(PIPEDRIVE_SORT_FIELD);
    expect(f.params(0).get("sort_direction")).toBe(PIPEDRIVE_SORT_DIRECTION);
    expect(PIPEDRIVE_SORT_FIELD).toBe("update_time");
    expect(PIPEDRIVE_SORT_DIRECTION).toBe("asc");
  });

  it("returns the ids sitting ON the watermark, because the boundary is INCLUSIVE", async () => {
    // Pipedrive: "later than or EQUAL TO this time". Feeding the watermark
    // straight back re-reads the boundary rows every tick, forever; adding a
    // millisecond instead silently skips anything written inside it. Returning
    // the ids at the watermark is the only form that is both complete and
    // terminating.
    // Mutation: drop watermarkIds → red. Add a millisecond to the watermark →
    // red on the exact-equality assertion.
    const rows = [
      { id: 1, update_time: "2026-09-01 10:00:00" },
      { id: 2, update_time: "2026-09-02 09:00:00" },
      { id: 3, update_time: "2026-09-02 09:00:00" },
    ];
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ body: page(rows, null) }] }],
    });
    const result = await c.listDataset("deal");
    // The VENDOR's own string, unmodified — it is fed straight back as
    // `updated_since`.
    expect(result.watermark).toBe("2026-09-02 09:00:00");
    expect(result.watermarkIds).toEqual(["2", "3"]);
  });

  it("refuses a query parameter this connector is not entitled to send", () => {
    // The silent-ignore failure, closed at request time rather than asserted in
    // a test: an invented `modified_since` would be a full scan mislabelled as
    // a delta.
    // Mutation: delete assertPipedriveSendableParams → red.
    expect(() => assertPipedriveSendableParams({ modified_since: "x" })).toThrow(
      ConnectorBlockedError,
    );
    expect(() => assertPipedriveSendableParams({ [PIPEDRIVE_DELTA_PARAM]: "x" })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The activities `type` trap, and the products window absence
// ─────────────────────────────────────────────────────────────────────────────

describe("vendor parameter facts that fail silently", () => {
  it("refuses `type` on activities — it is a request BODY field, never a v2 query parameter", () => {
    // The highest-damage failure this vendor offers. `?type=call` is not an
    // error: Pipedrive ignores it and returns the ENTIRE activity stream, so a
    // connector that believed it was fetching calls would quietly ingest
    // everything. `type` appears only as a POST/PATCH body field.
    //
    // The complete documented v2 query-parameter list for
    // GET /api/v2/activities — https://developers.pipedrive.com/docs/api/v1/Activities
    // — is filter_id, ids, owner_id, deal_id, lead_id, person_id, org_id, done,
    // updated_since, updated_until, sort_by, sort_direction, include_fields,
    // limit, cursor. `type` is not in it.
    //
    // Mutation: add "type" to PIPEDRIVE_ACTIVITY_QUERY_PARAMS → red.
    expect(PIPEDRIVE_ACTIVITY_QUERY_PARAMS.has("type")).toBe(false);
    expect(() => assertPipedriveActivityParams({ type: "call" })).toThrow(ConnectorBlockedError);
    // The parameters that ARE documented, including the two the first spec pass
    // omitted.
    for (const p of [
      "filter_id",
      "ids",
      "owner_id",
      "deal_id",
      "lead_id",
      "person_id",
      "org_id",
      "done",
      "updated_since",
      "updated_until",
      "sort_by",
      "sort_direction",
      "include_fields",
      "limit",
      "cursor",
    ]) {
      expect(PIPEDRIVE_ACTIVITY_QUERY_PARAMS.has(p), p).toBe(true);
    }
    expect(PIPEDRIVE_ACTIVITY_QUERY_PARAMS.size).toBe(15);
  });

  it("still maps activity `type` from the RESPONSE, which is where it does exist", async () => {
    // The distinction the guard above is about: a query parameter Pipedrive
    // ignores versus a response field it really sends.
    // Mutation: drop the `type` case from the mapper → red.
    const row = await projectThrough("engagement", {
      id: 7,
      type: "call",
      marked_as_done_time: "2026-09-02 09:30:00",
    });
    expect(row.type).toBe("call");
  });

  it("runs BOTH parameter guards before the wire, activities-specific first", async () => {
    // The wiring, not just the functions. Reaching past `private` is deliberate:
    // `listDataset` cannot express an invented parameter (which is the point of
    // its signature), so the only way to observe that `request` guards its query
    // string at all is to call it with one.
    //
    // Order matters and is asserted, not assumed: every sendable parameter is
    // also a documented activities parameter, so a sendable-first order would
    // make the activities guard unreachable — a guard that cannot fire reads as
    // coverage while providing none.
    //
    // Mutation: drop either guard from request(), or run sendable first → red,
    // and red on the zero-fetch assertions, which are the halves proving the
    // full scan never happened.
    const { c, f } = connector();
    const reach = c as unknown as {
      request: (op: string, path: string, search: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(
      reach.request("t", PIPEDRIVE_DATASET_ENDPOINTS.engagement, { type: "call" }),
    ).rejects.toThrow(/documented GET \/api\/v2\/activities query parameter/);
    await expect(
      reach.request("t", PIPEDRIVE_DATASET_ENDPOINTS.deal, { modified_since: "2026-09-01" }),
    ).rejects.toThrow(/not a query parameter this connector may send/);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses `updated_until` on products, which document no upper bound", () => {
    // Products carry `updated_since` and NO `updated_until`
    // (https://developers.pipedrive.com/docs/api/v1/Products), where deals,
    // persons, organizations and activities carry both. Sending it anyway would
    // be ignored and a bounded backfill would silently become open-ended —
    // which, against a daily token budget shared with the customer's other
    // integrations, is the scan that spends their whole day of API allowance.
    // Mutation: remove `product` from PIPEDRIVE_DATASETS_WITHOUT_UPPER_BOUND → red.
    expect(PIPEDRIVE_DATASETS_WITHOUT_UPPER_BOUND.has("product")).toBe(true);
    expect(() => assertPipedriveWindow("product", "2026-09-01T00:00:00Z")).toThrow(
      ConnectorBlockedError,
    );
    for (const dataset of ["contact", "company", "deal", "engagement"]) {
      expect(() => assertPipedriveWindow(dataset, "2026-09-01T00:00:00Z"), dataset).not.toThrow();
    }
  });

  it("refuses a bounded product window at the connector boundary, on zero fetch calls", async () => {
    // Mutation: drop the assertPipedriveWindow call from listDataset → red, and
    // red on the zero-fetch assertion.
    const { c, f } = connector();
    await expect(
      c.listDataset("product", { updatedUntil: "2026-09-01T00:00:00Z" }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
    // ...and passes it through for a dataset that documents it.
    const ok = connector({ routes: [{ match: /.*/, responses: [{ body: page([], null) }] }] });
    await ok.c.listDataset("deal", { updatedUntil: "2026-09-01T00:00:00Z" });
    expect(ok.f.params(0).get(PIPEDRIVE_WINDOW_END_PARAM)).toBe("2026-09-01T00:00:00Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

describe("cursor pagination", () => {
  it("follows additional_data.next_cursor and stops when it is null", async () => {
    // Pipedrive: "The value of the next_cursor field will be null if you have
    // reached the end of the dataset and there are no more pages to be
    // returned." (https://pipedrive.readme.io/docs/core-api-concepts-pagination)
    // Mutation: read the cursor from the response root instead of
    // additional_data → red (one page, then a wrong stop).
    const { c, f } = connector({
      routes: [
        {
          match: /.*/,
          responses: [
            { body: page([{ id: 1 }, { id: 2 }], "cur1") },
            { body: page([{ id: 3 }], "cur2") },
            { body: page([{ id: 4 }], null) },
          ],
        },
      ],
    });
    const result = await c.listDataset("contact");
    expect(result.rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(f.calls).toHaveLength(3);
    // The first request carries no cursor; the next two carry the previous
    // page's marker.
    expect(f.params(0).get("cursor")).toBeNull();
    expect(f.params(1).get("cursor")).toBe("cur1");
    expect(f.params(2).get("cursor")).toBe("cur2");
  });

  it("stops on a missing additional_data envelope rather than looping", async () => {
    // A response that omits the envelope means there is no next page. Treating
    // a missing envelope as "keep going" is an infinite loop that looks like a
    // slow sync.
    // Mutation: default a missing envelope to a truthy cursor → red (or hang).
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: { success: true, data: [{ id: 1 }] } }] }],
    });
    const result = await c.listDataset("deal");
    expect(result.rows).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
  });

  it("refuses a NON-ADVANCING cursor instead of walking forever", async () => {
    // A vendor that echoed the same cursor back would otherwise be an infinite
    // loop that looks like a slow sync, and each turn of it spends the
    // customer's daily token budget.
    // Mutation: drop the `next === cursor` check → the test hangs until the
    // page ceiling, which is the failure mode this makes loud.
    const { c, f } = connector({
      routes: [
        {
          match: /.*/,
          responses: [{ body: page([{ id: 1 }], "same") }, { body: page([{ id: 2 }], "same") }],
        },
      ],
    });
    await expect(c.listDataset("contact")).rejects.toThrow(ConnectorBlockedError);
    expect(f.calls).toHaveLength(2);
  });

  it("refuses a non-array `data` rather than guessing at a shape", async () => {
    // Mutation: coerce a non-array to [] → red, and a real contract change
    // would then read as "this account has no contacts".
    const { c } = connector({
      routes: [
        { match: /.*/, responses: [{ body: { data: { id: 1 }, additional_data: {} } }] },
      ],
    });
    await expect(c.listDataset("contact")).rejects.toThrow(ConnectorBlockedError);
  });

  it("clamps `limit` to Pipedrive's documented maximum and default", async () => {
    // limit: default 100, maximum 500 (core-api-concepts-pagination). Asking
    // for more is a 400 from the vendor, and asking for zero is a walk that
    // never finishes.
    // Mutation: drop the clamp → red.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    await c.listDataset("deal", { pageSize: 5000 });
    expect(f.params(0).get("limit")).toBe(String(PIPEDRIVE_MAX_PAGE_SIZE));
    const low = connector({ routes: [{ match: /.*/, responses: [{ body: page([], null) }] }] });
    await low.c.listDataset("deal", { pageSize: 0 });
    expect(low.f.params(0).get("limit")).toBe("1");
    const dflt = connector({ routes: [{ match: /.*/, responses: [{ body: page([], null) }] }] });
    await dflt.c.listDataset("deal");
    expect(dflt.f.params(0).get("limit")).toBe(String(PIPEDRIVE_DEFAULT_PAGE_SIZE));
    expect(PIPEDRIVE_MAX_PAGE_SIZE).toBe(500);
    expect(PIPEDRIVE_DEFAULT_PAGE_SIZE).toBe(100);
  });

  it("uses no offset parameter anywhere — `start` was removed in v2", () => {
    // Migration guide: "Offset based pagination (`start` & `limit`) has been
    // replaced with cursor based pagination (`cursor` & `limit`)".
    // Mutation: add `start` to the sendable set → red.
    expect(PIPEDRIVE_SENDABLE_QUERY_PARAMS.has("start")).toBe(false);
    expect(PIPEDRIVE_SENDABLE_QUERY_PARAMS.has("offset")).toBe(false);
    expect(PIPEDRIVE_SENDABLE_QUERY_PARAMS.has("cursor")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical projection, including money
// ─────────────────────────────────────────────────────────────────────────────

describe("canonical projection", () => {
  it("writes EXACTLY the canonical column set for every dataset — no vendor fields leak", async () => {
    // A Pipedrive person carries every custom field the business ever created,
    // keyed by opaque hashes, plus picture URLs and owner records. A mapper
    // written as `{ ...person, ... }` persists all of it onto the box.
    // Mutation: spread the vendor record into the row → red on every dataset.
    const fixtures: Record<string, Record<string, unknown>> = {
      contact: { id: 1, first_name: "Ada", custom_9f8e: "secret", picture_id: { url: "x" } },
      company: { id: 2, name: "Acme", address: "1 High St", owner_id: { id: 3 } },
      deal: { id: 4, title: "Roof", stage_id: 7, value: 10, currency: "EUR" },
      engagement: { id: 5, type: "call", marked_as_done_time: "2026-09-02 09:30:00" },
      product: { id: 6, name: "Widget", code: "W-1" },
    };
    for (const dataset of PIPEDRIVE_DATASETS) {
      const row = await projectThrough(dataset, fixtures[dataset]);
      expect(Object.keys(row).sort(), dataset).toEqual([...CANONICAL_COLUMNS[dataset]].sort());
    }
  });

  it("maps money as a DECIMAL in MAJOR units — never multiplied, never divided", async () => {
    // Pipedrive states deal `value` in MAJOR units already: a deal worth twelve
    // dollars thirty-four is `12.34`, not `1234`. Unlike Stripe's minor-unit
    // integers there is no conversion to perform, so the failure this pins is a
    // conversion that gets ADDED — a `/100` here is a 100x understatement of a
    // customer's whole pipeline, and a `*100` is a 100x overstatement.
    // Mutation: divide or multiply in pipedriveMajorUnits → red on both cases.
    const row = await projectThrough("deal", {
      id: 4,
      title: "Roof",
      stage_id: 7,
      value: 1234.56,
      currency: "EUR",
    });
    expect(row.amount).toBe(1234.56);
    expect(row.currency).toBe("EUR");
    // An integer value is a whole number of MAJOR units, not cents.
    const whole = await projectThrough("deal", {
      id: 5,
      title: "Fence",
      stage_id: 7,
      value: 1234,
      currency: "GBP",
    });
    expect(whole.amount).toBe(1234);
    expect(whole.amount).not.toBe(12.34);
    // The boundary function is the single place a units decision is made.
    expect(pipedriveMajorUnits(12.34)).toBe(12.34);
    expect(pipedriveMajorUnits("1,234.56")).toBe(1234.56);
    expect(pipedriveMajorUnits(undefined)).toBeUndefined();
    expect(pipedriveMajorUnits("")).toBeUndefined();
    // Absent money and zero money are different facts.
    expect(pipedriveMajorUnits(0)).toBe(0);
  });

  it("emits a money amount ONLY alongside its currency", async () => {
    // An amount whose currency has to be guessed is not a number, and summing
    // one into a total is how a revenue figure comes out wrong with nothing to
    // point at.
    // Mutation: return the amount regardless of currency → red.
    const row = await projectThrough("deal", { id: 4, title: "Roof", stage_id: 7, value: 999 });
    expect(row.amount).toBeUndefined();
    expect(row.currency).toBeUndefined();
    expect(pipedriveMoneyPair(999, "")).toEqual({ amount: undefined, currency: undefined });
    expect(pipedriveMoneyPair(999, "EUR")).toEqual({ amount: 999, currency: "EUR" });
    // Every money column in every dataset this track serves has a `currency`
    // sibling in the vocabulary — the property the pairing rule protects.
    for (const dataset of PIPEDRIVE_DATASETS) {
      const money = CANONICAL_COLUMNS[dataset].filter((c) => COLUMN_KIND[c] === "money");
      if (money.length > 0) {
        expect(CANONICAL_COLUMNS[dataset], dataset).toContain("currency");
      }
    }
  });

  it("takes a product price from `prices` with its own currency, never an assumed one", async () => {
    // Pipedrive lets ONE product carry a price per currency and the product
    // object has no default to pick between them. The first PRICED entry wins,
    // deterministically, and an entry with no currency is skipped rather than
    // defaulted.
    // Mutation: read `prices[0].price` unconditionally → red on the
    // currency-less first entry.
    const row = await projectThrough("product", {
      id: 6,
      name: "Widget",
      code: "W-1",
      prices: [{ price: 5 }, { price: 12.5, currency: "USD" }, { price: 11, currency: "EUR" }],
    });
    expect(row.price_amount).toBe(12.5);
    expect(row.currency).toBe("USD");
    expect(selectPipedrivePrice({ prices: [] })).toBeUndefined();
    expect(selectPipedrivePrice({})).toBeUndefined();
  });

  it("normalises Pipedrive's space-separated UTC timestamps before comparing them", async () => {
    // Pipedrive emits `2026-09-01 10:20:00` — a space, no zone marker, UTC.
    // `Date.parse` on that form is implementation-defined and several engines
    // read it as LOCAL time, which shifts every value by the box's UTC offset.
    // On `updated_at` that is not cosmetic: the watermark comparison either
    // re-reads hours of rows every tick or skips them, silently.
    // Mutation: pass the raw string to canonicalInstant → red on any machine
    // whose TZ is not UTC, which is the bug this exists to make deterministic.
    expect(pipedriveInstant("2026-09-01 10:20:00")).toBe("2026-09-01T10:20:00.000Z");
    expect(pipedriveInstant("2026-09-01T10:20:00Z")).toBe("2026-09-01T10:20:00.000Z");
    expect(pipedriveInstant("")).toBeUndefined();
    expect(pipedriveInstant(null)).toBeUndefined();
    const row = await projectThrough("company", {
      id: 2,
      name: "Acme",
      add_time: "2026-08-01 08:00:00",
      update_time: "2026-09-01 10:20:00",
    });
    expect(row.created_at).toBe("2026-08-01T08:00:00.000Z");
    expect(row.updated_at).toBe("2026-09-01T10:20:00.000Z");
  });

  it("places an activity when it HAPPENED, not when the record was written", async () => {
    // `occurred_at` is the event time. A meeting logged the next morning
    // happened the day before, and a timeline sorted by write time reorders
    // history.
    // Mutation: fall back to `update_time` → red on the third case, which is
    // the one that must stay empty.
    expect(
      pipedriveActivityInstant({
        marked_as_done_time: "2026-09-02 09:30:00",
        due_date: "2026-09-05",
        update_time: "2026-09-03 11:00:00",
      }),
    ).toBe("2026-09-02T09:30:00.000Z");
    // Not yet done: its place on the timeline is when it is due.
    expect(pipedriveActivityInstant({ due_date: "2026-09-05", due_time: "14:30" })).toBe(
      "2026-09-05T14:30:00.000Z",
    );
    // Date with no time: the start of that date in UTC is the only instant the
    // vendor supplies.
    expect(pipedriveActivityInstant({ due_date: "2026-09-05" })).toBe("2026-09-05T00:00:00.000Z");
    // Neither: no honest occurred_at, and REQUIRED_CANONICAL wants one.
    expect(pipedriveActivityInstant({ update_time: "2026-09-03 11:00:00" })).toBeUndefined();
    expect(REQUIRED_CANONICAL.engagement).toContain("occurred_at");
  });

  it("prefers a person's PRIMARY email over the first one entered", async () => {
    // The primary is the address the business actually writes to; `[0]` is
    // whichever was typed first, and the two differ often enough to matter.
    // Mutation: read `emails[0].value` → red.
    const row = await projectThrough("contact", {
      id: 1,
      first_name: "Ada",
      last_name: "Lovelace",
      emails: [
        { value: "old@example.test", primary: false },
        { value: "ada@example.test", primary: true },
      ],
    });
    expect(row.email).toBe("ada@example.test");
    // A list with no primary flag still yields an address rather than nothing.
    expect(selectPipedrivePrimaryValue([{ value: "only@example.test" }])).toBe(
      "only@example.test",
    );
    expect(selectPipedrivePrimaryValue(undefined)).toBeUndefined();
    expect(selectPipedrivePrimaryValue([])).toBeUndefined();
  });

  it("maps a deal's ACTUAL close time, never its expected close date", async () => {
    // Putting a salesperson's forecast in a column named `closed_at` is how a
    // pipeline report starts reporting things that have not happened.
    // Mutation: fall back to `expected_close_date` → red.
    const row = await projectThrough("deal", {
      id: 4,
      title: "Roof",
      stage_id: 7,
      expected_close_date: "2026-12-01",
      close_time: "2026-09-02 16:00:00",
    });
    expect(row.closed_at).toBe("2026-09-02T16:00:00.000Z");
    const open = await projectThrough("deal", {
      id: 5,
      title: "Fence",
      stage_id: 7,
      expected_close_date: "2026-12-01",
    });
    expect(open.closed_at).toBeUndefined();
  });

  it("keeps the vendor's stage IDENTIFIER, which is the only stable thing to filter on", async () => {
    // Pipedrive stage names are per-pipeline and renameable; the id is not.
    // Mutation: map a stage NAME → red, and a customer renaming a stage would
    // silently empty every stage-filtered read.
    const row = await projectThrough("deal", { id: 4, title: "Roof", stage_id: 7 });
    expect(row.stage).toBe("7");
    expect(REQUIRED_CANONICAL.deal).toContain("stage");
  });

  it("leaves the DECLARED unreconciled columns empty, and nothing else", async () => {
    // Three canonical columns have no Pipedrive source at all. They are
    // declared rather than discovered one confusing empty column at a time, and
    // this asserts the declaration matches what the mappers actually do — in
    // both directions, so a mapper that silently stopped populating a column
    // goes red rather than joining the list by accident.
    // Mutation: add a column to PIPEDRIVE_UNRECONCILED_COLUMNS without removing
    // its mapper case, or drop a mapper case without declaring it → red.
    const populated: Record<string, Record<string, unknown>> = {
      contact: {
        id: 1,
        add_time: "2026-08-01 08:00:00",
        update_time: "2026-09-01 10:00:00",
        first_name: "Ada",
        last_name: "Lovelace",
        emails: [{ value: "ada@example.test", primary: true }],
        org_id: 2,
        lifecycle_stage: "customer",
      },
      company: {
        id: 2,
        add_time: "2026-08-01 08:00:00",
        update_time: "2026-09-01 10:00:00",
        name: "Acme",
        domain: "acme.test",
      },
      deal: {
        id: 4,
        add_time: "2026-08-01 08:00:00",
        update_time: "2026-09-01 10:00:00",
        close_time: "2026-09-02 16:00:00",
        org_id: 2,
        title: "Roof",
        stage_id: 7,
        value: 100,
        currency: "EUR",
      },
      engagement: {
        id: 5,
        update_time: "2026-09-01 10:00:00",
        marked_as_done_time: "2026-09-02 09:30:00",
        type: "call",
        person_id: 1,
        deal_id: 4,
      },
      product: {
        id: 6,
        add_time: "2026-08-01 08:00:00",
        update_time: "2026-09-01 10:00:00",
        name: "Widget",
        code: "W-1",
        prices: [{ price: 12.5, currency: "USD" }],
        active_flag: true,
        inventory_quantity: 99,
      },
    };
    for (const dataset of PIPEDRIVE_DATASETS) {
      const row = await projectThrough(dataset, populated[dataset]);
      const declared = new Set(PIPEDRIVE_UNRECONCILED_COLUMNS[dataset]);
      for (const column of CANONICAL_COLUMNS[dataset]) {
        if (declared.has(column)) {
          // Declared absent: even a vendor payload that carries a same-named
          // key must not produce a value, because the vendor field is not the
          // canonical fact.
          expect(row[column], `${dataset}.${column}`).toBeUndefined();
        } else {
          expect(row[column], `${dataset}.${column}`).toBeDefined();
        }
      }
    }
    expect(PIPEDRIVE_UNRECONCILED_COLUMNS.product).toEqual(["inventory_quantity"]);
    expect(PIPEDRIVE_UNRECONCILED_COLUMNS.contact).toEqual(["lifecycle_stage"]);
    expect(PIPEDRIVE_UNRECONCILED_COLUMNS.company).toEqual(["domain"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reads, refusals and the never-empty contract
// ─────────────────────────────────────────────────────────────────────────────

describe("named reads", () => {
  it("REFUSES get_low_stock_products rather than answering `nothing is low` — zero fetch calls", async () => {
    // Pipedrive's catalog has no inventory, variant or fulfilment concept at
    // all. Answering this read from an empty column produces a confident false
    // statement about a business's supply that no caller can tell apart from a
    // genuinely well-stocked catalog — the same class of failure
    // DatasetNotServedError exists for, one level down at the column.
    // Mutation: delete the refusal and let it return rows → red, and red on the
    // zero-fetch assertion.
    const { c, f } = connector();
    await expect(c.runRead("get_low_stock_products", { threshold: 5 })).rejects.toBeInstanceOf(
      PipedriveColumnNotAvailableError,
    );
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a read whose dataset this track does not serve, before any I/O", async () => {
    // A Pipedrive connection has no invoices and never will. That is not a
    // fault and must not be reported as one, and `[]` from get_open_invoices
    // reads as "you are owed nothing".
    // Mutation: drop assertDatasetsServed → red.
    const { c, f } = connector();
    await expect(c.runRead("get_open_invoices", {})).rejects.toBeInstanceOf(DatasetNotServedError);
    expect(f.calls).toHaveLength(0);
  });

  it("pushes `since` down to the vendor as the delta parameter rather than filtering locally", async () => {
    // Filtering after the fetch would read the whole collection every tick and
    // report it as an incremental sync — the exact cost the delta exists to
    // avoid.
    // Mutation: drop `since` from enumerate → red.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    await c.runRead("find_contact", { since: "2026-09-01T00:00:00Z", query: "lov" });
    // In the form Pipedrive's own filter documentation shows —
    // `2025-01-01T10:20:00Z`, whole seconds. `canonicalInstant` renders
    // milliseconds because that is the canonical ROW form, and a canonical row
    // is not a wire value; nothing here was exercised against a live tenant, so
    // the connector sends the documented form rather than one that ought to
    // work.
    // Mutation: send `canonicalInstant(since)` straight through → red (the
    // `.000` comes back).
    expect(f.params(0).get(PIPEDRIVE_DELTA_PARAM)).toBe("2026-09-01T00:00:00Z");
  });

  it("filters find_contact by last-name prefix and orders by last then first name", async () => {
    // Mutation: filter on first_name, or drop the ordering → red.
    const { c } = connector({
      routes: [
        {
          match: /.*/,
          responses: [
            {
              body: page(
                [
                  { id: 1, first_name: "Ada", last_name: "Lovelace" },
                  { id: 2, first_name: "Alan", last_name: "Turing" },
                  { id: 3, first_name: "Aaron", last_name: "Lovelace" },
                ],
                null,
              ),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("find_contact", { query: "lov" })) as Record<string, unknown>[];
    expect(rows.map((r) => r.contact_id)).toEqual(["3", "1"]);
  });

  it("orders get_deals_by_stage by amount descending", async () => {
    // Mutation: sort ascending, or reverse the array (which would also reverse
    // the id tiebreak) → red.
    const { c } = connector({
      routes: [
        {
          match: /.*/,
          responses: [
            {
              body: page(
                [
                  { id: 1, title: "A", stage_id: 7, value: 10, currency: "EUR" },
                  { id: 2, title: "B", stage_id: 7, value: 90, currency: "EUR" },
                  { id: 3, title: "C", stage_id: 9, value: 50, currency: "EUR" },
                ],
                null,
              ),
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_deals_by_stage", { stage: "7" })) as Record<
      string,
      unknown
    >[];
    expect(rows.map((r) => r.deal_id)).toEqual(["2", "1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read-only
// ─────────────────────────────────────────────────────────────────────────────

describe("read-only", () => {
  it("refuses every write, after the same validation every other track runs", async () => {
    // A Pipedrive API token is full account access at its owning user's
    // permission level, with no read-only variant at any plan tier, so this
    // refusal is the only boundary between an agent and a customer's sales
    // system of record.
    // Mutation: implement any write path → red.
    const { c, f } = connector();
    await expect(
      c.applyWrite("reschedule_appointment", { apptId: "1", newTime: "2026-09-04T09:00:00Z" }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("issues GET and nothing else, on every path it dials", async () => {
    // Everything Pipedrive mutates is a POST, PUT, PATCH or DELETE on the same
    // nouns this connector reads, so read-only here is a property of the METHOD
    // as much as of the path.
    // Mutation: any non-GET → red.
    const { c, f } = connector({
      routes: [{ match: /.*/, responses: [{ body: { success: true, data: {} } }] }],
    });
    await c.verifyCompanyDomain();
    for (const call of f.calls) {
      expect(call.init.method).toBe("GET");
    }
  });

  it("refuses a search path by shape — that budget is a different, lower one", () => {
    // Search endpoints are capped at 10 requests / 2 s on EVERY plan and both
    // auth methods, which is not the ceiling the burst governor models. Every
    // dataset here is enumerable through its own collection endpoint, so
    // refusing the segment costs no capability at all.
    // Mutation: drop the forbidden-segment check → red, and a `deals` path
    // would sail past the resource allowlist.
    expect(() =>
      assertReadablePipedrivePath(`${PIPEDRIVE_API_BASE_PATH}/deals/search`),
    ).toThrow(ConnectorBlockedError);
    expect(() =>
      assertReadablePipedrivePath(`${PIPEDRIVE_API_BASE_PATH}/persons/search`),
    ).toThrow(ConnectorBlockedError);
    expect(PIPEDRIVE_FORBIDDEN_PATH_SEGMENT).toBe("search");
  });

  it("admits `/api/v1/users/me` EXACTLY, and no other v1 path", () => {
    // The carve-out, and it is not a fallback: GET /users/me has no v2 form
    // (https://developers.pipedrive.com/docs/api/v1/Users) and Users was never
    // in the deprecated set, which covers Activities, Deals, Persons,
    // Organizations, Products, Pipelines, Stages and Search only. A connector
    // that applied "v2 only" absolutely would 404 on every connect attempt.
    // Mutation: widen the carve-out to any /api/v1/ path → red on the second
    // case, and a dead v1 dataset path would be reachable again.
    expect(() => assertReadablePipedrivePath(PIPEDRIVE_USERS_ME_PATH)).not.toThrow();
    expect(() => assertReadablePipedrivePath("/api/v1/deals")).toThrow(ConnectorBlockedError);
    expect(() => assertReadablePipedrivePath("/api/v1/users")).toThrow(ConnectorBlockedError);
    expect(() => assertReadablePipedrivePath("/v1/deals")).toThrow(ConnectorBlockedError);
    expect(PIPEDRIVE_USERS_ME_PATH).toBe("/api/v1/users/me");
  });

  it("refuses a resource that is not on the allowlist", () => {
    // An allowlist at the point of use, not a denylist in source: request paths
    // are assembled at runtime, so a denylist only catches the literals someone
    // happened to type.
    // Mutation: replace the allowlist with a denylist → red.
    expect(() => assertReadablePipedrivePath(`${PIPEDRIVE_API_BASE_PATH}/webhooks`)).toThrow(
      ConnectorBlockedError,
    );
    expect(() => assertReadablePipedrivePath(`${PIPEDRIVE_API_BASE_PATH}/deals`)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Honest degradation — nothing wired means nothing half-authenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("honest degradation with no credential", () => {
  it("blocks every I/O method and makes ZERO fetch calls", async () => {
    // ADR-041 §2: the connector ships off, and owner consent is the enabling
    // event. Half-authenticating — dialling with no token to see what happens —
    // would leak the tenant's existence and produce an error nobody can triage.
    // Mutation: default the resolver to anything other than the blocked one →
    // red on all five, and red on the zero-fetch assertion.
    const { c, f } = connector({ blocked: true });
    await expect(c.connect()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listDataset("deal")).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.runRead("find_contact", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.verifyCompanyDomain()).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("reports `disconnected`, not `connected`, when nothing is wired", async () => {
    // An absent value defaulted into "connected" is the
    // looks-connected-syncs-nothing failure ADR-041 §5 exists to prevent.
    // Mutation: derive `ok` independently of `state` → red.
    const { c } = connector({ blocked: true });
    const status = await c.status();
    expect(status.state).toBe("disconnected");
    expect(status.ok).toBe(false);
    expect(status.hasApiToken).toBe(false);
  });

  it("names what is missing, and names PIPEDRIVE's requirement rather than another track's", async () => {
    // WARP-1964: an export-drop failure once told an installer to install the
    // SAP SQL Anywhere driver.
    // Mutation: drop the per-track remediation → red.
    const { c } = connector({ blocked: true });
    try {
      await c.listDataset("deal");
      expect.unreachable("should have thrown");
    } catch (err) {
      const blocked = err as ConnectorBlockedError;
      expect(blocked.remediation).toContain("Pipedrive");
      expect(blocked.remediation).toContain("company domain");
      expect(blocked.remediation).toContain("allowed-egress.yaml");
      expect(blocked.remediation).not.toContain("SQL Anywhere");
    }
  });

  it("carries no token in `status()`", async () => {
    // Mutation: add the token to the status object → red.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ body: page([], null) }] }],
    });
    await c.listDataset("deal");
    const status = await c.status();
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(status.hasApiToken).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vendor errors: the CODE reaches the caller, the MESSAGE does not
// ─────────────────────────────────────────────────────────────────────────────

describe("vendor errors", () => {
  it("surfaces the vendor's error CODE plus the status, never the vendor's message", async () => {
    // Pipedrive's `error` and `error_info` strings quote request state back —
    // parameter names, offered values, sometimes the offending field — and on
    // this track request state is the customer's CRM data. A propagated vendor
    // message ends up in every log line that renders the error.
    // Mutation: propagate body.error → red on the two `not.toContain` lines,
    // which are the ones that matter.
    const { c } = connector({
      routes: [
        {
          match: /.*/,
          responses: [
            {
              status: 400,
              body: {
                success: false,
                error: "Invalid cursor for person ada@example.test at org Acme Roofing Ltd",
                error_info: "Please check https://developers.pipedrive.com",
                errorCode: "invalid_cursor",
              },
            },
          ],
        },
      ],
    });
    try {
      await c.listDataset("contact");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipedriveApiError);
      const api = err as PipedriveApiError;
      expect(api.vendorCode).toBe("invalid_cursor");
      expect(api.status).toBe(400);
      expect(api.message).toContain("invalid_cursor");
      expect(api.message).toContain("400");
      expect(api.message).not.toContain("ada@example.test");
      expect(api.message).not.toContain("Acme Roofing Ltd");
      expect(api.message).not.toContain("Invalid cursor");
    }
  });

  it("falls back to `http_<status>` when the body carries no recognisable code", async () => {
    // The honest floor: the status is a fact about the exchange, not about the
    // customer. Inventing a code, or reaching for the message because there was
    // no code, is what this closes.
    // Mutation: fall back to body.error → red.
    const { c } = connector({
      routes: [
        {
          match: /.*/,
          responses: [{ status: 502, body: { success: false, error: "upstream said no" } }],
        },
      ],
    });
    await expect(c.listDataset("deal")).rejects.toMatchObject({
      code: "PIPEDRIVE_API_ERROR",
      vendorCode: "http_502",
      status: 502,
    });
  });

  it("reads a NUMERIC vendor code as well as a string one", async () => {
    // v1 sent `errorCode` as a number and v2's shape was not verified against a
    // live tenant, so both are read and neither is invented.
    // Mutation: accept only strings → red, and every numeric code would render
    // as http_<status>, losing the vendor's own classification.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ status: 400, body: { errorCode: 41 } }] }],
    });
    await expect(c.listDataset("deal")).rejects.toMatchObject({ vendorCode: "41" });
  });

  it("treats 401 as re-authorization, distinctly from a capability limit", async () => {
    // The remedies differ and only one of them is worth the customer's time.
    // Pipedrive allows exactly ONE active token per user per company, so
    // anyone generating a new one for another tool has already invalidated
    // this one — which the message says, because it is the usual cause.
    // Mutation: fold 401 into the generic API error → red.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ status: 401, body: {} }] }],
    });
    await expect(c.listDataset("deal")).rejects.toBeInstanceOf(
      PipedriveReauthorizationRequiredError,
    );
  });

  it("RECORDS a 401 in the connection state, so health() stops reporting ok", async () => {
    // The looks-connected-syncs-nothing shape ADR-041 §5 exists to prevent. A
    // 401 that only threw left `state()` at "connected", `status().ok` true and
    // `health()` returning `{ok:true}` for a token Pipedrive was refusing on
    // every single call — so an operator triaging a sync that produces nothing
    // would be told by every state surface that the connection is fine.
    // Mutation: delete the `this.probe = { state: "unauthorized" ... }`
    // assignment in the 401 branch of request() → green throw, red on all four
    // state assertions below. Rank `unauthorized` after `forbidden` in state()
    // → still red, because only a new token helps here.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ status: 401, body: {} }] }],
    });
    await expect(c.listDataset("deal")).rejects.toBeInstanceOf(
      PipedriveReauthorizationRequiredError,
    );
    const status = await c.status();
    expect(status.domainProbe.state).toBe("unauthorized");
    expect(status.state).toBe("needs_reconnect");
    expect(status.ok).toBe(false);
    await expect(c.health()).rejects.toBeInstanceOf(PipedriveReauthorizationRequiredError);
  });

  it("clears the 401 state when the account verifies again, rather than latching", async () => {
    // The other half: a recorded rejection that no successful call could clear
    // would be a connector that has to be rebuilt to recover, and an owner who
    // pasted a working token would still be told to reconnect. Reconnecting
    // runs verifyCompanyDomain, so that is where the state clears.
    // Mutation: never reset the probe on a successful verify → red.
    const { c } = connector({
      routes: [
        {
          match: /users\/me/,
          responses: [{ body: { success: true, data: { company_domain: DOMAIN } } }],
        },
        { match: /.*/, responses: [{ status: 401, body: {} }] },
      ],
    });
    await expect(c.listDataset("deal")).rejects.toBeInstanceOf(
      PipedriveReauthorizationRequiredError,
    );
    expect((await c.status()).state).toBe("needs_reconnect");
    await c.connect();
    const status = await c.status();
    expect(status.domainProbe.state).toBe("ok");
    expect(status.state).toBe("connected");
    expect((await c.health()).ok).toBe(true);
  });

  it("treats 403 as a capability limit and names the permission-set toggle", async () => {
    // If a user's permission set lacks API access, Pipedrive's own API settings
    // page simply does not appear — no error, no explanation — and an
    // administrator has to enable it. A customer cannot diagnose that from
    // "forbidden", and creating a new token will not fix it.
    // Mutation: fold 403 into re-authorization → red, and the customer would
    // spend their afternoon regenerating tokens.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ status: 403, body: {} }] }],
    });
    try {
      await c.listDataset("deal");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipedriveCapabilityMissingError);
      expect((err as Error).message).toContain("Permission sets");
    }
  });

  it("never renders a failure as an empty result", async () => {
    // ADR-041's never-empty contract: every one of these states must throw
    // rather than return [], because `[]` from a CRM read is "you have no
    // customers", which is both false and unfalsifiable from the outside.
    // Mutation: catch-and-return-[] anywhere in the request path → red.
    for (const status of [401, 403, 400, 500, 502]) {
      const { c } = connector({
        routes: [{ match: /.*/, responses: [{ status, body: {} }] }],
      });
      await expect(c.listDataset("contact"), String(status)).rejects.toBeTruthy();
    }
  });

  it("reports an unparseable body rather than an empty page", async () => {
    // Mutation: return {} on a JSON parse failure → red, and a broken proxy
    // would read as an empty CRM.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ bad: true }] }],
    });
    await expect(c.listDataset("contact")).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("reports a timeout as its own named state", async () => {
    // A timeout that returned [] would tell the owner their pipeline is empty,
    // which is both false and unfalsifiable.
    // Mutation: fold the timeout into "unreachable" → red.
    const { c } = connector({
      timeoutMs: 5,
      fetchImpl: () => new Promise<Response>(() => undefined),
    });
    await expect(c.listDataset("deal")).rejects.toBeInstanceOf(PipedriveTimeoutError);
  });

  it("leaks the token in no error on any failure path", async () => {
    // Rule 19: never log a captured secret, and an error message is a log line
    // waiting to happen.
    // Mutation: interpolate the token or the built URL into any error → red.
    for (const status of [400, 401, 403, 500]) {
      const { c } = connector({
        routes: [{ match: /.*/, responses: [{ status, body: { error: "no" } }] }],
      });
      try {
        await c.listDataset("deal");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message, String(status)).not.toContain(TOKEN);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The company domain, which the customer can change without telling anyone
// ─────────────────────────────────────────────────────────────────────────────

describe("company-domain verification", () => {
  it("verifies the domain at /api/v1/users/me, against the customer's OWN host", async () => {
    // Not api.pipedrive.com, which Pipedrive documents for this call: the
    // connect flow has already collected the domain, so there is no bootstrap
    // problem to solve and no second destination to register. One guarded host.
    // Mutation: dial api.pipedrive.com → red here AND red on the
    // no-scheme-literal test AND red in egress-gate.
    const { c, f } = connector({
      routes: [
        { match: /.*/, responses: [{ body: { success: true, data: { company_domain: DOMAIN } } }] },
      ],
    });
    const probe = await c.verifyCompanyDomain();
    expect(probe.state).toBe("ok");
    expect(new URL(f.calls[0].url).hostname).toBe(HOST);
    expect(f.paths()).toEqual([PIPEDRIVE_USERS_ME_PATH]);
  });

  it("refuses when the account reports a DIFFERENT company domain", async () => {
    // A company domain is changed from Pipedrive's own account settings and
    // nothing notifies an integration; the documented effect is that "all
    // previous domains and Bcc addresses will no longer be valid and usable"
    // (https://support.pipedrive.com/en/article/changing-a-company-domain-in-pipedrive).
    // So a stored domain goes stale silently.
    // Mutation: log the mismatch and carry on → red.
    const { c } = connector({
      routes: [
        {
          match: /.*/,
          responses: [{ body: { success: true, data: { company_domain: "acme-sales-new" } } }],
        },
      ],
    });
    await expect(c.verifyCompanyDomain()).rejects.toBeInstanceOf(
      PipedriveCompanyDomainChangedError,
    );
    const status = await c.status();
    expect(status.state).toBe("needs_reconnect");
    expect(status.domainProbe.state).toBe("changed");
  });

  it("does not claim a match it did not see", async () => {
    // A response with no `company_domain` proves the token works and says
    // nothing about the domain. Reporting "ok" for the token while implying the
    // domain was checked is the kind of small lie that costs an afternoon.
    // Mutation: throw when the field is absent → red (a working token would be
    // refused); claim `changed` → red.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ body: { success: true, data: { id: 1 } } }] }],
    });
    const probe = await c.verifyCompanyDomain();
    expect(probe.state).toBe("ok");
  });

  it("starts `unverified`, which is a first-class value and not a null", async () => {
    // Mutation: default the probe to "ok" → red, and a stale domain would look
    // verified until the first read failed.
    const { c } = connector();
    const status = await c.status();
    expect(status.domainProbe).toEqual({ state: "unverified" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

describe("the burst governor", () => {
  beforeEach(() => {
    resetPipedriveGovernors();
  });

  it("paces at the documented LITE FLOOR of 20 requests per 2 seconds", async () => {
    // Documented API-token burst per 2s: Lite 20, Growth 40, Premium 100,
    // Ultimate 120 (https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting).
    // The connector cannot see the plan or the seat count, so the floor is the
    // only honest default.
    // Mutation: raise the default ceiling → red.
    expect(PIPEDRIVE_BURST_LIMIT).toBe(20);
    expect(PIPEDRIVE_BURST_WINDOW_MS).toBe(2000);
    const sleeps: number[] = [];
    const gov = new PipedriveBurstGovernor(
      DOMAIN,
      () => NOW,
      async (ms) => {
        sleeps.push(ms);
      },
      2,
      2000,
    );
    await gov.acquire();
    await gov.acquire();
    // The third has to wait: on a frozen clock the window never advances, so
    // the governor sleeps rather than granting.
    await expect(gov.acquire()).rejects.toBeInstanceOf(PipedriveRateLimitedError);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === 2000)).toBe(true);
  });

  it("slides its window rather than resetting it at a boundary", async () => {
    // Whether Pipedrive's own window is fixed or sliding is NOT verified, so
    // the governor implements the one that is safe under either model. The
    // difference is only visible right at a boundary: a FIXED window that reset
    // every 2000ms would grant two more slots at t=2001 for grants taken at
    // t=1999 — four requests inside two milliseconds, twice the ceiling,
    // against a limit that cannot be raised.
    //
    // Mutation: clear `recent` wholesale on a window boundary (a fixed window)
    // → red, because the third acquire would be granted with no sleep.
    let clock = NOW + 1999;
    const sleeps: number[] = [];
    const gov = new PipedriveBurstGovernor(
      DOMAIN,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        // The sleep is what advances the clock, exactly as a real timer would.
        clock += ms;
      },
      2,
      2000,
    );
    await gov.acquire();
    await gov.acquire();
    expect(sleeps).toEqual([]);
    // Past the fixed-window boundary, but only 2ms after the grants above.
    clock = NOW + 2001;
    await gov.acquire();
    // A sliding window made it wait out the remainder of the OLDEST grant's
    // 2000ms, rather than handing out a fresh bucket.
    expect(sleeps).toEqual([1998]);
    expect(clock).toBe(NOW + 3999);
  });

  it("is keyed on the ACCOUNT, so two connections on one tenant share it", () => {
    // The ceiling is per token — per user, per company — so a governor scoped
    // to a connection produces a connector that looks correct and 429s the
    // moment a second connection exists.
    // Mutation: key it on connectionId → red.
    const deps = { now: () => NOW, sleep: async () => undefined };
    const a = pipedriveGovernorFor(DOMAIN, deps);
    const b = pipedriveGovernorFor(DOMAIN, deps);
    const other = pipedriveGovernorFor("other-co", deps);
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("clamps an operator's plan claim to the highest documented ceiling", async () => {
    // `burstCeiling` is an operator statement of fact about a plan this
    // connector cannot see. A value above the highest documented ceiling is a
    // typo, and honouring it would burst against a limit that cannot be raised.
    // Mutation: trust the operator's number → red.
    const { c } = connector({ burstCeiling: 5000, realGovernor: true });
    const status = await c.status();
    expect(status.burstLimit).toBe(PIPEDRIVE_MAX_BURST_CEILING);
    resetPipedriveGovernors();
    const growth = connector({ burstCeiling: 40, realGovernor: true, companyDomain: "growth-co" });
    expect((await growth.c.status()).burstLimit).toBe(40);
  });

  it("retries a 429 on the vendor's own reset hint, then reports rather than looping", async () => {
    // `x-ratelimit-reset` is the authority — no Retry-After is documented — and
    // a local model of the budget cannot be trusted, because the plan
    // multiplier and seat count are facts this connector cannot see.
    // Mutation: retry forever → the suite hangs; ignore the header → red on the
    // sleep assertion.
    const { c, f, sleeps } = connector({
      routes: [
        {
          match: /.*/,
          responses: [
            { status: 429, headers: { "x-ratelimit-reset": "3" } },
            { body: page([{ id: 1 }], null) },
          ],
        },
      ],
    });
    const result = await c.listDataset("deal");
    expect(result.rows).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    expect(sleeps).toContain(3000);
  });

  it("clamps an absurd reset hint instead of wedging a worker", async () => {
    // A header that turned out to carry an absolute epoch rather than a
    // duration would otherwise park a worker for decades — a worse failure than
    // retrying slightly early.
    // Mutation: drop the clamp → red.
    const { c, sleeps } = connector({
      routes: [
        {
          match: /.*/,
          responses: [
            { status: 429, headers: { "x-ratelimit-reset": "1788000000" } },
            { body: page([], null) },
          ],
        },
      ],
    });
    await c.listDataset("deal");
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000);
  });

  it("gives up on a persistent 429 with a typed, non-fault error", async () => {
    // Not a fault: the data returns on its own, and on a higher plan the
    // ceiling is higher. It must not read as a broken connection.
    // Mutation: retry unboundedly → the suite hangs.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ status: 429 }] }],
    });
    await expect(c.listDataset("deal")).rejects.toBeInstanceOf(PipedriveRateLimitedError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Declared properties
// ─────────────────────────────────────────────────────────────────────────────

describe("declared properties", () => {
  it("serves exactly the five canonical datasets, none of them invented", async () => {
    // Every one already existed in the vocabulary — `contact`, `company`,
    // `deal` and `engagement` from the CRM reconciliation, `product` from the
    // commerce set.
    // Mutation: add a name outside the union → tsc red, before any test runs.
    expect([...PIPEDRIVE_DATASETS]).toEqual(["contact", "company", "deal", "engagement", "product"]);
    for (const dataset of PIPEDRIVE_DATASETS) {
      expect(CANONICAL_COLUMNS[dataset], dataset).toBeDefined();
      expect(PIPEDRIVE_DATASET_ENDPOINTS[dataset], dataset).toBeDefined();
      expect(PIPEDRIVE_SCAN_MODE[dataset], dataset).toBe("delta");
    }
    const { c } = connector();
    expect(c.provider).toBe(PIPEDRIVE_PROVIDER);
    expect(c.servesDatasets).toBe(PIPEDRIVE_DATASETS);
  });

  it("declares the DELETION gap rather than letting a scheduler assume completeness", async () => {
    // Deletions and merges are carried ONLY by webhook events, and webhooks
    // need a publicly reachable URL with a non-self-signed certificate, which a
    // box with no inbound path cannot provide. Deals get a partial reprieve
    // FROM THE VENDOR: "If set to deleted, deals that have been deleted up to
    // 30 days ago will be included." Nothing equivalent exists on the other
    // four.
    // Mutation: mark any of the four as recoverable → red, and a caching
    // consumer would trust a mirror that silently accumulates dead rows.
    expect(PIPEDRIVE_DELETION_VISIBILITY.deal).toBe("vendor_only_thirty_day_window");
    for (const dataset of ["contact", "company", "engagement", "product"]) {
      expect(PIPEDRIVE_DELETION_VISIBILITY[dataset], dataset).toBe("none");
    }
    const { c } = connector();
    const status = await c.status();
    expect(status.vendorDeletionVisibility).toBe(PIPEDRIVE_DELETION_VISIBILITY);
    // And the ceiling this connector cannot enforce is reported, not implied.
    expect(status.dailyBudgetNote).toContain("30,000");
  });

  it("does not report the vendor's deleted-deal window as something THIS connector reads", async () => {
    // The deal window is real and it is the vendor's, not this track's:
    // `?status=deleted` needs a `status` parameter, and `status` is not in the
    // sendable set, so the query is unrepresentable here and no deleted deal is
    // ever recovered. A scheduler that read `deal: "thirty_day_window"` as
    // coverage and skipped its own reconciliation sweep would mirror deleted
    // deals forever — the value name and the note beside it are what stop that
    // reading.
    // Mutation: rename the value back to "thirty_day_window", or drop the note
    // from status() → red. Add "status" to PIPEDRIVE_SENDABLE_QUERY_PARAMS
    // without implementing the deleted read → red, because the claim and the
    // capability would have to be re-reconciled deliberately.
    expect(PIPEDRIVE_SENDABLE_QUERY_PARAMS.has("status")).toBe(false);
    expect(() => assertPipedriveSendableParams({ status: "deleted" })).toThrow(
      ConnectorBlockedError,
    );
    for (const dataset of PIPEDRIVE_DATASETS) {
      expect(PIPEDRIVE_DELETION_VISIBILITY[dataset], dataset).not.toBe("thirty_day_window");
    }
    const { c } = connector();
    const status = await c.status();
    expect(status.deletedDealWindowNote).toBe(PIPEDRIVE_DELETED_DEAL_WINDOW_NOTE);
    expect(status.deletedDealWindowNote).toContain("THIS CONNECTOR never");
    expect(status.deletedDealWindowNote).toContain("status=deleted");
  });

  it("introspects to the canonical shape with a stable fingerprint", async () => {
    // Mutation: synthesize different columns than the vocabulary declares → red.
    const { c } = connector();
    const result = await c.introspect();
    expect(result.tables.map((t) => t.name)).toEqual([...PIPEDRIVE_DATASETS]);
    for (const table of result.tables) {
      expect(table.columns.map((col) => col.name)).toEqual([
        ...CANONICAL_COLUMNS[table.name as (typeof PIPEDRIVE_DATASETS)[number]],
      ]);
    }
    expect(c.schemaFingerprint).toBe(result.fingerprint);
    const again = await c.introspect();
    expect(again.fingerprint).toBe(result.fingerprint);
  });

  it("uses no `any`, no `while (true)` and no console call in the connector directory", () => {
    // House rules, enforced rather than reviewed. `while (true)` in particular
    // is the shape a cursor walk takes when nobody bounds it, and each turn of
    // an unbounded walk spends the customer's daily token budget.
    // Mutation: introduce any of the three → red.
    for (const file of readdirSync(SRC_DIR)) {
      const src = sourceOf(file);
      expect(src, file).not.toMatch(/\bwhile\s*\(\s*true\s*\)/);
      expect(src, file).not.toMatch(/\bconsole\./);
      expect(src, file).not.toMatch(/:\s*any\b/);
      expect(src, file).not.toMatch(/\bas\s+any\b/);
    }
  });
});
