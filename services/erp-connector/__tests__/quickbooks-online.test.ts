/**
 * WARP-2109 — QuickBooksOnlineConnector.
 *
 * `fetch` is injected, never patched globally, and every test asserts on the
 * CALLS the connector made — not only on what it returned. That distinction is
 * the point of most of this file: the budget guard and the capability check are
 * both promises about requests that must NOT happen, and a test that checks
 * only the return value passes even when the request already went out.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect } from "vitest";

import {
  CallBudget,
  QBO_DATASETS,
  QBO_MINOR_VERSION,
  QuickBooksOnlineConnector,
  QuotaExhaustedError,
  ReauthorizationRequiredError,
  type QboTokens,
} from "../src/quickbooks/online-connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { UnsafeBaseUrlError, assertSafeBaseUrl } from "../src/quickbooks/online-connector.js";
import { CANONICAL_COLUMNS } from "../src/export-drop/profiles.js";

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function tokens(over: Partial<QboTokens> = {}): QboTokens {
  return {
    accessToken: "access-tok-SECRET",
    refreshToken: "refresh-tok-SECRET",
    accessExpiresAt: NOW + 3600_000,
    refreshExpiresAt: NOW + 100 * DAY,
    ...over,
  };
}

/** A fetch stub that records every call and replays queued responses. */
function stubFetch(pages: unknown[], status = 200) {
  const calls: string[] = [];
  let i = 0;
  const impl = async (url: string) => {
    calls.push(url);
    const body = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  };
  return { impl, calls };
}

function qbo(
  opts: {
    pages?: unknown[];
    status?: number;
    tok?: QboTokens;
    ceiling?: number;
    persist?: (t: QboTokens) => Promise<void>;
    budget?: CallBudget;
  } = {},
) {
  const { impl, calls } = stubFetch(opts.pages ?? [{ QueryResponse: {} }], opts.status);
  const c = new QuickBooksOnlineConnector(
    { realmId: "9130350", credentialsSecretRef: "secret://qbo/9130350", callCeiling: opts.ceiling },
    {
      fetchImpl: impl,
      now: () => NOW,
      resolveTokens: async () => opts.tok ?? tokens(),
      persistTokens: opts.persist,
      budget: opts.budget,
    },
  );
  return { c, calls };
}

const INVOICE_PAGE = {
  QueryResponse: {
    Invoice: [
      {
        Id: "1",
        DocNumber: "INV-1001",
        TxnDate: "2026-07-01",
        DueDate: "2026-07-31",
        CustomerRef: { value: "12", name: "Northside Clinic" },
        TotalAmt: 1200,
        Balance: 1200,
      },
      {
        Id: "2",
        DocNumber: "INV-0999",
        TxnDate: "2026-06-02",
        DueDate: "2026-07-02",
        CustomerRef: { value: "12", name: "Northside Clinic" },
        TotalAmt: 500,
        Balance: 0,
      },
    ],
  },
};

const BILL_PAGE = {
  QueryResponse: {
    Bill: [
      {
        Id: "7",
        DocNumber: "BILL-77",
        TxnDate: "2026-07-05",
        DueDate: "2026-08-04",
        VendorRef: { value: "44", name: "Henry Schein" },
        TotalAmt: 2000,
        Balance: 2000,
      },
      {
        Id: "8",
        DocNumber: "BILL-78",
        TxnDate: "2026-07-20",
        DueDate: "2026-08-19",
        VendorRef: { value: "45", name: "Patterson Dental" },
        TotalAmt: 850.25,
        Balance: 850.25,
      },
      {
        Id: "9",
        DocNumber: "BILL-79",
        TxnDate: "2026-07-21",
        DueDate: "2026-08-20",
        VendorRef: { value: "44", name: "Henry Schein" },
        TotalAmt: 100,
        Balance: 0,
      },
    ],
  },
};

// ── the budget: a fleet-wide failure domain ─────────────────────────────────

