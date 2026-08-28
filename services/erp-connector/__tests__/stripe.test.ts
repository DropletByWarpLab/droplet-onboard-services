/**
 * WARP-2215 — StripeConnector.
 *
 * `fetch` is INJECTED, never patched globally, and every test asserts on the
 * CALLS the connector made — not only on what it returned. That distinction is
 * the whole point of this file: the host guard, the read-allocation meter and
 * the Reporting-API backfill are all promises about requests that must NOT
 * happen (or must happen to a particular path), and a test that inspects only
 * the return value passes even when the request already went out.
 *
 * Every test names the mutation that must turn it red.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  InvalidStripeCredentialError,
  ReadAllocationMeter,
  STRIPE_API_VERSION,
  STRIPE_DATASETS,
  STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION,
  STRIPE_EVENT_CURSOR_LAG_MS,
  STRIPE_EVENT_RETENTION_MS,
  STRIPE_MIN_POLL_INTERVAL_SECONDS,
  STRIPE_PRODUCTION_BASE_URL,
  STRIPE_PROVIDER,
  STRIPE_READABLE_COLLECTIONS,
  STRIPE_ALLOWED_API_HOSTS,
  STRIPE_ALLOWED_FILE_HOSTS,
  STRIPE_FILES_BASE_URL,
  STRIPE_REPORT_FAMILY_COLLECTIONS,
  assertSafeStripeFileBaseUrl,
  balanceTransactionRowsFromReport,
  collectionForStripeReportType,
  parseStripeReportCsv,
  type StripeBalanceTransactionRow,
  EVENT_OBJECT_ROUTES,
  StripeAccessPolicyError,
  StripeConnector,
  StripeEventGapError,
  StripePollIntervalError,
  StripeQuotaExhaustedError,
  StripeReauthorizationRequiredError,
  UnsafeStripeBaseUrlError,
  assertSafeStripeBaseUrl,
  assertStripePollIntervalSeconds,
  assertStripeRestrictedKey,
  assertReadableStripeCollection,
} from "../src/stripe/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";

/** 2026-08-27T12:00:00Z, the clock every test runs on. */
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const KEY = "rk_test_51NotARealKeyJustAFixture";

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

/**
 * A routed fetch stub that records every call. Responses per route are
 * consumed in order and the last one repeats, so a route can model
 * "pending, pending, then succeeded" or "always pending".
 */
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
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k: string) => r.headers?.[k] ?? r.headers?.[k.toLowerCase()] ?? null,
      },
      json: async () => r.body ?? {},
      // A report file is CSV, not JSON. A string body is served verbatim so a
      // fixture can be a real CSV rather than something the stub re-encodes.
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {})),
    } as unknown as Response;
  };
  return {
    impl,
    calls,
    /** Just the pathnames, which is what the allocation/backfill assertions are about. */
    paths: () => calls.map((c) => new URL(c.url).pathname),
    /** Pathnames grouped by host — the allocation question is per-HOST, because
     *  which host a call went to is what decides whether Stripe counts it. */
    pathsByHost: () => {
      const byHost = new Map<string, string[]>();
      for (const c of calls) {
        const u = new URL(c.url);
        byHost.set(u.hostname, [...(byHost.get(u.hostname) ?? []), u.pathname]);
      }
      return byHost;
    },
    headersOf: (i: number) =>
      (calls[i].init.headers ?? {}) as Record<string, string>,
  };
}

/** Every header the connector ever set, across every recorded call. */
function allHeaders(f: ReturnType<typeof stubFetch>): Record<string, string>[] {
  return f.calls.map((c) => (c.init.headers ?? {}) as Record<string, string>);
}

