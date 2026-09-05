/**
 * WARP-2383 — XeroConnector.
 *
 * `fetch` is INJECTED, never patched globally, and every test asserts on the
 * CALLS the connector made — not only on what it returned. That distinction is
 * load-bearing: the host guard, the unimplemented-variant refusal, the
 * `If-Modified-Since` bound and the `summaryOnly` bound are all promises about
 * requests that must NOT happen, or must happen with particular headers, and a
 * test that inspects only a return value passes even when the request already
 * went out.
 *
 * Every test names the mutation that must turn it red.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";

import {
  UnknownXeroVariantError,
  UnsafeXeroBaseUrlError,
  XeroConnector,
  XeroRateLimitedError,
  XeroReauthorizationRequiredError,
  XeroScopeMissingError,
  XeroVariantNotImplementedError,
  XERO_ACCESS_TOKEN_TTL_MS,
  XERO_ALLOWED_API_HOSTS,
  XERO_API_BASE_URL,
  XERO_CREDENTIAL_VARIANTS,
  XERO_DATASETS,
  XERO_IDENTITY_BASE_URL,
  XERO_PAGE_SIZE,
  XERO_POLL_INTERVAL_FLOOR_MS,
  XERO_PROVIDER,
  XERO_READABLE_RESOURCES,
  XERO_SCOPES,
  XERO_TOKEN_EARLY_MINT_MS,
  assertReadableXeroResource,
  assertSafeXeroBaseUrl,
  assertXeroVariantImplemented,
  forgetXeroToken,
  pruneExpiredXeroTokens,
  xeroIfModifiedSince,
  xeroInstant,
  __resetXeroTokenCacheForTest,
} from "../src/xero/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { CANONICAL_COLUMNS, DATASETS } from "../src/export-drop/profiles.js";

/** 2026-09-02T12:00:00Z, the wall clock every test starts on. */
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

/**
 * Obviously-fake credential material.
 *
 * A Xero client secret is a long opaque string with no published prefix, so
 * there is no shape to imitate and no reason to: `FAKE` in the body is what
 * makes a grep for a leaked fixture answer honestly, and what keeps GitHub's
 * push protection from ever having an opinion about this file.
 */