describe("the CorePlus budget protects the whole fleet, not just this box", () => {
  it("refuses a read with ZERO network calls once exhausted", async () => {
    // THE load-bearing test. Intuit's free tier BLOCKS rather than bills, and
    // the allowance is shared across every connected company — so one chatty
    // appliance does not run up a bill, it stops every other customer's
    // integration working. An over-budget call must never reach the wire.
    //
    // Mutation: move budget.assertHeadroom() below the fetch, or delete it →
    // calls.length becomes 1 → red. Asserting only on the thrown error would
    // pass even though the request already went out.
    const { c, calls } = qbo({ pages: [BILL_PAGE], ceiling: 0 });
    await expect(c.runRead("get_open_bills", {})).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(calls).toHaveLength(0);
  });

  it("counts only successful data-out calls", async () => {
    // Intuit meters 2xx responses. Charging ourselves for failures would drain
    // the allowance fastest exactly when the integration is already unhealthy.
    // Mutation: record() before the status checks → spent becomes 1 → red.
    const budget = new CallBudget(10, () => NOW);
    const { c } = qbo({ status: 429, budget });
    await expect(c.runRead("get_open_bills", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(budget.snapshot().spent).toBe(0);
  });

  it("spends exactly one call per page and reports it", async () => {
    // Mutation: drop the record() call → spent stays 0 and the ceiling never
    // engages, which is the silent version of the fleet outage above.
    const budget = new CallBudget(10, () => NOW);
    const { c } = qbo({ pages: [BILL_PAGE], budget });
    await c.runRead("get_open_bills", {});
    expect(budget.snapshot().spent).toBe(1);
    expect((await c.status()).budget.remaining).toBe(9);
  });

  it("rolls the period over and restores headroom", () => {
    // Mutation: never reset `spent` on roll → a box is dead forever after one
    // busy month.
    let t = NOW;
    const budget = new CallBudget(1, () => t);
    budget.record();
    expect(() => budget.assertHeadroom()).toThrow(QuotaExhaustedError);
    t = NOW + 31 * DAY;
    expect(() => budget.assertHeadroom()).not.toThrow();
  });
});

// ── three failure states that must stay distinguishable ─────────────────────

describe("failure states are distinguishable", () => {
  it("401 is a re-consent, not a transport fault", async () => {
    // A revoked grant is cleared only by a person. Reporting it as blocked
    // sends someone hunting a bug that does not exist.
    // Mutation: fold 401 into the generic !res.ok branch → ConnectorBlocked → red.
    const { c } = qbo({ status: 401, pages: [{}] });
    await expect(c.runRead("get_open_bills", {})).rejects.toBeInstanceOf(
      ReauthorizationRequiredError,
    );
  });

  it("429 is Intuit's throttle, not our quota", async () => {
    // Different fix: back off, versus raise a tier. Mutation: map 429 to
    // QuotaExhaustedError → red.
    const { c } = qbo({ status: 429, pages: [{}] });
    const err = await c.runRead("get_open_bills", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err).not.toBeInstanceOf(QuotaExhaustedError);
  });

  it("an expired refresh token is refused before any network call", async () => {
    // The operationally dangerous one: a box offline past the refresh window
    // loses the connection permanently. It must not look like a 401 one
    // morning. Mutation: check refreshExpiresAt after the fetch → calls === 1.
    const { c, calls } = qbo({ tok: tokens({ refreshExpiresAt: NOW - 1 }) });
    await expect(c.runRead("get_open_bills", {})).rejects.toBeInstanceOf(
      ReauthorizationRequiredError,
    );
    expect(calls).toHaveLength(0);
  });

  it("warns before the refresh token lapses, not after", async () => {
    // Mutation: report reauthorizeSoon only once expired → red. A warning that
    // arrives after the outage is not a warning.
    const { c } = qbo({ tok: tokens({ refreshExpiresAt: NOW + 3 * DAY }) });
    await c.runRead("get_open_bills", {}).catch(() => undefined);
    const s = await c.status();
    expect(s.reauthorizeSoon).toBe(true);
    expect(s.reauthorizeInDays).toBe(3);

    const { c: healthy } = qbo();
    await healthy.runRead("get_open_bills", {}).catch(() => undefined);
    expect((await healthy.status()).reauthorizeSoon).toBe(false);
  });

  it("never renders any failure as an empty result", async () => {
    // Mutation: catch and `return []` anywhere in runRead → red. `[]` from
    // get_open_bills reads as "you owe nobody anything".
    for (const status of [401, 429, 500]) {
      const { c } = qbo({ status, pages: [{}] });
      const out = await c.runRead("get_open_bills", {}).catch((e: unknown) => e);
      expect(Array.isArray(out), `status ${status} returned rows`).toBe(false);
      expect(out).toBeInstanceOf(Error);
    }
  });

  it("leaks no token material into any error", async () => {
    // Errors travel into the chat transcript via error.details. Mutation: put
    // the request URL or an Authorization header into a message → red.
    const { c } = qbo({ status: 500, pages: [{}] });
    const err = (await c.runRead("get_open_bills", {}).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("SECRET");
    expect(JSON.stringify(err.message)).not.toContain("Bearer");
  });
});

// ── tokens ──────────────────────────────────────────────────────────────────

describe("token custody", () => {
  it("blocks honestly when no OAuth refresh hook is wired", async () => {
    // Intuit rotates the refresh token on use, and the client secret belongs to
    // the orchestrator — a connector that half-authenticates would be worse
    // than one that says it cannot.
    // Mutation: return the stale tokens instead of throwing → the connector
    // would send an expired access token and get an opaque 401.
    const { c, calls } = qbo({ tok: tokens({ accessExpiresAt: NOW - 1 }) });
    await expect(c.runRead("get_open_bills", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });
});

// ── the reads ───────────────────────────────────────────────────────────────

describe("reads", () => {
  it("returns rows whose shape matches the export-drop track exactly", async () => {
    // The whole point of the shared read registry: a consumer must not be able
    // to tell which track answered by probing for a key.
    // Mutation: drop `status` from the mapped row (QBO has no status column) →
    // red. An unmapped canonical column is present-and-undefined, not absent.
    const { c } = qbo({ pages: [INVOICE_PAGE] });
    const rows = (await c.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.invoice].sort());
  });

  it("filters to open items on balance, not on a status string", async () => {
    // INV-0999 is fully paid. Mutation: drop the filter → 2 rows → red.
    const { c } = qbo({ pages: [INVOICE_PAGE] });
    const rows = (await c.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(rows.map((r) => r.invoice_id)).toEqual(["INV-1001"]);
    expect(rows[0].balance).toBe(1200);
    // Canonical ISO instant, matching every other track's date-only handling.
    // Mutation: pass "2026-07-31" through → red.
    expect(rows[0].due_at).toBe("2026-07-31T00:00:00.000Z");
    // The human-readable name, not the opaque id — "who do we owe" is useless
    // as a number. Mutation: prefer `value` → "12" → red.
    expect(rows[0].customer_id).toBe("Northside Clinic");
  });

  it("keeps a document whose balance is missing rather than dropping it", async () => {
    // Money we cannot account for stays visible; dropping it understates what
    // is owed, silently. Mutation: treat a missing balance as 0 and filter it
    // out → 0 rows → red.
    const { c } = qbo({
      pages: [{ QueryResponse: { Bill: [{ Id: "1", DocNumber: "B-1", VendorRef: { name: "X" } }] } }],
    });
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBeUndefined();
  });

  it("aggregates payables from the same bills the list read returns", async () => {
    // Two sources for one number can disagree; one cannot. BILL-79 is paid and
    // must not create a third vendor row or inflate the total.
    // Mutation: count rows instead of distinct vendors → vendor_count 3 → red.
    const { c } = qbo({ pages: [BILL_PAGE] });
    const rows = (await c.runRead("get_ap_summary", {})) as Record<string, unknown>[];
    expect(rows).toEqual([
      { vendor_count: 2, total_balance: 2850.25, unaccounted_count: 0 },
    ]);
  });

  it("counts a bill it cannot read rather than dropping it from the total", async () => {
    // The contradiction a pre-PR review found: `get_open_bills` KEEPS a bill
    // whose Balance will not parse, while the summary silently skipped it — so
    // one document was listed as money owed and contributed nothing to what the
    // business was told it owed.
    //
    // Mutation: filter unparseable balances out before aggregating →
    // unaccounted_count 0 and the vendor disappears → red.
    const { c } = qbo({
      pages: [
        {
          QueryResponse: {
            Bill: [
              { Id: "1", DocNumber: "B-1", VendorRef: { name: "Henry Schein" }, Balance: 2000 },
              { Id: "2", DocNumber: "B-2", VendorRef: { name: "Mystery Co" } },
            ],
          },
        },
      ],
    });
    const listed = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    const summary = (await c.runRead("get_ap_summary", {})) as Record<string, unknown>[];
    // Both reads see the same two documents. The summary says so.
    expect(listed).toHaveLength(2);
    expect(summary).toEqual([
      { vendor_count: 2, total_balance: 2000, unaccounted_count: 1 },
    ]);
  });

  it("does not report itself healthy before a company is connected", async () => {
    // `health()` used to ask about the budget and the token clock, and an
    // absent token failed neither — so an unconsented connection was "healthy".
    // Mutation: derive health from the budget/clock again → red.
    const unconfigured = new QuickBooksOnlineConnector({
      realmId: "9130350",
      credentialsSecretRef: "secret://qbo/9130350",
    });
    await expect(unconfigured.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect((await unconfigured.status()).ok).toBe(false);
  });

  it("pins the API minor version on every request", async () => {
    // Without it Intuit serves "current", so a field can change shape under a
    // box nobody has touched. Mutation: drop the param → red.
    const { c, calls } = qbo({ pages: [BILL_PAGE] });
    await c.runRead("get_open_bills", {});
    expect(calls[0]).toContain(`minorversion=${QBO_MINOR_VERSION}`);
  });

  it("pages until a short page and stops", async () => {
    // Mutation: return after the first page → the second page's rows vanish and
    // the payables total is silently short.
    const full = {
      QueryResponse: {
        Bill: Array.from({ length: 1000 }, (_, i) => ({
          Id: String(i),
          DocNumber: `B-${i}`,
          VendorRef: { name: "Acme" },
          Balance: 1,
        })),
      },
    };
    const short = {
      QueryResponse: { Bill: [{ Id: "x", DocNumber: "B-last", VendorRef: { name: "Acme" }, Balance: 5 }] },
    };
    const { c, calls } = qbo({ pages: [full, short] });
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1001);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(encodeURIComponent("STARTPOSITION 1001"));
  });
});

// ── ADR-041: the cloud-connector contract ───────────────────────────────────

describe("ADR-041 connection state", () => {
  it("reports disconnected when the owner has not connected a company", async () => {
    // ADR-041 §2: a cloud connector ships OFF. With no token resolver wired
    // (the default `blockedTokenResolver`) there is no connection, and saying
    // so is the shipped-off state — not an error.
    //
    // Note this is deliberately built WITHOUT the test helper, which always
    // supplies working tokens. An earlier version of this test used the helper
    // and passed only because `state()` was reading a lazily-populated cache —
    // it reported "disconnected" for a perfectly well-configured connection
    // that simply had not been read from yet. Mutation: go back to inferring
    // state from `this.tokens` → the "lapsed grant outranks budget" case below
    // turns red.
    const unconfigured = new QuickBooksOnlineConnector({
      realmId: "9130350",
      credentialsSecretRef: "secret://qbo/9130350",
    });
    expect((await unconfigured.status()).state).toBe("disconnected");
  });

  it("reports connected once a live token is in hand", async () => {
    const { c } = qbo({ pages: [BILL_PAGE] });
    await c.runRead("get_open_bills", {});
    expect((await c.status()).state).toBe("connected");
  });

  it("ranks a lapsed grant above an exhausted budget", async () => {
    // Both are true; only re-consenting helps, and waiting for the period to
    // roll would not. Mutation: check the budget first → "error" → red, and a
    // user would be told to wait for something that will never resolve.
    const budget = new CallBudget(0, () => NOW);
    const { c } = qbo({ tok: tokens({ refreshExpiresAt: NOW - 1 }), budget });
    await c.runRead("get_open_bills", {}).catch(() => undefined);
    expect((await c.status()).state).toBe("needs_reconnect");
  });

  it("uses only ADR-041's vocabulary", async () => {
    // Mutation: invent a sixth state → red. The orchestrator and the dashboard
    // both switch on this; a novel value renders as nothing.
    const allowed = ["disconnected", "pending_consent", "connected", "needs_reconnect", "error"];
    const { c } = qbo({ pages: [BILL_PAGE] });
    expect(allowed).toContain((await c.status()).state);
    await c.runRead("get_open_bills", {});
    expect(allowed).toContain((await c.status()).state);
  });
});

describe("the bearer token only ever goes to Intuit", () => {
  it("refuses a non-Intuit host at construction", () => {
    // `baseUrl` is operator configuration and was accepted with no checks, so a
    // misconfigured or malicious connection row shipped an account-level access
    // token in an Authorization header to any host on the internet.
    // Mutation: drop the host check → constructing succeeds → red.
    expect(
      () =>
        new QuickBooksOnlineConnector({
          realmId: "1",
          credentialsSecretRef: "r",
          baseUrl: "https://attacker.example",
        }),
    ).toThrow(UnsafeBaseUrlError);
  });

  it("refuses cleartext http even to Intuit", () => {
    // A bearer token over http is the token given away.
    // Mutation: drop the protocol check → red.
    expect(() => assertSafeBaseUrl("http://quickbooks.api.intuit.com")).toThrow(/not https/);
  });

  it("refuses a URL carrying userinfo", () => {
    // Some clients resolve https://evil@real-host to a different authority than
    // a reader expects. Mutation: drop the userinfo check → red.
    expect(() => assertSafeBaseUrl("https://evil@quickbooks.api.intuit.com")).toThrow(/userinfo/);
  });

  it("allows production and sandbox", () => {
    // The reason baseUrl is configurable at all. Mutation: hardcode the
    // production host → the sandbox case throws → red.
    expect(assertSafeBaseUrl("https://quickbooks.api.intuit.com")).toBe(
      "https://quickbooks.api.intuit.com",
    );
    expect(assertSafeBaseUrl("https://sandbox-quickbooks.api.intuit.com/")).toBe(
      "https://sandbox-quickbooks.api.intuit.com",
    );
  });

  it("is not fooled by a lookalike host", () => {
    // Mutation: use `includes(".intuit.com")` instead of a suffix test → the
    // first case passes → red.
    expect(() => assertSafeBaseUrl("https://quickbooks.api.intuit.com.evil.test")).toThrow(
      UnsafeBaseUrlError,
    );
    expect(() => assertSafeBaseUrl("https://notintuit.com")).toThrow(UnsafeBaseUrlError);
  });
});

// ── capability and posture ──────────────────────────────────────────────────

describe("capability and posture", () => {
  it("refuses a practice read without touching the network", async () => {
    // A QuickBooks company has no appointments. Not a fault, not fixable.
    // Mutation: remove the assertDatasetsServed call → the connector queries
    // Intuit for an entity that does not exist and burns a metered call.
    const { c, calls } = qbo();
    await expect(c.runRead("get_schedule_today", { from: "a", to: "b" })).rejects.toBeInstanceOf(
      DatasetNotServedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("declares exactly the accounting datasets", () => {
    // Mutation: add "patient" → red.
    expect([...QBO_DATASETS].sort()).toEqual(["ap_summary", "bill", "invoice"]);
  });

  it("refuses every write", async () => {
    // Writes are the FREE half of Intuit's meter, which is precisely the wrong
    // reason to enable them against a customer's books.
    // Mutation: allow any write path → red.
    const { c, calls } = qbo();
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("moves the fingerprint when the pinned minor version changes", async () => {
    // A minor-version bump can change field shapes without touching our
    // canonical column list, so a fingerprint blind to it reports "no drift"
    // across a real one. Mutation: drop the `:mv` suffix → red.
    const { c } = qbo();
    const fp = (await c.introspect()).fingerprint;
    expect(fp).toContain(`:mv${QBO_MINOR_VERSION}`);
  });
});