function connector(
  opts: {
    routes?: Route[];
    baseUrl?: string;
    key?: string | null;
    allocation?: number;
    meter?: ReadAllocationMeter;
    sleeps?: number[];
  } = {},
) {
  const f = stubFetch(opts.routes ?? [{ match: /.*/, responses: [{ body: { data: [] } }] }]);
  const sleeps = opts.sleeps ?? [];
  const c = new StripeConnector(
    {
      credentialsSecretRef: "secret://stripe/acct_1Fixture",
      baseUrl: opts.baseUrl,
      monthlyReadAllocation: opts.allocation,
    },
    {
      fetchImpl: f.impl,
      now: () => NOW,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      meter: opts.meter,
      resolveApiKey:
        opts.key === null
          ? undefined
          : async () => opts.key ?? KEY,
    },
  );
  return { c, f, sleeps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Host guard (WARP-2220)
// ─────────────────────────────────────────────────────────────────────────────

describe("base-URL host guard", () => {
  it("rejects an unregistered host that merely LOOKS like Stripe", () => {
    // Mutation: delete the STRIPE_ALLOWED_API_HOSTS.has(host) check → red.
    expect(() => assertSafeStripeBaseUrl("https://api.stripe.evil.com")).toThrow(
      UnsafeStripeBaseUrlError,
    );
  });

  it("refuses an unregistered host on ZERO fetch calls, not on the response", async () => {
    // The guard's whole value is that the API key never leaves the box. A test
    // that asserts on the returned error would still pass if the request had
    // already gone out carrying the key.
    // Mutation: move the guard from construction to response handling → red.
    const f = stubFetch([{ match: /.*/, responses: [{ body: {} }] }]);
    expect(
      () =>
        new StripeConnector(
          {
            credentialsSecretRef: "secret://stripe/acct_1Fixture",
            baseUrl: "https://api.stripe.evil.com",
          },
          { fetchImpl: f.impl, now: () => NOW, resolveApiKey: async () => KEY },
        ),
    ).toThrow(UnsafeStripeBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("rejects userinfo, a non-443 port and plain http", () => {
    // Mutation: drop any one of the three checks → red.
    expect(() => assertSafeStripeBaseUrl("https://evil@api.stripe.com")).toThrow(
      UnsafeStripeBaseUrlError,
    );
    expect(() => assertSafeStripeBaseUrl("https://api.stripe.com:8443")).toThrow(
      UnsafeStripeBaseUrlError,
    );
    expect(() => assertSafeStripeBaseUrl("http://api.stripe.com")).toThrow(
      UnsafeStripeBaseUrlError,
    );
  });

  it("normalises a trailing slash and accepts the registered host", () => {
    // Mutation: drop the trailing-slash strip → red (URLs become //v1/...).
    expect(assertSafeStripeBaseUrl("https://api.stripe.com/")).toBe(STRIPE_PRODUCTION_BASE_URL);
    expect(assertSafeStripeBaseUrl(STRIPE_PRODUCTION_BASE_URL)).toBe(STRIPE_PRODUCTION_BASE_URL);
  });

  it("keeps the base URL as a whole literal so the egress scanner can read it", () => {
    // scripts/check-egress-allowlist.py is a static text scanner over tracked
    // source; it can only extract a hostname it literally sees. Assembling the
    // URL at runtime would blind it silently.
    // Mutation: rewrite the constant as `"https://" + host` → red.
    const src = readFileSync(stripeSourcePath("connector.ts"), "utf8");
    expect(src).toContain('"https://api.stripe.com"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Restricted-key intake (WARP-2224)
// ─────────────────────────────────────────────────────────────────────────────

describe("restricted-key intake", () => {
  it("accepts rk_live_ and rk_test_", () => {
    expect(assertStripeRestrictedKey("rk_live_abc")).toBe("rk_live_abc");
    expect(assertStripeRestrictedKey("rk_test_abc")).toBe("rk_test_abc");
  });

  it("rejects a SECRET key with a distinct reason — Stripe's rule is contractual", () => {
    // Mutation: loosen STRIPE_RESTRICTED_KEY_PATTERN to /^(rk|sk)_(live|test)_/ → red.
    for (const bad of ["sk_live_abc", "sk_test_abc"]) {
      let caught: unknown;
      try {
        assertStripeRestrictedKey(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidStripeCredentialError);
      expect((caught as InvalidStripeCredentialError).reason).toBe("secret_key");
    }
  });

  it("rejects a publishable key, an empty string and a non-string", () => {
    // Mutation: drop the empty-string guard → red.
    expect(() => assertStripeRestrictedKey("pk_live_abc")).toThrow(InvalidStripeCredentialError);
    expect((() => {
      try {
        assertStripeRestrictedKey("pk_live_abc");
      } catch (e) {
        return (e as InvalidStripeCredentialError).reason;
      }
    })()).toBe("publishable_key");
    expect(() => assertStripeRestrictedKey("")).toThrow(InvalidStripeCredentialError);
    expect(() => assertStripeRestrictedKey("   ")).toThrow(InvalidStripeCredentialError);
    expect(() => assertStripeRestrictedKey(undefined)).toThrow(InvalidStripeCredentialError);
  });

  it("never echoes the rejected credential back in the error — rule 19", () => {
    // A validation error that quotes the key writes it into every log line
    // that renders the error.
    // Mutation: interpolate the key into the message → red.
    let caught: unknown;
    try {
      assertStripeRestrictedKey("sk_live_SUPERSECRETVALUE");
    } catch (e) {
      caught = e;
    }
    const rendered = JSON.stringify({
      message: (caught as Error).message,
      ...(caught as InvalidStripeCredentialError),
    });
    expect(rendered).not.toContain("SUPERSECRETVALUE");
    expect(rendered).not.toContain("sk_live_");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stripe-Version pinning (WARP-2284)
// ─────────────────────────────────────────────────────────────────────────────

describe("Stripe-Version pinning", () => {
  it("sends the pin on EVERY request kind, not one sampled call", async () => {
    // A restricted key carries no version of its own: an unpinned request is
    // served at the MERCHANT's Workbench-changeable account default.
    // Mutation: remove the header from the request builder → red.
    const { c, f } = connector({
      routes: [
        { match: /\/v1\/reporting\/report_runs/, responses: [{ body: reportRun("pending") }] },
        { match: /\/v1\/events/, responses: [{ body: { data: [event()] } }] },
        { match: /\/v1\/invoices\//, responses: [{ body: invoiceObject() }] },
        { match: /\/v1\/invoices/, responses: [{ body: { data: [], has_more: false } }] },
        { match: /\/v1\/balance_transactions/, responses: [{ body: { data: [], has_more: false } }] },
      ],
    });
    await c.listBalanceTransactions();
    await c.runRead("get_open_invoices", {});
    await c.pollEvents({ cursor: NOW_S - 600 });
    await c.runBackfill({ reportType: "balance.summary.1", intervalStart: 1, intervalEnd: 2 });

    expect(f.calls.length).toBeGreaterThanOrEqual(4);
    for (const h of allHeaders(f)) {
      expect(h["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    }
  });

  it("declares the version exactly once in source, as a named constant", () => {
    // A second literal is a version that can drift out of the pin silently.
    // Mutation: paste the version string into a second file or a comment → red.
    const hits = stripeSources().flatMap((p) => {
      const src = readFileSync(p, "utf8");
      return [...src.matchAll(/\d{4}-\d{2}-\d{2}\.[a-z]+/g)].map((m) => `${p}:${m[0]}`);
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(STRIPE_API_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Poll floor + read allocation (WARP-2282)
// ─────────────────────────────────────────────────────────────────────────────

describe("poll floor and read allocation", () => {
  it("refuses a poll interval below 900 s and does NOT clamp it", () => {
    // A clamp hides the operator's intent: they asked for 60 s and would be
    // silently given 900 s while believing they had per-minute freshness.
    // Mutation: lower STRIPE_MIN_POLL_INTERVAL_SECONDS to 60 → red.
    expect(STRIPE_MIN_POLL_INTERVAL_SECONDS).toBe(900);
    for (const bad of [1, 60, 300, 899]) {
      expect(() => assertStripePollIntervalSeconds(bad)).toThrow(StripePollIntervalError);
    }
    expect(assertStripePollIntervalSeconds(900)).toBe(900);
    expect(assertStripePollIntervalSeconds(3600)).toBe(3600);
  });

  it("prices the arithmetic the floor comes from", () => {
    // 60 s on ONE endpoint is ~43,200 reads/month — 4x the 10,000 floor.
    // Mutation: change the default allocation → red.
    expect(STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION).toBe(10_000);
    const perMonth = (s: number) => Math.round((30 * 24 * 3600) / s);
    expect(perMonth(60)).toBeGreaterThan(4 * STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION);
    expect(perMonth(STRIPE_MIN_POLL_INTERVAL_SECONDS)).toBeLessThan(
      STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION / 3,
    );
  });

  it("raises QUOTA_EXHAUSTED before the request, on ZERO fetch calls", async () => {
    // ADR-041: none of the failure states may ever render as an empty result.
    // Mutation: replace the throw with `return []` → red.
    // Mutation: move assertHeadroom() below the fetch → red on the call count.
    const meter = new ReadAllocationMeter(2, () => NOW);
    meter.record();
    meter.record();
    const { c, f } = connector({ meter });

    await expect(c.listBalanceTransactions()).rejects.toBeInstanceOf(StripeQuotaExhaustedError);
    expect(f.calls).toHaveLength(0);

    const err = await c.listBalanceTransactions().catch((e) => e);
    expect(err.code).toBe("QUOTA_EXHAUSTED");
    expect(Array.isArray(err)).toBe(false);
  });

  it("meters only successful reads, and rolls the period over", () => {
    // Charging ourselves for failures drains the allowance fastest exactly
    // when the integration is already unhealthy.
    // Mutation: make the period never roll → red.
    let t = NOW;
    const meter = new ReadAllocationMeter(3, () => t);
    meter.record();
    expect(meter.snapshot().remaining).toBe(2);
    t += 31 * 24 * 3600_000;
    expect(meter.snapshot().spent).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reporting-API backfill (WARP-2288)
// ─────────────────────────────────────────────────────────────────────────────

describe("Reporting-API backfill", () => {
  it("routes backfill through report runs and spends NO read allocation", async () => {
    // Paginating /v1/balance_transactions far enough back to seed a ledger
    // burns a quiet merchant's entire monthly floor in one sitting.
    // Mutation: point the backfill at /v1/charges (or any /v1 list) → red on
    // BOTH the path assertion and the byte-identical meter snapshot.
    const meter = new ReadAllocationMeter(STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION, () => NOW);
    const before = JSON.stringify(meter.snapshot());
    const { c, f } = connector({
      meter,
      routes: [
        {
          match: /\/v1\/reporting\/report_runs/,
          responses: [reportRun("pending"), reportRun("succeeded")].map((body) => ({ body })),
        },
        { match: /files\.stripe\.com/, responses: [{ body: REPORT_CSV }] },
      ],
    });

    const out = await c.runBackfill({
      reportType: "balance.summary.1",
      intervalStart: NOW_S - 90 * 86400,
      intervalEnd: NOW_S - 86400,
    });

    expect(out.state).toBe("succeeded");
    expect(JSON.stringify(meter.snapshot())).toBe(before);
    // Every call to the ALLOCATION-METERED host is a Reporting-API path, which
    // is the one family Stripe excludes from the allocation. The file download
    // is not on this host at all — see the per-host test below.
    for (const p of f.pathsByHost().get("api.stripe.com") ?? []) {
      expect(p.startsWith("/v1/reporting/report_runs")).toBe(true);
    }
    expect(f.calls[0].init.method).toBe("POST");
  });

  it("renders a forever-pending report run as in_progress, never succeeded-and-empty", async () => {
    // "backfill finished, no rows" is a confident false statement about money.
    // Mutation: return a succeeded state when attempts run out → red.
    const { c, sleeps } = connector({
      routes: [
        {
          match: /\/v1\/reporting\/report_runs/,
          responses: [{ body: reportRun("pending") }],
        },
      ],
    });
    const out = await c.runBackfill({
      reportType: "balance.summary.1",
      intervalStart: 1,
      intervalEnd: 2,
    });
    expect(out.state).toBe("in_progress");
    expect(out.state).not.toBe("succeeded");
    // Polled with backoff, not a hot loop.
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.max(...sleeps)).toBeGreaterThan(Math.min(...sleeps));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Report-file retrieval from files.stripe.com (WARP-2450)
// ─────────────────────────────────────────────────────────────────────────────

/** A connector wired for a three-interval historical load: the first run needs
 *  a second poll, then two more runs succeed straight away, and each finished
 *  run's file serves a different slice of the CSV. */
function backfillHarness(meter?: ReadAllocationMeter) {
  return connector({
    meter,
    routes: [
      {
        match: /\/v1\/reporting\/report_runs/,
        responses: [
          reportRun("pending"),
          reportRun("succeeded", "file_1"),
          reportRun("succeeded", "file_2"),
          reportRun("succeeded", "file_3"),
        ].map((body) => ({ body })),
      },
      {
        match: /files\.stripe\.com/,
        responses: [REPORT_CSV, REPORT_CSV_2, REPORT_CSV_3].map((body) => ({ body })),
      },
    ],
  });
}

/** Three consecutive months of history, one report run each. */
async function loadThreeIntervals(c: StripeConnector) {
  const rows: StripeBalanceTransactionRow[] = [];
  for (const month of [5, 6, 7]) {
    const out = await c.runBackfill({
      reportType: "balance_change_from_activity.itemized.3",
      intervalStart: Math.floor(Date.UTC(2026, month - 1, 1) / 1000),
      intervalEnd: Math.floor(Date.UTC(2026, month, 1) / 1000),
    });
    expect(out.state).toBe("succeeded");
    if (out.state === "succeeded") rows.push(...out.rows);
  }
  return rows;
}

describe("report-file retrieval", () => {
  it("loads a multi-interval historical backfill end to end and yields rows", async () => {
    // The whole point of WARP-2450: before it, runBackfill drove the run to
    // completion and returned a bare file reference, so a historical load
    // produced ZERO rows however many report runs it made.
    // Mutation: revert retrieval to returning the reference (drop the
    // retrieveReportRows call, return rows: []) → red on the row count.
    const { c, f } = backfillHarness();
    const rows = await loadThreeIntervals(c);

    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.transaction_id)).toEqual([
      "txn_1", "txn_2", "txn_3", "txn_4", "txn_5", "txn_6", "txn_7",
    ]);
    // The download URL is BUILT from the run's own file id, not followed from
    // the file object's `url` field — so each interval fetched its own file.
    // Mutation: hardcode one file id → red.
    expect(f.pathsByHost().get("files.stripe.com")).toEqual([
      "/v1/files/file_1/contents",
      "/v1/files/file_2/contents",
      "/v1/files/file_3/contents",
    ]);
  });

  it("yields the SAME row shape the incremental path yields", async () => {
    // A caller must not have to know which path a row arrived by. Compared
    // against a live listBalanceTransactions() row rather than against a
    // hardcoded key list, so the two cannot drift apart silently.
    // Mutation: rename or drop any field in balanceTransactionRowsFromReport → red.
    const { c } = backfillHarness();
    const backfilled = await loadThreeIntervals(c);

    const { c: c2 } = connector({
      routes: [
        {
          match: /\/v1\/balance_transactions/,
          responses: [
            {
              body: {
                data: [
                  {
                    id: "txn_live",
                    created: NOW_S,
                    type: "charge",
                    currency: "usd",
                    amount: 1000,
                    fee: 59,
                    net: 941,
                    status: "available",
                  },
                ],
                has_more: false,
              },
            },
          ],
        },
      ],
    });
    const incremental = await c2.listBalanceTransactions();

    expect(incremental).toHaveLength(1);
    expect(Object.keys(backfilled[0]).sort()).toEqual(Object.keys(incremental[0]).sort());
  });

  it("spends NO read allocation anywhere in the backfill path — counted per host", async () => {
    // Stripe excludes the Reporting API AND its files from the account's
    // monthly read allocation; that exclusion is the entire reason bulk
    // history routes this way. The assertion is per-HOST because the host is
    // what decides whether Stripe counts a call: /v1/files/... served from
    // api.stripe.com would be an ordinary, allocation-counted API read.
    // Mutation: route retrieval through api.stripe.com (origin: this.baseUrl)
    // → red on both the api.stripe.com path assertion and the files-host count.
    const meter = new ReadAllocationMeter(STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION, () => NOW);
    const before = JSON.stringify(meter.snapshot());
    const { c, f } = backfillHarness(meter);
    await loadThreeIntervals(c);

    expect(JSON.stringify(meter.snapshot())).toBe(before);
    expect(meter.snapshot().spent).toBe(0);

    const byHost = f.pathsByHost();
    expect([...byHost.keys()].sort()).toEqual(["api.stripe.com", "files.stripe.com"]);
    // Non-vacuous: the loop below would pass over an empty list.
    expect(byHost.get("api.stripe.com")?.length).toBe(4);
    expect(byHost.get("files.stripe.com")?.length).toBe(3);
    for (const p of byHost.get("api.stripe.com") ?? []) {
      expect(p.startsWith("/v1/reporting/report_runs")).toBe(true);
    }
    for (const p of byHost.get("files.stripe.com") ?? []) {
      expect(p).toMatch(/^\/v1\/files\/file_\d+\/contents$/);
    }
  });

  it("refuses an unregistered report-file host on ZERO fetch calls", async () => {
    // Same promise the API guard makes, for the second host: the restricted
    // key never leaves the box for a destination the registry has not screened.
    // Mutation: add a wildcard (or files.stripe.evil.com) to
    // STRIPE_ALLOWED_FILE_HOSTS → red, because construction then succeeds.
    const f = stubFetch([{ match: /.*/, responses: [{ body: REPORT_CSV }] }]);
    expect(
      () =>
        new StripeConnector(
          {
            credentialsSecretRef: "secret://stripe/acct_1Fixture",
            filesBaseUrl: "https://files.stripe.evil.com",
          },
          { fetchImpl: f.impl, now: () => NOW, resolveApiKey: async () => KEY },
        ),
    ).toThrow(UnsafeStripeBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("keeps the file host and the API host in SEPARATE sets, not one merged set", () => {
    // Merging them would let an operator configure baseUrl: files.stripe.com
    // and have the API guard wave it through, or the reverse.
    // Mutation: make both guards read one combined set → red on all four.
    expect(() => assertSafeStripeFileBaseUrl(STRIPE_FILES_BASE_URL)).not.toThrow();
    expect(() => assertSafeStripeFileBaseUrl(STRIPE_PRODUCTION_BASE_URL)).toThrow(
      UnsafeStripeBaseUrlError,
    );
    expect(() => assertSafeStripeBaseUrl(STRIPE_FILES_BASE_URL)).toThrow(
      UnsafeStripeBaseUrlError,
    );
    expect([...STRIPE_ALLOWED_FILE_HOSTS]).toEqual(["files.stripe.com"]);
    // Nothing new was admitted to the API set: WARP-2216 pins it to one host.
    expect([...STRIPE_ALLOWED_API_HOSTS]).toEqual(["api.stripe.com"]);
  });

  it("keeps the file base URL a whole literal so the egress scanner can read it", () => {
    // scripts/check-egress-allowlist.py binds a registry entry to a hostname it
    // can literally see in tracked source. Composing this URL would leave the
    // stripe-report-files entry matching nothing.
    // Mutation: rewrite as `"https://files." + "stripe.com"` → red.
    const src = readFileSync(stripeSourcePath("connector.ts"), "utf8");
    expect(src).toContain('"https://files.stripe.com"');
  });

  it("refuses a report whose subject collection is off the allowlist, before any fetch", async () => {
    // A payout-reconciliation report is a payouts read wearing a different
    // URL. "No money movement" has to hold on the Reporting surface too, and
    // it has to hold BEFORE the run is created — not at download time, by
    // which point Stripe has already assembled the merchant's payout ledger.
    // Mutation: add "payouts" to STRIPE_READABLE_COLLECTIONS → red.
    expect(STRIPE_REPORT_FAMILY_COLLECTIONS.get("payout_reconciliation")).toBe("payouts");
    expect(STRIPE_READABLE_COLLECTIONS.has("payouts")).toBe(false);

    const { c, f } = backfillHarness();
    await expect(
      c.runBackfill({
        reportType: "payout_reconciliation.itemized.5",
        intervalStart: 1,
        intervalEnd: 2,
      }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses an UNRECOGNISED report family rather than assuming it harmless", () => {
    // Mutation: return a default collection for an unknown family → red.
    expect(() => collectionForStripeReportType("balance.summary.1")).not.toThrow();
    expect(() => collectionForStripeReportType("something.new.1")).toThrow(
      ConnectorBlockedError,
    );
    // Every family this connector claims to understand names a real collection.
    for (const collection of STRIPE_REPORT_FAMILY_COLLECTIONS.values()) {
      expect(collection).not.toBe("");
    }
  });

  it("parses quoted, comma-bearing, CRLF report rows rather than splitting on commas", () => {
    // Report rows carry merchant-authored text. A split(",") parser shifts
    // every column after the first comma inside a quoted field, which is a
    // wrong ledger rather than a failed read.
    // Mutation: implement parseStripeReportCsv as line.split(",") → red.
    const recs = parseStripeReportCsv(REPORT_CSV);
    expect(recs).toHaveLength(2);
    expect(recs[0].description).toBe('Acme, Inc. "monthly" plan');
    // The BOM is stripped, so the first header name is usable as a key.
    expect(recs[0].balance_transaction_id).toBe("txn_1");
    expect(recs[0].net).toBe("9.41");
  });

  it("refuses a row whose field count disagrees with the header", () => {
    // Padding or truncating attributes every value after the gap to the wrong
    // column. Mutation: pad short rows with "" → red.
    expect(() => parseStripeReportCsv(REPORT_HEADER + "txn_1,2026-05-01 12:00:00\r\n")).toThrow(
      ConnectorBlockedError,
    );
  });

  it("reads report amounts as MAJOR units — they are NOT the API's minor units", () => {
    // The two ingestion paths differ: /v1/balance_transactions returns 1000 for
    // ten dollars, the report CSV returns 10.00. Running the CSV through
    // majorUnits() would divide a second time and understate the ledger 100x.
    // Mutation: apply majorUnits() to the CSV amounts → red (10.00 → 0.1).
    const rows = balanceTransactionRowsFromReport(parseStripeReportCsv(REPORT_CSV));
    expect(rows[0].amount).toBe(10);
    expect(rows[0].fee).toBe(0.59);
    expect(rows[0].net).toBe(9.41);
    // And a zero-decimal currency is not re-scaled either: JPY 5000 is ¥5000.
    const jpy = balanceTransactionRowsFromReport(parseStripeReportCsv(REPORT_CSV_2));
    expect(jpy[2].currency).toBe("jpy");
    expect(jpy[2].amount).toBe(5000);
  });

  it("reads created_utc as UTC, not in the box's local zone", () => {
    // `new Date("2026-05-01 12:00:00")` is parsed in the RUNNING PROCESS's
    // local zone, so the same report would date a transaction differently on a
    // box in Los Angeles and one in Berlin.
    // Mutation: parse with `new Date(raw)` → red in any non-UTC zone.
    const rows = balanceTransactionRowsFromReport(parseStripeReportCsv(REPORT_CSV));
    expect(rows[0].created_at).toBe("2026-05-01T12:00:00.000Z");
    expect(rows[1].created_at).toBe("2026-05-02T08:30:00.000Z");
  });

  it("refuses to call a succeeded run with no file reference a finished backfill", async () => {
    // "succeeded, zero rows" reads as "your account has no history", which is a
    // confident false statement about money.
    // Mutation: return { state: "succeeded", rows: [] } instead of throwing → red.
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/reporting\/report_runs/,
          responses: [
            { body: { id: "frr_9", object: "reporting.report_run", status: "succeeded", result: null } },
          ],
        },
      ],
    });
    await expect(
      c.runBackfill({ reportType: "balance.summary.1", intervalStart: 1, intervalEnd: 2 }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event cursor poller (WARP-2287)
// ─────────────────────────────────────────────────────────────────────────────

describe("/v1/events cursor poller", () => {
  it("ignores the embedded payload and re-fetches the object under the pin", async () => {
    // Event payloads render at their CREATION-TIME API version and ignore the
    // Stripe-Version header, so a payload read straight off the event can be
    // an arbitrarily old schema.
    // Mutation: read `event.data.object` instead of re-fetching → red.
    const stale = {
      id: "in_1",
      // The shape a long-retired API version served: money as a string, and
      // the field the modern version calls `amount_remaining` absent entirely.
      total: "1200",
      legacy_balance_field: "1200",
    };
    const { c, f } = connector({
      routes: [
        {
          match: /\/v1\/events/,
          responses: [{ body: { data: [event({ id: "evt_1", created: NOW_S - 60, object: stale })] } }],
        },
        { match: /\/v1\/invoices\/in_1/, responses: [{ body: invoiceObject() }] },
      ],
    });

    const out = await c.pollEvents({ cursor: NOW_S - 600 });
    expect(out.records).toHaveLength(1);
    // The record carries the RE-FETCHED object, not the stale one.
    expect(out.records[0].object.amount_remaining).toBe(1200);
    expect(out.records[0].object.legacy_balance_field).toBeUndefined();
    expect(f.paths()).toContain("/v1/invoices/in_1");
  });

  it("holds the cursor at least 5 s behind wall clock", async () => {
    // Same-second events are eventually consistent; a cursor set to `now`
    // misses records that materialise microseconds later.
    // Mutation: set STRIPE_EVENT_CURSOR_LAG_MS to 0 → red.
    expect(STRIPE_EVENT_CURSOR_LAG_MS).toBeGreaterThanOrEqual(5_000);
    const { c } = connector({
      routes: [{ match: /\/v1\/events/, responses: [{ body: { data: [] } }] }],
    });
    const out = await c.pollEvents({ cursor: NOW_S - 600 });
    expect(out.windowEnd).toBeLessThanOrEqual(NOW_S - STRIPE_EVENT_CURSOR_LAG_MS / 1000);
  });

  it("advances the cursor to MAX(created), not to the last element of the page", async () => {
    // Ordering on /v1/events is explicitly not guaranteed. Taking the last
    // element silently drops everything that sorted after it.
    // Mutation: advance to `page[page.length - 1].created` → red.
    const newest = NOW_S - 30;
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/events/,
          responses: [
            {
              body: {
                data: [
                  event({ id: "evt_a", created: NOW_S - 120, objectId: "in_1" }),
                  event({ id: "evt_c", created: newest, objectId: "in_3" }),
                  event({ id: "evt_b", created: NOW_S - 90, objectId: "in_2" }),
                ],
              },
            },
          ],
        },
        { match: /\/v1\/invoices\/in_\d/, responses: [{ body: invoiceObject() }] },
      ],
    });
    const out = await c.pollEvents({ cursor: NOW_S - 600 });
    expect(out.records).toHaveLength(3);
    expect(out.cursor).toBe(newest);
  });

  it("is idempotent: replaying the same window yields no duplicate records", async () => {
    // Mutation: key the dedupe on the EVENT id instead of the object id → red
    // (two events touching one object would produce two rows for it).
    const routes: Route[] = [
      {
        match: /\/v1\/events/,
        responses: [
          {
            body: {
              data: [
                event({ id: "evt_a", created: NOW_S - 120, objectId: "in_1" }),
                event({ id: "evt_b", created: NOW_S - 90, objectId: "in_1" }),
              ],
            },
          },
        ],
      },
      { match: /\/v1\/invoices\/in_1/, responses: [{ body: invoiceObject() }] },
    ];
    const first = await connector({ routes }).c.pollEvents({ cursor: NOW_S - 600 });
    const second = await connector({ routes }).c.pollEvents({ cursor: NOW_S - 600 });
    expect(first.records).toHaveLength(1);
    expect(first.records.map((r) => r.objectId)).toEqual(second.records.map((r) => r.objectId));
  });

  it("refuses a cursor older than the 30-day retention window", async () => {
    // A box offline longer than retention has a hole no cursor can close.
    // Mutation: return `{ records: [] }` instead of throwing → red. A
    // successful empty poll here means "nothing changed in 40 days".
    const { c, f } = connector({
      routes: [{ match: /\/v1\/events/, responses: [{ body: { data: [] } }] }],
    });
    const tooOld = NOW_S - Math.floor(STRIPE_EVENT_RETENTION_MS / 1000) - 86400;
    await expect(c.pollEvents({ cursor: tooOld })).rejects.toBeInstanceOf(StripeEventGapError);
    expect(f.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The four failure states (WARP-2290)
// ─────────────────────────────────────────────────────────────────────────────

describe("failure states", () => {
  it("renders an IP/ASN access-policy 403 as its own named remediation state", async () => {
    // The box sits behind an SMB's dynamic WAN IP. The day the ISP re-leases
    // that address every call 403s, and "generic auth failure" sends the
    // merchant to re-create a key that was never the problem.
    // Mutation: fold 403 into StripeReauthorizationRequiredError → red.
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/balance_transactions/,
          responses: [
            {
              status: 403,
              body: {
                error: {
                  type: "invalid_request_error",
                  message:
                    "Requests from this IP address are not allowed by the API key's IP access policy.",
                },
              },
            },
          ],
        },
      ],
    });
    const err = await c.listBalanceTransactions().catch((e) => e);
    expect(err).toBeInstanceOf(StripeAccessPolicyError);
    expect(err).not.toBeInstanceOf(StripeReauthorizationRequiredError);
    expect(JSON.stringify({ ...err, message: err.message })).toContain("IP access policy");
  });

  it("keeps the four states distinguishable WITHOUT string-matching a message", async () => {
    // Mutation: give two of them the same `code` → red.
    const codes = [
      new StripeQuotaExhaustedError(1, 1).code,
      new StripeReauthorizationRequiredError("x").code,
      new StripeAccessPolicyError("x").code,
      new ConnectorBlockedError("x", "y").code,
    ];
    expect(new Set(codes).size).toBe(4);
  });

  it("treats a 401 as re-authorization, not as an access policy", async () => {
    // Mutation: classify every 4xx as an access policy → red.
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/balance_transactions/,
          responses: [{ status: 401, body: { error: { message: "Invalid API Key provided" } } }],
        },
      ],
    });
    const err = await c.listBalanceTransactions().catch((e) => e);
    expect(err).toBeInstanceOf(StripeReauthorizationRequiredError);
    expect(err).not.toBeInstanceOf(StripeAccessPolicyError);
  });

  it("backs off on a 429 that carries no Retry-After", async () => {
    // Stripe sends Stripe-Rate-Limited-Reason but no documented Retry-After,
    // so the backoff has to be self-derived rather than read off the response.
    // Mutation: delete the sleep from the 429 path → red (hot loop).
    const { c, sleeps, f } = connector({
      routes: [
        {
          match: /\/v1\/balance_transactions/,
          responses: [
            { status: 429, headers: { "Stripe-Rate-Limited-Reason": "read_operations" } },
            { status: 429, headers: { "Stripe-Rate-Limited-Reason": "read_operations" } },
            { body: { data: [], has_more: false } },
          ],
        },
      ],
    });
    await c.listBalanceTransactions();
    expect(sleeps.length).toBe(2);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    expect(f.calls).toHaveLength(3);
  });

  it("does not meter a read that failed", async () => {
    // Mutation: record() before checking res.ok → red.
    const meter = new ReadAllocationMeter(10, () => NOW);
    const { c } = connector({
      meter,
      routes: [
        { match: /\/v1\/balance_transactions/, responses: [{ status: 500, body: {} }] },
      ],
    });
    await c.listBalanceTransactions().catch(() => undefined);
    expect(meter.snapshot().spent).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocked boundary (services/erp-connector/__tests__/connector.test.ts:1-51)
// ─────────────────────────────────────────────────────────────────────────────

describe("blocked boundary — nothing configured", () => {
  const cfg = { credentialsSecretRef: "secret://stripe/acct_1Fixture" };

  function bare() {
    // No resolveApiKey: the shipped-off state ADR-041 §2 requires.
    return new StripeConnector(cfg, { fetchImpl: async () => ({}) as Response, now: () => NOW });
  }

  it("is the stripe provider and declares its datasets", () => {
    expect(bare().provider).toBe(STRIPE_PROVIDER);
    expect(bare().servesDatasets).toEqual(STRIPE_DATASETS);
  });

  it("rejects EVERY I/O method with ConnectorBlockedError", async () => {
    // Mutation: let health() resolve `{ ok: false }` instead of rejecting → red.
    // A connector that reports unhealthy-but-answering is the "looks connected,
    // syncs nothing" failure ADR-041 §5 exists to prevent.
    const c = bare();
    await expect(c.connect()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.runRead("get_open_invoices", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listBalanceTransactions()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.pollEvents({ cursor: NOW_S - 600 })).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
  });

  it("reports the disconnected state explicitly rather than inferring it", async () => {
    // Mutation: derive `state` from whether a key happens to be cached → red.
    const s = await bare().status();
    expect(s.state).toBe("disconnected");
    expect(s.ok).toBe(false);
  });

  it("holds no key material — the config is a secret-store pointer", async () => {
    // Mutation: add an `apiKey` field to StripeConnectorConfig → red.
    expect(JSON.stringify(cfg)).not.toContain("rk_");
    expect(JSON.stringify(cfg)).not.toMatch(/sk_|pk_/);
    expect(cfg.credentialsSecretRef.startsWith("secret://")).toBe(true);
    const s = await bare().status();
    expect(JSON.stringify(s)).not.toContain("rk_");
  });

  it("never puts key material in a rendered status of a LIVE connection", async () => {
    // Mutation: surface the resolved key on the status object → red.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ body: { data: [], has_more: false } }] }],
    });
    const s = await c.status();
    expect(s.hasApiKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain("rk_");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No money movement — enforced by the build, not by intent
// ─────────────────────────────────────────────────────────────────────────────

describe("no money movement", () => {
  it("has no refund, payout or transfer endpoint anywhere in the Stripe source", () => {
    // "We didn't build it" is not enforceable; "the build goes red" is.
    // Mutation: add `/v1/refunds` (or payouts, or transfers) as a literal
    // request path in this directory → red.
    for (const p of stripeSources()) {
      const src = readFileSync(p, "utf8");
      for (const forbidden of ["/v1/refunds", "/v1/payouts", "/v1/transfers", "/v1/topups"]) {
        expect(src).not.toContain(forbidden);
      }
    }
  });

  it("keeps every dialable collection on an allowlist that names no money movement", () => {
    // The literal scan above is NOT sufficient on its own, and this test exists
    // because a mutation proved it: request paths are assembled at runtime
    // (`/v1/${route.collection}/${id}`), so adding a `payouts` collection to the
    // event-route table introduces a money-movement endpoint while the string
    // "/v1/payouts" never appears in the source at all. The allowlist is the
    // closed-by-construction guard; the scans are belt to its braces.
    // Mutation: add "payouts" to STRIPE_READABLE_COLLECTIONS → red.
    for (const c of STRIPE_READABLE_COLLECTIONS) {
      expect(c).not.toMatch(/refund|payout|transfer|topup/i);
    }
  });

  it("admits no event route to a collection outside the allowlist", () => {
    // Mutation: add `{ prefix: "payout.", collection: "payouts", ... }` to
    // EVENT_OBJECT_ROUTES → red.
    for (const r of EVENT_OBJECT_ROUTES) {
      expect(STRIPE_READABLE_COLLECTIONS.has(r.collection)).toBe(true);
      expect(`${r.prefix}${r.collection}${r.objectType}`).not.toMatch(
        /refund|payout|transfer|topup/i,
      );
    }
  });

  it("reports a money-movement event as unmapped and never fetches it", async () => {
    // The route table is the first line: a payout event has no route, so no
    // URL is built for it and it is surfaced rather than silently dropped.
    // Mutation: add a payout route to EVENT_OBJECT_ROUTES → red.
    const { c, f } = connector({
      routes: [{ match: /\/v1\/events/, responses: [{ body: { data: [payoutEvent()] } }] }],
    });
    const out = await c.pollEvents({ cursor: NOW_S - 600 });
    expect(out.records).toHaveLength(0);
    expect(out.unmapped.map((u) => u.type)).toEqual(["payout.paid"]);
    expect(f.paths().some((p) => p.includes("payout"))).toBe(false);
  });

  it("throws on an off-allowlist collection rather than dialing it", () => {
    // The second line, and the one that catches a NEW request path whose author
    // did not think about the allowlist.
    // Mutation: make assertReadableStripeCollection a no-op → red.
    for (const bad of ["/v1/payouts", "/v1/refunds/re_1", "/v1/transfers", "/v1/topups"]) {
      expect(() => assertReadableStripeCollection(bad)).toThrow(ConnectorBlockedError);
    }
    for (const ok of [
      "/v1/balance_transactions",
      "/v1/invoices/in_1",
      "/v1/events",
      "/v1/reporting/report_runs",
      "/v1/reporting/report_runs/frr_1",
    ]) {
      expect(() => assertReadableStripeCollection(ok)).not.toThrow();
    }
  });

  it("wires that guard into the request builder, not just into this test", () => {
    // A guard nobody calls is decoration. Reaching the call site through the
    // public API would need a source mutation the suite cannot perform, so the
    // wiring is asserted directly — the same technique the base-URL literal
    // check above uses, and for the same reason.
    // Mutation: delete the assertReadableStripeCollection(path) call from
    // `request()` → red.
    const src = readFileSync(stripeSourcePath("connector.ts"), "utf8");
    expect(src).toContain("assertReadableStripeCollection(path);");
  });

  it("exposes no method whose name implies moving money", async () => {
    // Mutation: add `createRefund()` to StripeConnector → red.
    const mod = (await import("../src/stripe/connector.js")) as Record<string, unknown>;
    const surface = [
      ...Object.keys(mod),
      ...Object.getOwnPropertyNames(StripeConnector.prototype),
    ];
    for (const name of surface) {
      expect(name).not.toMatch(/refund|payout|transfer|topup/i);
    }
  });

  it("refuses applyWrite outright — a customer's ledger is not ours to change", async () => {
    // Mutation: let applyWrite fall through to a request → red.
    const { c, f } = connector();
    await expect(c.applyWrite("update_appointment_status", {})).rejects.toBeInstanceOf(Error);
    expect(f.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read surface
// ─────────────────────────────────────────────────────────────────────────────

describe("read surface", () => {
  it("maps Stripe invoices onto the canonical invoice columns", async () => {
    // Mutation: drop the minor-unit conversion → red (1200 cents read as $1200).
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/invoices/,
          responses: [
            {
              body: {
                has_more: false,
                data: [
                  {
                    id: "in_1",
                    number: "INV-1001",
                    created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
                    due_date: Math.floor(Date.UTC(2026, 6, 31) / 1000),
                    customer: "cus_1",
                    currency: "usd",
                    total: 120_000,
                    amount_remaining: 120_000,
                    status: "open",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoice_id: "INV-1001",
      customer_id: "cus_1",
      amount: 1200,
      balance: 1200,
      status: "open",
    });
    expect(rows[0].issued_at).toBe("2026-07-01T00:00:00.000Z");
  });

  it("converts zero-decimal and three-decimal currencies correctly", async () => {
    // Stripe amounts are minor units, and JPY has none while BHD has three.
    // Dividing everything by 100 misstates a JPY ledger by 100x.
    // Mutation: hardcode `/ 100` → red.
    const jpy = await currencyRow("jpy", 5000);
    expect(jpy.amount).toBe(5000);
    const bhd = await currencyRow("bhd", 5000);
    expect(bhd.amount).toBe(5);
  });

  async function currencyRow(currency: string, total: number) {
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/invoices/,
          responses: [
            {
              body: {
                has_more: false,
                data: [
                  { id: "in_1", created: 0, customer: "cus_1", currency, total, amount_remaining: total, status: "open" },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    return rows[0] as { amount: number };
  }

  it("refuses a read whose dataset this track does not serve", async () => {
    // Stripe has no appointments, and saying so is a capability, not a fault.
    // Mutation: widen STRIPE_DATASETS to every dataset → red.
    const { c, f } = connector();
    await expect(c.runRead("get_schedule_today", {})).rejects.toBeInstanceOf(
      DatasetNotServedError,
    );
    expect(f.calls).toHaveLength(0);
  });

  it("maps balance transactions with their fee and net", async () => {
    // /v1/balance_transactions is the single best read Stripe exposes: every
    // inflow and outflow with its fee and its net.
    // Mutation: drop `fee` or `net` from the projection → red.
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/balance_transactions/,
          responses: [
            {
              body: {
                has_more: false,
                data: [
                  {
                    id: "txn_1",
                    created: Math.floor(Date.UTC(2026, 7, 1) / 1000),
                    type: "charge",
                    currency: "usd",
                    amount: 10_000,
                    fee: 320,
                    net: 9_680,
                    status: "available",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = await c.listBalanceTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transaction_id: "txn_1",
      type: "charge",
      amount: 100,
      fee: 3.2,
      net: 96.8,
      status: "available",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payments read surface (WARP-2497)
// ─────────────────────────────────────────────────────────────────────────────

describe("payments read surface (WARP-2497)", () => {
  it("declares that it serves the charge dataset", () => {
    // Until WARP-2497 this track served `invoice` only, so `get_recent_charges`
    // was refused by `assertDatasetsServed` before a request was ever built —
    // which made "what did we bill last week" unanswerable even with a
    // CONNECTED account and a charge history sitting right there.
    // Mutation: drop "charge" from STRIPE_DATASETS → red.
    expect(STRIPE_DATASETS).toContain("charge");
  });

  it("maps Stripe charges onto the canonical charge columns", async () => {
    // Mutation: drop the majorUnits() conversion on `amount` → red
    // (2500 minor units would read as $2500 instead of $25).
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/charges/,
          responses: [
            {
              body: {
                has_more: false,
                data: [
                  {
                    id: "ch_1",
                    created: Math.floor(Date.UTC(2026, 7, 20) / 1000),
                    customer: "cus_1",
                    amount: 2500,
                    amount_refunded: 500,
                    currency: "usd",
                    status: "succeeded",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_recent_charges", {
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    })) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      charge_id: "ch_1",
      customer_id: "cus_1",
      amount: 25,
      amount_refunded: 5,
      currency: "usd",
      status: "succeeded",
    });
    expect(rows[0].created_at).toBe("2026-08-20T00:00:00.000Z");
  });

  it("pushes the [from, to) window to Stripe instead of paging all history", async () => {
    // The window is the whole point of the allocation guard: a read that pulls
    // every charge ever and filters locally spends the merchant's monthly
    // allocation on one question. `created[gte]`/`created[lt]` are Stripe's own
    // half-open filter and must appear on the wire.
    // Mutation: delete the `created[gte]`/`created[lt]` search entries → red.
    const { c, f } = connector({
      routes: [{ match: /\/v1\/charges/, responses: [{ body: { has_more: false, data: [] } }] }],
    });
    await c.runRead("get_recent_charges", {
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    });
    expect(f.calls).toHaveLength(1);
    const url = new URL(f.calls[0].url);
    expect(url.pathname).toBe("/v1/charges");
    expect(url.searchParams.get("created[gte]")).toBe(
      String(Math.floor(Date.UTC(2026, 7, 1) / 1000)),
    );
    expect(url.searchParams.get("created[lt]")).toBe(
      String(Math.floor(Date.UTC(2026, 8, 1) / 1000)),
    );
  });

  it("returns charges newest first", async () => {
    // The canonical ordering for this dataset (read-queries.ts orders by
    // created_at DESC, charge_id). Stripe's own list order is not contractual,
    // so the sort has to be ours.
    // Mutation: remove the descending sort → red.
    const day = (d: number) => Math.floor(Date.UTC(2026, 7, d) / 1000);
    const row = (id: string, created: number) => ({
      id,
      created,
      customer: "cus_1",
      amount: 100,
      currency: "usd",
      status: "succeeded",
    });
    const { c } = connector({
      routes: [
        {
          match: /\/v1\/charges/,
          responses: [
            {
              body: {
                has_more: false,
                data: [row("ch_old", day(1)), row("ch_new", day(9)), row("ch_mid", day(5))],
              },
            },
          ],
        },
      ],
    });
    const rows = (await c.runRead("get_recent_charges", {
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    })) as Record<string, unknown>[];
    expect(rows.map((r) => r.charge_id)).toEqual(["ch_new", "ch_mid", "ch_old"]);
  });

  it("still refuses a payments dataset this track does not serve", async () => {
    // WARP-2497 widened `charge` ONLY. `refund` and `payout` have read queries
    // and vocabulary entries but no Stripe implementation and no entry in
    // STRIPE_READABLE_COLLECTIONS, so they must still refuse on ZERO calls
    // rather than silently returning nothing.
    // Mutation: add "refund" to STRIPE_DATASETS → red.
    const { c, f } = connector();
    await expect(c.runRead("get_refunds", {})).rejects.toBeInstanceOf(DatasetNotServedError);
    expect(f.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

const STRIPE_DIR = join(fileURLToPath(new URL("../src/stripe/", import.meta.url)));

function stripeSourcePath(f: string): string {
  return join(STRIPE_DIR, f);
}
function stripeSources(): string[] {
  return readdirSync(STRIPE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(STRIPE_DIR, f));
}

function event(
  over: { id?: string; created?: number; objectId?: string; type?: string; object?: unknown } = {},
) {
  const objectId = over.objectId ?? "in_1";
  return {
    id: over.id ?? "evt_1",
    type: over.type ?? "invoice.updated",
    created: over.created ?? NOW_S - 60,
    api_version: "2019-05-16",
    data: { object: over.object ?? { id: objectId, object: "invoice" } },
  };
}

function invoiceObject() {
  return {
    id: "in_1",
    object: "invoice",
    number: "INV-1001",
    created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
    customer: "cus_1",
    currency: "usd",
    total: 120_000,
    amount_remaining: 1200,
    status: "open",
  };
}

/** A money-movement event. This connector maps no route for it. */
function payoutEvent() {
  return {
    id: "evt_po",
    type: "payout.paid",
    created: NOW_S - 60,
    data: { object: { id: "po_1", object: "payout" } },
  };
}

function reportRun(status: string, fileId = "file_1") {
  return {
    id: "frr_1",
    object: "reporting.report_run",
    status,
    report_type: "balance.summary.1",
    result: status === "succeeded" ? { id: fileId, object: "file" } : null,
  };
}

/**
 * A report file, shaped like `balance_change_from_activity.itemized.3`.
 *
 * Deliberately awkward, because real exports are: a UTF-8 BOM, CRLF line
 * endings, and a merchant-authored description carrying both a comma and a
 * doubled quote. All three break `split(",")`, and the failure mode is a
 * silently mis-columned ledger rather than a thrown parse error.
 */
const REPORT_HEADER =
  "\uFEFFbalance_transaction_id,created_utc,reporting_category,currency,gross,fee,net,status,description\r\n";

const REPORT_CSV =
  REPORT_HEADER +
  'txn_1,2026-05-01 12:00:00,charge,usd,10.00,0.59,9.41,available,"Acme, Inc. ""monthly"" plan"\r\n' +
  "txn_2,2026-05-02 08:30:00,charge,usd,25.00,1.03,23.97,available,plain row\r\n";

const REPORT_CSV_2 =
  REPORT_HEADER +
  "txn_3,2026-06-01 09:00:00,charge,usd,5.00,0.45,4.55,available,june one\r\n" +
  "txn_4,2026-06-02 09:00:00,adjustment,usd,-2.00,0.00,-2.00,available,june two\r\n" +
  "txn_5,2026-06-03 09:00:00,charge,jpy,5000,150,4850,available,june three\r\n";

const REPORT_CSV_3 =
  REPORT_HEADER +
  "txn_6,2026-07-01 09:00:00,charge,usd,1.00,0.33,0.67,available,july one\r\n" +
  "txn_7,2026-07-02 09:00:00,charge,usd,2.00,0.36,1.64,available,july two\r\n";