const CLIENT_ID = "FAKE-XERO-CLIENT-ID-0000";
const CLIENT_SECRET = "FAKE-XERO-CLIENT-SECRET-do-not-use-0000";
const ACCESS_TOKEN = "FAKE-XERO-ACCESS-TOKEN-0000";
const CONNECTION_ID = "conn-xero-0001";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch double that records every call and replays a scripted queue. */
function recorder(responses: Response[]): { calls: Call[]; fetchImpl: never } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = async (url: string, init?: Record<string, unknown>) => {
    calls.push({
      url,
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unscripted request: ${url}`);
    return next;
  };
  return { calls, fetchImpl: fetchImpl as never };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/** A minted-token response, as Xero's identity host returns one. */
function tokenResponse(expiresIn = 1800): Response {
  return json({ access_token: ACCESS_TOKEN, expires_in: expiresIn, token_type: "Bearer" });
}

/** `/Date(ms+0000)/` — Xero's JSON date form, which is the whole point. */
function xeroDate(ms: number): string {
  return `/Date(${ms}+0000)/`;
}

function build(
  responses: Response[],
  overrides: Partial<{ variant: string; connectionId: string; baseUrl: string }> = {},
) {
  const { calls, fetchImpl } = recorder(responses);
  const connector = new XeroConnector(
    {
      connectionId: overrides.connectionId ?? CONNECTION_ID,
      clientId: CLIENT_ID,
      credentialVariant: overrides.variant ?? "custom-connection",
      credentialsSecretRef: "xero:pending",
      baseUrl: overrides.baseUrl,
    },
    {
      fetchImpl,
      now: () => NOW,
      resolveSecret: async (field) => {
        if (field !== "clientSecret") throw new Error(`unexpected field ${field}`);
        return CLIENT_SECRET;
      },
    },
  );
  return { connector, calls };
}

beforeEach(() => {
  __resetXeroTokenCacheForTest();
});

// ===========================================================================
// WARP-2394 — the two credential variants
// ===========================================================================

describe("the credential variants are a discriminated choice", () => {
  it("declares exactly the two paths ADR-042 §2 records", () => {
    // Mutation: add a third id, or drop `pkce-app` → red. The descriptor's
    // `credentialVariants` and this list are the same vocabulary; a variant the
    // wizard offers and the connector has never heard of is a row that saves
    // and then cannot be built.
    expect([...XERO_CREDENTIAL_VARIANTS]).toEqual(["custom-connection", "pkce-app"]);
  });

  it("REFUSES the pkce-app path by name, without dialling anything", () => {
    // The whole subsystem this path needs — an authorization-code redirect —
    // does not exist on an appliance with no inbound path (WARP-2388).
    // Mutation: make `assertXeroVariantImplemented` accept any known variant →
    // the connector builds, and the first read fails at Xero with an opaque
    // `invalid_client` instead of here with an actionable sentence.
    const { calls, fetchImpl } = recorder([]);
    expect(
      () =>
        new XeroConnector(
          {
            connectionId: CONNECTION_ID,
            clientId: CLIENT_ID,
            credentialVariant: "pkce-app",
            credentialsSecretRef: "xero:pending",
          },
          { fetchImpl },
        ),
    ).toThrow(XeroVariantNotImplementedError);
    expect(calls).toHaveLength(0);
  });

  it("tells an unrecognised variant apart from an unimplemented one", () => {
    // Two different facts: "nobody recorded which path this is" and "you chose
    // the path we do not run". Mutation: collapse both into one error → a
    // customer who deliberately chose the PKCE app is told their connection is
    // corrupt, and goes looking for the wrong thing.
    expect(() => assertXeroVariantImplemented("pkce-app")).toThrow(
      XeroVariantNotImplementedError,
    );
    expect(() => assertXeroVariantImplemented("")).toThrow(UnknownXeroVariantError);
    expect(() => assertXeroVariantImplemented(undefined)).toThrow(UnknownXeroVariantError);
    expect(assertXeroVariantImplemented("custom-connection")).toBe("custom-connection");
  });

  it("never echoes the rejected discriminator back in the message (rule 19)", () => {
    // A mis-pasted secret has landed in a discriminator field before, and the
    // rejection path is itself a secret-handling path (ADR-042 §4).
    // Mutation: interpolate the offered value into UnknownXeroVariantError →
    // red, and the value is then in every log line that renders the error.
    let message = "";
    try {
      assertXeroVariantImplemented(CLIENT_SECRET);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(CLIENT_SECRET);
    expect(message).toContain("custom-connection");
  });
});

// ===========================================================================
// WARP-2399 — the host guard
// ===========================================================================

describe("the base-URL guard", () => {
  it("allows exactly the two registered hosts — an EXACT set, never a suffix", () => {
    // Two rejections, and they fail different mutations. `api.xero.com.evil.test`
    // catches a naive `includes`; `login.xero.com` catches `endsWith("xero.com")`
    // — and it is not a strawman, it is a REAL Xero host that ADR-042 §Egress
    // lists and that this track deliberately does not register, so a suffix
    // match would dial a screened-adjacent host the registry never approved.
    // The first cut of this test asserted only the `.evil.test` case and stayed
    // GREEN under the suffix mutation, which is why both are here.
    expect([...XERO_ALLOWED_API_HOSTS].sort()).toEqual(["api.xero.com", "identity.xero.com"]);
    expect(assertSafeXeroBaseUrl(XERO_API_BASE_URL)).toBe(XERO_API_BASE_URL);
    expect(assertSafeXeroBaseUrl(XERO_IDENTITY_BASE_URL)).toBe(XERO_IDENTITY_BASE_URL);
    expect(() => assertSafeXeroBaseUrl("https://api.xero.com.evil.test")).toThrow(
      UnsafeXeroBaseUrlError,
    );
    expect(() => assertSafeXeroBaseUrl("https://login.xero.com")).toThrow(
      UnsafeXeroBaseUrlError,
    );
    expect(() => assertSafeXeroBaseUrl("https://evil.xero.com")).toThrow(
      UnsafeXeroBaseUrlError,
    );
  });

  it("refuses http, userinfo and an off-registry port", () => {
    // Each is a distinct way to send a credential somewhere the registry never
    // screened. Mutation: drop any one branch → that one silently passes.
    expect(() => assertSafeXeroBaseUrl("http://api.xero.com")).toThrow(UnsafeXeroBaseUrlError);
    expect(() => assertSafeXeroBaseUrl("https://evil@api.xero.com")).toThrow(
      UnsafeXeroBaseUrlError,
    );
    expect(() => assertSafeXeroBaseUrl("https://api.xero.com:8443")).toThrow(
      UnsafeXeroBaseUrlError,
    );
    expect(() => assertSafeXeroBaseUrl("not a url")).toThrow(UnsafeXeroBaseUrlError);
  });

  it("refuses a bad base at CONSTRUCTION, before any request", () => {
    // Mutation: move the guard into `get()` → the connector builds fine and
    // the refusal only happens on the first read, by which time a row that can
    // never work has been reported as connected.
    const { calls, fetchImpl } = recorder([]);
    expect(
      () =>
        new XeroConnector(
          {
            connectionId: CONNECTION_ID,
            clientId: CLIENT_ID,
            credentialVariant: "custom-connection",
            credentialsSecretRef: "xero:pending",
            baseUrl: "https://evil.test",
          },
          { fetchImpl },
        ),
    ).toThrow(UnsafeXeroBaseUrlError);
    expect(calls).toHaveLength(0);
  });

  it("keeps only the allowlisted resources dialable", () => {
    // Request paths are assembled from a variable, so a forbidden literal need
    // never appear in the source for the connector to dial one.
    // Mutation: delete `assertReadableXeroResource`'s throw → `/Journals`,
    // payroll and every write endpoint become reachable.
    expect(Object.keys(XERO_READABLE_RESOURCES).sort()).toEqual([
      "Contacts",
      "Invoices",
      "ManualJournals",
      "Organisation",
    ]);
    expect(() => assertReadableXeroResource("Invoices")).not.toThrow();
    expect(() => assertReadableXeroResource("Journals")).toThrow(ConnectorBlockedError);
    expect(() => assertReadableXeroResource("Payments")).toThrow(ConnectorBlockedError);
  });
});

// ===========================================================================
// WARP-2408 — the token lifecycle
// ===========================================================================

describe("the minted access token", () => {
  it("is minted from the client credential over Basic auth, never in the URL", async () => {
    // Mutation: move the credential into the form body or the query string →
    // it lands in every proxy log that records a request line or a body.
    const { connector, calls } = build([tokenResponse(), json({ Organisations: [{}] })]);
    await connector.connect();

    const mint = calls[0];
    expect(mint.url).toBe(`${XERO_IDENTITY_BASE_URL}/connect/token`);
    expect(mint.method).toBe("POST");
    expect(mint.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64")}`,
    );
    expect(mint.url).not.toContain(CLIENT_SECRET);
    expect(mint.body).toContain("grant_type=client_credentials");
    // Every scope requested is one this track actually reads with, and
    // `accounting.journals.read` is deliberately absent — new Custom
    // Connections can no longer be granted it.
    for (const scope of XERO_SCOPES) expect(mint.body).toContain(encodeURIComponent(scope));
    expect(mint.body).not.toContain("journals");
  });

  it("presents the token as a bearer header and never as a query param", async () => {
    // Mutation: append `?access_token=` instead → the credential is in every
    // proxy and access log on the path.
    const { connector, calls } = build([tokenResponse(), json({ Organisations: [{}] })]);
    await connector.connect();
    const read = calls[1];
    expect(read.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(read.url).not.toContain(ACCESS_TOKEN);
    // A Custom Connection reaches ONE organisation, so no tenant header is
    // needed. Mutation: add `xero-tenant-id` → red, and the header would then
    // have to be sourced from somewhere, which is a stored id we do not have.
    expect(Object.keys(read.headers)).not.toContain("xero-tenant-id");
  });

  it("mints ONCE across two connectors on the same connection", async () => {
    // `erp.service` builds and closes a connector per read. A per-instance
    // cache would mint a token for every read — one identity call for every
    // API call, doubling the metered spend.
    // Mutation: move `xeroTokenCache` inside the class → two mints, red.
    const first = build([tokenResponse(), json({ Organisations: [{}] })]);
    await first.connector.connect();
    await first.connector.close();

    const second = build([json({ Organisations: [{}] })]);
    await second.connector.connect();

    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].url).toContain("/api.xro/2.0/Organisation");
  });

  it("re-mints once the cached token is inside the early-mint window", async () => {
    // Mutation: drop XERO_TOKEN_EARLY_MINT_MS from the comparison → a token
    // that expires mid-flight surfaces as a 401, which this connector reports
    // as REAUTHORIZE_REQUIRED. The owner is then asked to fix a credential
    // that was never broken.
    const { calls, fetchImpl } = recorder([
      tokenResponse(),
      json({ Organisations: [{}] }),
      tokenResponse(),
      json({ Organisations: [{}] }),
    ]);
    let clock = NOW;
    const connector = new XeroConnector(
      {
        connectionId: CONNECTION_ID,
        clientId: CLIENT_ID,
        credentialVariant: "custom-connection",
        credentialsSecretRef: "xero:pending",
      },
      { fetchImpl, now: () => clock, resolveSecret: async () => CLIENT_SECRET },
    );
    await connector.connect();
    expect(calls).toHaveLength(2);

    // Inside the window: 1800s life, 2-minute margin.
    clock = NOW + 1800_000 - XERO_TOKEN_EARLY_MINT_MS + 1;
    await connector.connect();
    expect(calls).toHaveLength(4);
    expect(calls[2].url).toBe(`${XERO_IDENTITY_BASE_URL}/connect/token`);
  });

  it("follows Xero's own expires_in rather than the documented 30 minutes", async () => {
    // Mutation: hard-code XERO_ACCESS_TOKEN_TTL_MS → a vendor that shortens
    // its tokens is contradicted, and every read after the real expiry 401s.
    const { calls, fetchImpl } = recorder([
      tokenResponse(60),
      json({ Organisations: [{}] }),
      tokenResponse(60),
      json({ Organisations: [{}] }),
    ]);
    let clock = NOW;
    const connector = new XeroConnector(
      {
        connectionId: CONNECTION_ID,
        clientId: CLIENT_ID,
        credentialVariant: "custom-connection",
        credentialsSecretRef: "xero:pending",
      },
      { fetchImpl, now: () => clock, resolveSecret: async () => CLIENT_SECRET },
    );
    await connector.connect();
    // 90s later a 60s token is long gone, even though 30 minutes is not.
    clock = NOW + 90_000;
    await connector.connect();
    expect(calls).toHaveLength(4);
  });

  /**
   * A connector on a test-driven clock behind a URL-ROUTED fetch double.
   *
   * Deliberately not the scripted `recorder` queue the rest of this file uses.
   * These five tests are about how MANY times the token endpoint is dialled,
   * and a queue answers the buggy path's extra mint with whatever response was
   * scripted next — so the wrong-shaped body, not the extra call, is what the
   * test reports. Routing by URL gives both paths a well-formed answer and
   * leaves the call COUNT as the only thing that can differ.
   */
  function tokenProbe(
    tokenBody: Record<string, unknown>,
    opts: { raw?: boolean } = {},
  ) {
    const calls: Call[] = [];
    let clock = NOW;
    // `raw` skips the JSON round-trip and hands `mint()` the object straight
    // out of `res.json()`. Needed for exactly one value: `JSON.stringify(NaN)`
    // is `null`, so a NaN written into a fixture body arrives as null and the
    // test silently becomes a duplicate of the null case. See the fallback
    // test for why NaN is worth pinning even though JSON cannot carry it.
    const tokenRes = () =>
      opts.raw
        ? ({ ok: true, status: 200, headers: new Headers(), json: async () => tokenBody } as never)
        : json(tokenBody);
    const fetchImpl = async (url: string, init?: Record<string, unknown>) => {
      calls.push({
        url,
        method: String(init?.method ?? "GET"),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string | undefined,
      });
      return url.includes("/connect/token") ? tokenRes() : json({ Organisations: [{}] });
    };
    const connector = new XeroConnector(
      {
        connectionId: CONNECTION_ID,
        clientId: CLIENT_ID,
        credentialVariant: "custom-connection",
        credentialsSecretRef: "xero:pending",
      },
      {
        fetchImpl: fetchImpl as never,
        now: () => clock,
        resolveSecret: async () => CLIENT_SECRET,
      },
    );
    const mints = () => calls.filter((c) => c.url.includes("/connect/token")).length;
    return { calls, connector, mints, at: (ms: number) => { clock = ms; } };
  }

  it("treats a zero expires_in as absent rather than as an already-dead token", async () => {
    // The finding on #1946. `Number.isFinite(0)` is TRUE, so a literal
    // `"expires_in": 0` used to be multiplied to 0 ms and stored as
    // `expiresAt === now`. Every subsequent read then failed the early-mint
    // comparison and minted AGAIN — one identity call for every API call,
    // against a per-organisation ceiling of sixty calls a minute and the
    // fleet-wide app ceiling that allowed-egress.yaml names as the binding
    // one. A token Xero states no life for is given the documented life,
    // which is already what an omitted field gets.
    //
    // Mutation: put `Number.isFinite(parsed.expires_in)` back in place of the
    // `> 0` test -> two mints, red.
    const probe = tokenProbe({ access_token: ACCESS_TOKEN, expires_in: 0 });
    await probe.connector.connect();
    expect(probe.mints()).toBe(1);
    probe.at(NOW + 60_000);
    await probe.connector.connect();
    expect(probe.mints()).toBe(1);
  });

  it("treats a negative expires_in the same way, not as a token expired in the past", async () => {
    // Same class, one step worse: a negative value put `expiresAt` BEFORE
    // `now`, so the cached entry was simultaneously unusable and re-minted
    // around on every read. Mutation: drop the `> 0` half of the guard -> two
    // mints, red.
    const probe = tokenProbe({ access_token: ACCESS_TOKEN, expires_in: -3600 });
    await probe.connector.connect();
    probe.at(NOW + 60_000);
    await probe.connector.connect();
    expect(probe.mints()).toBe(1);
  });

  it("clamps an over-long expires_in down to the documented life", async () => {
    // Xero's documented Custom Connection token life is thirty minutes. A
    // response claiming a year is either a vendor change nobody has read yet
    // or a response that should not have been trusted; believing it means a
    // token Xero has already stopped accepting is presented for a year of
    // reads, each one a 401 this connector reports as REAUTHORIZE_REQUIRED —
    // an ask the owner cannot act on. The clamp errs toward one extra mint
    // rather than a connection that looks broken.
    //
    // Mutation: drop the Math.min -> the token survives past the documented
    // life and the second connect() serves it from cache, so mints stays 1,
    // red.
    const probe = tokenProbe({ access_token: ACCESS_TOKEN, expires_in: 31_536_000 });
    await probe.connector.connect();
    probe.at(NOW + XERO_ACCESS_TOKEN_TTL_MS + 1);
    await probe.connector.connect();
    expect(probe.mints()).toBe(2);
  });

  it("falls back to the documented life when expires_in is absent or not a number", async () => {
    // The pre-existing contract, pinned so the new guard cannot quietly move
    // it. Mutation: make the fallback 0 -> the cache never answers and every
    // read mints, red.
    for (const body of [
      { access_token: ACCESS_TOKEN },
      { access_token: ACCESS_TOKEN, expires_in: "1800" },
      { access_token: ACCESS_TOKEN, expires_in: null },
      { access_token: ACCESS_TOKEN, expires_in: true },
      { access_token: ACCESS_TOKEN, expires_in: { seconds: 1800 } },
    ]) {
      __resetXeroTokenCacheForTest();
      const probe = tokenProbe(body);
      await probe.connector.connect();
      probe.at(NOW + XERO_ACCESS_TOKEN_TTL_MS - XERO_TOKEN_EARLY_MINT_MS - 1);
      await probe.connector.connect();
      expect(probe.mints()).toBe(1);
    }
  });

  it("rejects a NaN expires_in — the guard is a positive test, not a negated one", async () => {
    // Why this is its own test with `raw`: `JSON.stringify(NaN)` is `null`, so
    // a NaN in a fixture body arrives as null and pins nothing. Handing the
    // object straight to `mint()` is the only way to exercise the value.
    //
    // Why pin an input JSON cannot carry: `NaN` is the single value that tells
    // `stated > 0` apart from `!(stated <= 0)`, and the negated form is the
    // natural way to write this guard. Under it, NaN passes, `Math.min(NaN,
    // …)` is NaN, `expiresAt` is NaN, and every `expiresAt - now > margin`
    // comparison is false — which is the unbounded-minting failure this whole
    // block exists to prevent, reintroduced by a refactor that looks like a
    // simplification. It is also one `Number(header)` away from reachable.
    //
    // Mutation: `stated > 0` -> `!(stated <= 0)` -> two mints, red. That exact
    // mutant SURVIVED the first pass of this suite, which is how the fixture
    // above was found to be testing null twice.
    const probe = tokenProbe({ access_token: ACCESS_TOKEN, expires_in: Number.NaN }, { raw: true });
    await probe.connector.connect();
    probe.at(NOW + XERO_ACCESS_TOKEN_TTL_MS - XERO_TOKEN_EARLY_MINT_MS - 1);
    await probe.connector.connect();
    expect(probe.mints()).toBe(1);
  });

  it("still follows a SHORTER expires_in — the clamp is a ceiling, not a floor", async () => {
    // The clamp must not collapse into "always thirty minutes". A vendor that
    // shortens its tokens is still followed. Mutation: replace the Math.min
    // with XERO_ACCESS_TOKEN_TTL_MS -> the 60-second token is held for half an
    // hour, the second connect() does not re-mint, mints stays 1, red.
    const probe = tokenProbe({ access_token: ACCESS_TOKEN, expires_in: 60 });
    await probe.connector.connect();
    probe.at(NOW + 90_000);
    await probe.connector.connect();
    expect(probe.mints()).toBe(2);
  });

  it("has no refresh path at all — a Custom Connection issues no refresh token", async () => {
    // ADR-042 §6: "a short-lived minted token is re-minted, never refreshed".
    // Mutation: add a `refresh()` that posts a refresh_token grant → red here,
    // and the grant would 400 at Xero because no refresh token exists.
    const { connector } = build([tokenResponse(), json({ Organisations: [{}] })]);
    await connector.connect();
    expect((connector as unknown as Record<string, unknown>).refresh).toBeUndefined();
  });

  it("prunes expired tokens out of memory, and only expired ones", async () => {
    // The cron leg (WARP-2408). Mutation: make `pruneExpiredXeroTokens` clear
    // the whole map → a live connection mints a fresh token every ten minutes,
    // spending the daily allowance the four-hour cadence exists to protect.
    const { connector } = build([tokenResponse(), json({ Organisations: [{}] })]);
    await connector.connect();
    expect(pruneExpiredXeroTokens(NOW)).toBe(0);
    expect(pruneExpiredXeroTokens(NOW + 1800_001)).toBe(1);
    expect(pruneExpiredXeroTokens(NOW + 1800_001)).toBe(0);
  });

  it("forgets a connection's token on demand", async () => {
    // The disconnect hook. Mutation: make `forgetXeroToken` a no-op → a purged
    // connection's token stays usable in memory until the process restarts.
    const { connector } = build([tokenResponse(), json({ Organisations: [{}] })]);
    await connector.connect();
    expect((await connector.status()).hasAccessToken).toBe(true);
    forgetXeroToken(CONNECTION_ID);
    expect((await connector.status()).hasAccessToken).toBe(false);
  });
});

// ===========================================================================
// WARP-2417 — the egress bounds
// ===========================================================================

describe("the egress bounds", () => {
  it("sends If-Modified-Since on a watermarked read, in RFC 1123 UTC", async () => {
    // Xero applies it server-side against UpdatedDateUTC, so an unchanged
    // ledger costs one call rather than a full enumeration.
    // Mutation: drop the header → every tick re-enumerates the whole book, on
    // an allowance of 5,000 calls a day.
    const { connector, calls } = build([tokenResponse(), json({ Invoices: [] })]);
    await connector.runRead("get_open_invoices", { since: "2026-08-01T00:00:00.000Z" });
    expect(calls[1].headers["If-Modified-Since"]).toBe("Sat, 01 Aug 2026 00:00:00 GMT");
  });

  it("sends NO If-Modified-Since when there is no watermark, or an unreadable one", async () => {
    // A header derived from a value we could not parse would silently skip the
    // window we failed to read. Mutation: default the header to `now` → the
    // first sync of a new connection returns nothing and reports success.
    const first = build([tokenResponse(), json({ Invoices: [] })]);
    await first.connector.runRead("get_open_invoices", {});
    expect(first.calls[1].headers["If-Modified-Since"]).toBeUndefined();

    __resetXeroTokenCacheForTest();
    const second = build([tokenResponse(), json({ Invoices: [] })]);
    await second.connector.runRead("get_open_invoices", { since: "not a date" });
    expect(second.calls[1].headers["If-Modified-Since"]).toBeUndefined();
  });

  it("sends summaryOnly ONLY where Xero documents it", async () => {
    // Mutation: send it unconditionally → it goes to ManualJournals, where
    // Xero documents no such parameter and where the journal LINES are the
    // record, not a detail to omit.
    const invoices = build([tokenResponse(), json({ Invoices: [] })]);
    await invoices.connector.runRead("get_open_invoices", {});
    expect(invoices.calls[1].url).toContain("summaryOnly=true");

    __resetXeroTokenCacheForTest();
    const journals = build([tokenResponse(), json({ ManualJournals: [] })]);
    await journals.connector.listManualJournals();
    expect(journals.calls[1].url).not.toContain("summaryOnly");
  });

  it("declares a four-hour poll floor", () => {
    // WARP-2417's cadence, mirrored by the descriptor and enforced by
    // `claimDueErpCursors`. Mutation: shorten it to the 15-minute tick → a
    // fleet on a pooled 10,000/min app-wide limit polls 16× more often.
    expect(XERO_POLL_INTERVAL_FLOOR_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("aborts a read that never returns a short page rather than paging forever", async () => {
    // Mutation: delete the no-progress fingerprint guard → an endpoint that
    // ignores `page` serves the identical window until the daily allowance is
    // gone, inside a single read.
    const full = Array.from({ length: XERO_PAGE_SIZE }, (_, i) => ({
      InvoiceID: `inv-${i}`,
      Type: "ACCREC",
      AmountDue: 1,
    }));
    const { connector } = build([
      tokenResponse(),
      json({ Invoices: full }),
      json({ Invoices: full }),
    ]);
    await expect(connector.runRead("get_open_invoices", {})).rejects.toThrow(
      /pagination is not advancing/,
    );
  });
});

// ===========================================================================
// WARP-2414 — the read surface and the canonical rows
// ===========================================================================

describe("the read surface", () => {
  it("serves exactly the three datasets the descriptor declares", () => {
    // Mutation: add a name outside the closed union → a `tsc` error at the
    // declaration site, which is the point of the narrowed type.
    expect([...XERO_DATASETS]).toEqual(["invoice", "bill", "contact"]);
    for (const d of XERO_DATASETS) expect(DATASETS).toContain(d);
  });

  it("refuses a dataset it does not serve, by type, before any I/O", async () => {
    // `[]` from a read a track cannot serve reads as "you have none of those".
    // Mutation: return [] instead of throwing → the assistant tells an owner
    // their CRM is empty because they connected an accounting system.
    const { connector, calls } = build([]);
    await expect(connector.runRead("get_deals_by_stage", {})).rejects.toThrow(
      DatasetNotServedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("reads ACCREC as invoices and ACCPAY as bills from the one resource", async () => {
    // Xero holds both in `Invoices`, discriminated by `Type`. Mutation: drop
    // the `where` predicate → a "what do we owe" answer includes money owed TO
    // the business, which is the sign error that matters most in this domain.
    const invoices = build([tokenResponse(), json({ Invoices: [] })]);
    await invoices.connector.runRead("get_open_invoices", {});
    expect(decodeURIComponent(invoices.calls[1].url)).toContain('where=Type=="ACCREC"');

    __resetXeroTokenCacheForTest();
    const bills = build([tokenResponse(), json({ Invoices: [] })]);
    await bills.connector.runRead("get_open_bills", {});
    expect(decodeURIComponent(bills.calls[1].url)).toContain('where=Type=="ACCPAY"');
  });

  it("asks Xero for AUTHORISED documents only — a draft is not money owed", async () => {
    // Xero fills `AmountDue` on DRAFT and SUBMITTED documents too, so the
    // client-side balance filter alone keeps an invoice nobody has sent and a
    // bill nobody has approved. Mutation: drop the `Status` clause from the
    // pushed-down `where` → "who owes us" includes unapproved paperwork, and
    // the number the owner is told is larger than the one they can collect.
    const invoices = build([tokenResponse(), json({ Invoices: [] })]);
    await invoices.connector.runRead("get_open_invoices", {});
    // Read back through `URL`, which turns the `+` URLSearchParams wrote for
    // the space back into a space; `decodeURIComponent` does not.
    expect(new URL(invoices.calls[1].url).searchParams.get("where")).toBe(
      'Type=="ACCREC" AND Status=="AUTHORISED"',
    );

    __resetXeroTokenCacheForTest();
    const bills = build([tokenResponse(), json({ Invoices: [] })]);
    await bills.connector.runRead("get_open_bills", {});
    expect(new URL(bills.calls[1].url).searchParams.get("where")).toBe(
      'Type=="ACCPAY" AND Status=="AUTHORISED"',
    );
  });

  it("projects an invoice onto exactly the canonical columns", async () => {
    // Mutation: spread the vendor record (`{...raw, updated_at}`) → the whole
    // Xero payload is persisted, which is the minimum-necessary rule broken in
    // one character of syntax.
    const issued = Date.UTC(2026, 7, 1);
    const due = Date.UTC(2026, 7, 31);
    const updated = Date.UTC(2026, 8, 1, 9, 30);
    const { connector } = build([
      tokenResponse(),
      json({
        Invoices: [
          {
            InvoiceID: "11111111-2222-3333-4444-555555555555",
            InvoiceNumber: "INV-0042",
            Type: "ACCREC",
            Contact: { ContactID: "c-1", Name: "Acme Widgets" },
            Date: xeroDate(issued),
            DueDate: xeroDate(due),
            Status: "AUTHORISED",
            Total: 1250.5,
            AmountDue: 500.25,
            UpdatedDateUTC: xeroDate(updated),
            // Not a canonical column. Must NOT survive the projection.
            LineItems: [{ Description: "confidential line" }],
          },
        ],
      }),
    ]);
    const rows = (await connector.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.invoice].sort());
    expect(rows[0]).toMatchObject({
      invoice_id: "INV-0042",
      issued_at: new Date(issued).toISOString(),
      due_at: new Date(due).toISOString(),
      customer_id: "Acme Widgets",
      amount: 1250.5,
      balance: 500.25,
      status: "AUTHORISED",
      updated_at: new Date(updated).toISOString(),
    });
    expect(JSON.stringify(rows[0])).not.toContain("confidential line");
  });

  it("parses Xero's .NET date form — the failure that would be invisible", async () => {
    // `Date.parse("/Date(1234+0000)/")` is NaN, so a naive coercion drops
    // EVERY timestamp on this track including the watermark's.
    // Mutation: replace `xeroInstant` with `canonicalInstant` → the rows still
    // arrive, they just have no dates, and the sync never advances.
    expect(xeroInstant(xeroDate(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("2026-01-02T03:04:05.000Z");
    // The trailing offset is a display hint and must NOT be added: doing so
    // shifts every instant by the organisation's timezone. Mutation: add it →
    // these two stop agreeing, and every Xero timestamp on a non-UTC
    // organisation moves by hours.
    expect(xeroInstant("/Date(1767322800000+1300)/")).toBe(xeroInstant("/Date(1767322800000)/"));
    expect(xeroInstant("/Date(nonsense)/")).toBeUndefined();
    expect(xeroInstant("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(xeroInstant("")).toBeUndefined();
    expect(xeroInstant(undefined)).toBeUndefined();
    expect(xeroIfModifiedSince("2026-08-01T00:00:00.000Z")).toBe("Sat, 01 Aug 2026 00:00:00 GMT");
    expect(xeroIfModifiedSince(undefined)).toBeUndefined();
  });

  it("returns undefined for an epoch no Date can hold, instead of throwing", async () => {
    // #1946's review: `Number.isFinite` admits values `Date` cannot represent,
    // so `/Date(99999999999999999999)/` reached `new Date(ms).toISOString()`
    // and threw `RangeError` out of a coercion whose whole contract is
    // "anything else stays undefined". One malformed field in one row would
    // have taken down the mapping for the entire page rather than leaving that
    // one field absent.
    //
    // Mutation: drop the `Math.abs(ms) > MAX_EPOCH_MS` half of the guard in
    // `isoFromEpochMs` → these throw instead of returning undefined.
    expect(xeroInstant("/Date(99999999999999999999)/")).toBeUndefined();
    expect(xeroInstant("/Date(-99999999999999999999)/")).toBeUndefined();
    expect(xeroInstant(8.64e15 + 1)).toBeUndefined();
    expect(xeroInstant(-8.64e15 - 1)).toBeUndefined();
    // The BOUNDARY itself is representable and must survive — a guard that
    // rejects it would be an off-by-one silently discarding a legal instant.
    expect(xeroInstant(8.64e15)).toBe("+275760-09-13T00:00:00.000Z");
    // And the header derived from it degrades the same way: no header at all,
    // which is a full enumeration, rather than a throw at the call site.
    expect(xeroIfModifiedSince("/Date(99999999999999999999)/")).toBeUndefined();
  });

  it("keeps a part-paid document and drops a settled one", async () => {
    // The same open predicate every other accounting track applies. Mutation:
    // filter on `Status` instead → status vocabularies differ per product and
    // a part-paid invoice disappears from receivables.
    const { connector } = build([
      tokenResponse(),
      json({
        Invoices: [
          { InvoiceID: "a", InvoiceNumber: "A", Total: 10, AmountDue: 10 },
          { InvoiceID: "b", InvoiceNumber: "B", Total: 10, AmountDue: 4 },
          { InvoiceID: "c", InvoiceNumber: "C", Total: 10, AmountDue: 0 },
        ],
      }),
    ]);
    const rows = (await connector.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(rows.map((r) => r.invoice_id)).toEqual(["A", "B"]);
  });

  it("keeps a document whose balance could not be read", async () => {
    // Money we cannot account for must stay visible. Mutation: `balance === 0
    // || balance === undefined` → a document with an unreadable amount is
    // silently dropped from what the business is told it is owed.
    const { connector } = build([
      tokenResponse(),
      json({ Invoices: [{ InvoiceID: "a", InvoiceNumber: "A", AmountDue: "not a number" }] }),
    ]);
    const rows = (await connector.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBeUndefined();
  });

  it("maps an ORGANISATION contact so it is findable by name", async () => {
    // A Xero contact is a PARTY: most suppliers are organisations with a
    // `Name` and no `LastName` at all, and `find_contact` searches by
    // last-name prefix. Mutation: drop the `?? Name` fallback → every supplier
    // on the ledger becomes unfindable by the one read the dataset has.
    const { connector } = build([
      tokenResponse(),
      json({
        Contacts: [
          {
            ContactID: "org-1",
            Name: "Northwind Supplies",
            EmailAddress: "accounts@example.invalid",
            ContactStatus: "ACTIVE",
            UpdatedDateUTC: xeroDate(NOW),
          },
        ],
      }),
    ]);
    const rows = (await connector.runRead("find_contact", { query: "north" })) as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.contact].sort());
    expect(rows[0].last_name).toBe("Northwind Supplies");
    // `ContactStatus` is a RECORD state, not a pipeline position. Mutation:
    // map it to `lifecycle_stage` → a filing status sits under a column every
    // other track fills with a sales stage, and the two compare as equals.
    expect(rows[0].lifecycle_stage).toBeUndefined();
    expect(rows[0].created_at).toBeUndefined();
  });

  it("enumerates contacts when no filter is supplied", async () => {
    // The sync runner passes `{}` and expects the dataset ENUMERATED, while
    // the assistant passes a prefix. Mutation: require `query` → the poller
    // silently syncs nothing and reports success.
    const { connector } = build([
      tokenResponse(),
      json({ Contacts: [{ ContactID: "x", Name: "Zed Ltd", UpdatedDateUTC: xeroDate(NOW) }] }),
    ]);
    const rows = await connector.runRead("find_contact", {});
    expect(rows).toHaveLength(1);
  });

  it("reads ManualJournals and never /Journals", async () => {
    // `/Journals` is the Advanced-tier general ledger and its scope stopped
    // being available to NEW Custom Connections on 2026-04-29, so a connector
    // written against it authenticates, 403s, and looks broken.
    // Mutation: point `listManualJournals` at "Journals" →
    // `assertReadableXeroResource` throws, because it is not in the allowlist.
    const { connector, calls } = build([tokenResponse(), json({ ManualJournals: [] })]);
    await connector.listManualJournals();
    expect(calls[1].url).toContain("/api.xro/2.0/ManualJournals");
    expect(calls[1].url).not.toContain("/Journals");
  });

  it("refuses every write", async () => {
    // The track requests read scopes only, so a write would fail at Xero
    // anyway — but "we didn't build it" is not enforceable and this is.
    // Mutation: let `applyWrite` through → a customer's books become writable
    // with no outbox and no confirmation.
    const { connector, calls } = build([]);
    await expect(
      connector.applyWrite("reschedule_appointment", { apptId: "1" }),
    ).rejects.toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });
});

// ===========================================================================
// The failure states
// ===========================================================================

describe("the failure states are distinct and none of them is an empty result", () => {
  it("reports a rejected credential as REAUTHORIZE_REQUIRED, not as no rows", async () => {
    // Mutation: return [] on a 401 → the owner is told they are owed nothing
    // by a connection that is not working at all.
    const { connector } = build([json({ error: "invalid_client" }, { status: 401 })]);
    await expect(connector.runRead("get_open_invoices", {})).rejects.toThrow(
      XeroReauthorizationRequiredError,
    );
  });

  it("names the scope on a 403 instead of asking for a new credential", async () => {
    // The credential is fine; the owner ticked a narrower scope set. Mutation:
    // fold this into the reauthorization error → they re-paste a working
    // secret, it changes nothing, and the real fix is never surfaced.
    const { connector } = build([tokenResponse(), json({}, { status: 403 })]);
    let err: unknown;
    await connector.runRead("find_contact", {}).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(XeroScopeMissingError);
    expect((err as XeroScopeMissingError).requiredScope).toBe("accounting.contacts.read");
    expect((err as Error).message).toMatch(/cannot be undone/);
  });

  it("carries Xero's own Retry-After on a 429", async () => {
    // Mutation: drop `retryAfter` → the sync backs off on its own schedule and
    // retries earlier than the vendor asked, deepening the throttle.
    const { connector } = build([
      tokenResponse(),
      json({}, { status: 429, headers: { "Retry-After": "37", "X-Rate-Limit-Problem": "minute" } }),
    ]);
    let err: unknown;
    await connector.runRead("get_open_bills", {}).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(XeroRateLimitedError);
    expect((err as XeroRateLimitedError).retryAfter).toBe("37");
    expect((err as XeroRateLimitedError).limitName).toBe("minute");
  });

  it("treats a 304 as no changes rather than as a fault", async () => {
    // Mutation: fall through to the `!res.ok` branch → an unchanged ledger is
    // reported as a Xero error every tick.
    const { connector } = build([tokenResponse(), new Response(null, { status: 304 })]);
    await expect(
      connector.runRead("get_open_invoices", { since: "2026-08-01T00:00:00.000Z" }),
    ).resolves.toEqual([]);
  });

  it("reports an unconfigured connection as disconnected, never as connected", async () => {
    // The shipped-off state ADR-041 §2 requires. Mutation: default `state` to
    // "connected" → a connection nobody ever configured reports healthy and
    // syncs nothing, which is the failure that section exists to prevent.
    const connector = new XeroConnector(
      {
        connectionId: CONNECTION_ID,
        clientId: CLIENT_ID,
        credentialVariant: "custom-connection",
        credentialsSecretRef: "xero:pending",
      },
      { now: () => NOW },
    );
    const status = await connector.status();
    expect(status.state).toBe("disconnected");
    expect(status.ok).toBe(false);
    expect(status.hasCredential).toBe(false);
    await expect(connector.health()).rejects.toThrow(ConnectorBlockedError);
  });

  it("never carries credential material in the status object (rule 19)", async () => {
    // The SMTP `hasPassword` convention. Mutation: add the secret or the
    // minted token to `status()` → it reaches every surface that renders a
    // connection, including an exportable audit row.
    const { connector } = build([tokenResponse(), json({ Organisations: [{}] })]);
    await connector.connect();
    const status = await connector.status();
    const encoded = JSON.stringify(status);
    expect(encoded).not.toContain(CLIENT_SECRET);
    expect(encoded).not.toContain(ACCESS_TOKEN);
    expect(status.hasCredential).toBe(true);
    expect(status.hasAccessToken).toBe(true);
    expect(status.clientId).toBe(CLIENT_ID);
  });
});

// ===========================================================================
// WARP-2408 — the vendor-side decommission
// ===========================================================================

describe("decommission", () => {
  it("DELETEs the CONNECTION id from /connections, not the tenant id", async () => {
    // Passing the tenant id succeeds at the HTTP level and revokes nothing —
    // the worst possible outcome for a revocation call, and one that keeps
    // BILLING the customer monthly.
    // Mutation: send `tenantId` → red, and a decommissioned box's Custom
    // Connection lives on at the customer's expense.
    const { connector, calls } = build([
      tokenResponse(),
      json([{ id: "connection-abc", tenantId: "tenant-xyz", tenantName: "Acme Ltd" }]),
      new Response(null, { status: 204 }),
    ]);
    await expect(connector.decommission()).resolves.toEqual({ state: "revoked", connections: 1 });
    expect(calls[2].method).toBe("DELETE");
    expect(calls[2].url).toBe(`${XERO_API_BASE_URL}/connections/connection-abc`);
    expect(calls[2].url).not.toContain("tenant-xyz");
  });

  it("counts a 404 as revoked and reports nothing to revoke honestly", async () => {
    // Mutation: treat 404 as a failure → a second decommission of an
    // already-severed connection looks like an error.
    const gone = build([
      tokenResponse(),
      json([{ id: "connection-abc", tenantId: "t", tenantName: null }]),
      new Response(null, { status: 404 }),
    ]);
    await expect(gone.connector.decommission()).resolves.toEqual({
      state: "revoked",
      connections: 1,
    });

    __resetXeroTokenCacheForTest();
    const empty = build([tokenResponse(), json([])]);
    await expect(empty.connector.decommission()).resolves.toEqual({
      state: "nothing_to_revoke",
    });
  });
});

// ===========================================================================
// WARP-2425 — the connector's half of the firewall
// ===========================================================================

describe("the architectural firewall", () => {
  it("persists nothing: no cache, no cursor, no secret store", () => {
    // ADR-041 §4 forbids a cloud connector becoming `ErpEntityCache`'s first
    // writer while WARP-2028 is open, and this track is read-through besides.
    // Mutation: add a write to any of the three → red, and the row would then
    // be a copy of a customer's ledger sitting unencrypted in Postgres.
    // Scanned with COMMENTS STRIPPED, deliberately: the module docstring
    // names all three models to explain why it writes none of them, and a
    // scanner that could not tell prose from code would force the connector to
    // stop documenting the very boundary this test pins.
    const code = readConnectorCode();
    expect(code).not.toMatch(/erpEntityCache/i);
    expect(code).not.toMatch(/erpSyncCursor/i);
    expect(code).not.toMatch(/prisma/i);
    // `credentialsSecretRef` is a POINTER the caller passes in and this
    // connector never dereferences or writes — the field name may appear, an
    // assignment to `secretRef` may not.
    expect(code).not.toMatch(/\bsecretRef\s*[:=]/);
  });

  it("names the provider key the registry and the egress entries agree on", () => {
    expect(XERO_PROVIDER).toBe("xero");
  });
});

/** The connector's source with block and line comments removed. */
function readConnectorCode(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "src", "xero", "connector.ts"), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
