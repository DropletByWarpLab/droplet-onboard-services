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
  QBO_MAX_PAGES,
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
        // WARP-2475 — Intuit's shape exactly: local wall-clock with an offset,
        // and EDITED two weeks after TxnDate. That gap is the whole point of
        // the column: a `TxnDate` fallback would report 07-01 for a document
        // last touched on 07-15, which is a creation time wearing a
        // modification time's name.
        MetaData: { CreateTime: "2026-07-01T09:37:38-07:00", LastUpdatedTime: "2026-07-15T11:17:56-07:00" },
      },
      {
        Id: "2",
        DocNumber: "INV-0999",
        TxnDate: "2026-06-02",
        DueDate: "2026-07-02",
        CustomerRef: { value: "12", name: "Northside Clinic" },
        TotalAmt: 500,
        Balance: 0,
        MetaData: { CreateTime: "2026-06-02T08:00:00-07:00", LastUpdatedTime: "2026-06-20T16:05:00-07:00" },
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
        MetaData: { CreateTime: "2026-07-05T07:12:00-07:00", LastUpdatedTime: "2026-07-06T08:30:00-07:00" },
      },
      {
        Id: "8",
        DocNumber: "BILL-78",
        TxnDate: "2026-07-20",
        DueDate: "2026-08-19",
        VendorRef: { value: "45", name: "Patterson Dental" },
        TotalAmt: 850.25,
        Balance: 850.25,
        // WARP-2475 — NO `MetaData`. Intuit documents it on every entity, so
        // this row is the defensive case: a response that omits it must leave
        // `updated_at` undefined and must NOT throw, because a whole read
        // failing on one odd row would take the practice's payables with it.
        // Kept in the SHIPPED fixture rather than a bespoke one so the
        // absent-MetaData path is exercised by every test that reads bills.
      },
      {
        Id: "9",
        DocNumber: "BILL-79",
        TxnDate: "2026-07-21",
        DueDate: "2026-08-20",
        VendorRef: { value: "44", name: "Henry Schein" },
        TotalAmt: 100,
        Balance: 0,
        MetaData: { CreateTime: "2026-07-21T10:00:00-07:00", LastUpdatedTime: "2026-07-22T09:15:30-07:00" },
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
    // Errors travel into the chat transcript via error.details.
    //
    // The tripwires are the token strings AND the request URL. Naming the URL
    // as a mutation was previously wrong: the token rides in a header, not the
    // query, so a leaked URL could never trip a "SECRET"/"Bearer" check and
    // that half of the claim could not fail. The realm id is customer-
    // identifying and belongs in neither.
    //
    // Mutation: interpolate the request URL into the blocked message → red.
    // Mutation: interpolate the access token → red.
    const { c } = qbo({ status: 500, pages: [{}] });
    const err = (await c.runRead("get_open_bills", {}).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("Bearer");
    expect(err.message).not.toContain("9130350");
    expect(err.message).not.toContain("quickbooks.api.intuit.com");
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

// ── WARP-2475: the vendor modification timestamp ────────────────────────────

describe("updated_at comes from MetaData.LastUpdatedTime", () => {
  it("normalises Intuit's offset timestamp to a UTC instant", async () => {
    // The vendor field is `MetaData.LastUpdatedTime`, confirmed against a raw
    // QBO Invoice response: it is local wall-clock with an offset
    // ("2026-07-15T11:17:56-07:00"), NOT UTC. Storing it verbatim would leave a
    // watermark comparing strings across mixed offsets, which orders a
    // -07:00 11:17 after a +00:00 18:17 that is the same instant.
    //
    // Mutation: drop `MetaData` from INV-1001 in INVOICE_PAGE → undefined → red.
    // Mutation: return the raw string instead of converting → red on the Z form.
    const { c } = qbo({ pages: [INVOICE_PAGE] });
    const rows = (await c.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(rows[0].updated_at).toBe("2026-07-15T18:17:56.000Z");
  });

  it("reads the MODIFICATION time, not the creation time", async () => {
    // The defect this column exists to prevent. INV-1001 was created 07-01 and
    // edited 07-15; every neighbouring field on the row is a creation-side
    // fact, so a builder that reached for the nearest plausible one is a live
    // risk rather than a hypothetical.
    // Mutation: map `MetaData.CreateTime`, or `TxnDate`, instead → red.
    const { c } = qbo({ pages: [INVOICE_PAGE] });
    const rows = (await c.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(rows[0].updated_at).not.toBe("2026-07-01T16:37:38.000Z"); // CreateTime
    expect(rows[0].updated_at).not.toBe(rows[0].issued_at); // TxnDate
  });

  it("fills it on bills too, from the same field", async () => {
    // Mutation: drop `MetaData` from BILL-77 in BILL_PAGE → undefined → red.
    const { c } = qbo({ pages: [BILL_PAGE] });
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    const b77 = rows.find((r) => r.bill_id === "BILL-77")!;
    expect(b77.updated_at).toBe("2026-07-06T15:30:00.000Z");
  });

  it("leaves it undefined when MetaData is absent, and does not throw", async () => {
    // BILL-78 carries no `MetaData` at all. The read must still complete and
    // still return the row: a practice's payables must not disappear because
    // one document came back without its metadata block.
    // Mutation: read `MetaData.LastUpdatedTime` unguarded → TypeError → red.
    // Mutation: fall back to TxnDate when MetaData is absent → red.
    const { c } = qbo({ pages: [BILL_PAGE] });
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    const b78 = rows.find((r) => r.bill_id === "BILL-78")!;
    expect(b78.updated_at).toBeUndefined();
    // present-and-undefined, never absent — the key-set contract the shape
    // test pins. Mutation: omit the key when MetaData is missing → red.
    expect(Object.keys(b78)).toContain("updated_at");
    // and the rest of the row is intact, so this is a missing timestamp and
    // not a half-parsed document.
    expect(b78.balance).toBe(850.25);
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

// ── pagination cannot run away ──────────────────────────────────────────────

describe("pagination cannot run away", () => {
  /**
   * A full, DISTINCT page per call — models an endpoint with endless rows.
   * Distinct on purpose: an endpoint replaying one page trips the no-progress
   * guard first, and these tests must reach the guards behind it.
   */
  function endlessBills(onCall?: () => void) {
    const calls: string[] = [];
    let n = 0;
    const impl = async (url: string) => {
      calls.push(url);
      onCall?.();
      const base = n * 1000;
      n += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          QueryResponse: {
            Bill: Array.from({ length: 1000 }, (_, i) => ({
              Id: String(base + i),
              DocNumber: `B-${base + i}`,
              VendorRef: { name: "Acme" },
              Balance: 1,
            })),
          },
        }),
      } as unknown as Response;
    };
    return { impl, calls };
  }

  it("stops at the page ceiling when the endpoint never returns a short page", async () => {
    // The shared CallBudget (5,000 calls/period) is FLEET protection; without
    // a per-read ceiling, one endpoint that never returns a short page burns
    // the entire period's budget inside a single get_open_bills call. Ceiling
    // breach is ConnectorBlocked — a fault — and must NOT be QuotaExhausted,
    // which tells the user nothing is broken and to wait a month.
    // Mutation: remove the QBO_MAX_PAGES check → the loop runs to the budget
    // (5,000 calls, QuotaExhaustedError) → red on every assertion here.
    const { impl, calls } = endlessBills();
    const c = new QuickBooksOnlineConnector(
      { realmId: "9130350", credentialsSecretRef: "r" },
      { fetchImpl: impl, now: () => NOW, resolveTokens: async () => tokens() },
    );
    const err = await c.runRead("get_open_bills", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err).not.toBeInstanceOf(QuotaExhaustedError);
    expect((err as Error).message).toMatch(/pages/);
    expect(calls).toHaveLength(QBO_MAX_PAGES);
  });

  it("throws after one repeated page instead of looping on a stuck STARTPOSITION", async () => {
    // An endpoint that ignores STARTPOSITION serves the same full window
    // forever: page.length never dips below PAGE, so the short-page exit can
    // never fire. Two identical full pages in a row is proof of no progress —
    // abort on the second, not at the ceiling.
    // Mutation: drop the fingerprint comparison → the read pages to the
    // ceiling (QBO_MAX_PAGES calls, not 2) → red.
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
    const { c, calls } = qbo({ pages: [full] });
    const err = await c.runRead("get_open_bills", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect((err as Error).message).toMatch(/advanc/);
    expect(calls).toHaveLength(2);
  });

  it("gives up when a read exceeds its wall-clock budget", async () => {
    // The ceiling and the no-progress guard bound CALLS; this bounds TIME, so
    // an endpoint dripping slow-but-distinct pages cannot pin a read (and the
    // budget and tokens behind it) open indefinitely. The clock is injected:
    // each page here costs two minutes against the five-minute budget, so the
    // deadline trips before the fourth query is issued.
    // Mutation: drop the deadline check → the read pages on to the ceiling
    // (QBO_MAX_PAGES calls, not 3) → red.
    let t = NOW;
    const { impl, calls } = endlessBills(() => {
      t += 2 * 60_000;
    });
    const c = new QuickBooksOnlineConnector(
      { realmId: "9130350", credentialsSecretRef: "r" },
      { fetchImpl: impl, now: () => t, resolveTokens: async () => tokens() },
    );
    const err = await c.runRead("get_open_bills", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect((err as Error).message).toMatch(/wall-clock/);
    expect(calls).toHaveLength(3);
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
    // Mutation: use `includes(".intuit.com")` instead of the exact-host set →
    // the first case passes → red.
    expect(() => assertSafeBaseUrl("https://quickbooks.api.intuit.com.evil.test")).toThrow(
      UnsafeBaseUrlError,
    );
    expect(() => assertSafeBaseUrl("https://notintuit.com")).toThrow(UnsafeBaseUrlError);
  });

  it("refuses every other Intuit host — the allowed set is exact, not a suffix", () => {
    // The registry names exactly two API hosts a baseUrl may legally be. The
    // old guard accepted any `*.intuit.com`, which made hosts the registry
    // never screened reachable — the opposite of what its own docstring
    // promised. Intuit's own oauth host is registered egress but is never a
    // baseUrl: the token exchange lives with the orchestrator, not here.
    // Mutation: restore `host.endsWith(".intuit.com")` → every host below is
    // accepted → red.
    const notBaseUrls = [
      "evil.intuit.com",
      "api.intuit.com",
      "intuit.com",
      "oauth.platform.intuit.com",
    ];
    for (const host of notBaseUrls) {
      expect(() => assertSafeBaseUrl(`https://${host}`), host).toThrow(UnsafeBaseUrlError);
    }
  });

  it("refuses an explicit port other than 443", () => {
    // allowed-egress.yaml registers the Intuit hosts under ports: [443]; a
    // baseUrl smuggling another port would make that record false.
    // Mutation: drop the port check → the first case constructs → red.
    expect(() => assertSafeBaseUrl("https://quickbooks.api.intuit.com:8443")).toThrow(
      UnsafeBaseUrlError,
    );
    // :443 is https spelled out — the URL parser normalises it away.
    expect(assertSafeBaseUrl("https://quickbooks.api.intuit.com:443")).toBe(
      "https://quickbooks.api.intuit.com",
    );
  });

  it("instructs fetch to fail on any redirect rather than follow it", async () => {
    // A 3xx must never carry the Authorization header to a new location. The
    // fetch spec strips it on cross-origin redirects, but the token's safety
    // should not rest on every runtime implementing that correctly — this API
    // has no legitimate redirect.
    // Mutation: drop `redirect: "error"` from the init → red.
    let init: Record<string, unknown> | undefined;
    const impl = async (_url: string, i?: Record<string, unknown>) => {
      init = i;
      return { ok: true, status: 200, json: async () => BILL_PAGE } as unknown as Response;
    };
    const c = new QuickBooksOnlineConnector(
      { realmId: "9130350", credentialsSecretRef: "r" },
      { fetchImpl: impl, now: () => NOW, resolveTokens: async () => tokens() },
    );
    await c.runRead("get_open_bills", {});
    expect(init?.redirect).toBe("error");
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

describe("WARP-2137 — a non-array entity is a contract break, not a TypeError", () => {
  // Unguarded, `qr[entity]` was cast straight to an array: `page.length` came
  // back undefined, `undefined < PAGE` was false, and the spread below threw a
  // bare "not iterable" TypeError from inside the pagination loop. That reached
  // the orchestrator as a generic fault naming neither the entity nor the shape.
  for (const [label, value] of [
    ["an object", { Id: "1" }],
    ["a string", "Invoice"],
    ["a number", 7],
  ] as const) {
    it(`refuses ${label} with a typed blocked error`, async () => {
      const { c } = qbo({ pages: [{ QueryResponse: { Invoice: value } }] });
      await c.connect();
      await expect(c.runRead("get_open_invoices", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    });
  }

  it("names the entity and the shape it got, so the report is actionable", async () => {
    const { c } = qbo({ pages: [{ QueryResponse: { Invoice: { Id: "1" } } }] });
    await c.connect();
    await expect(c.runRead("get_open_invoices", {})).rejects.toThrow(/Invoice \(object\)/);
  });

  it("treats an explicit null entity as no rows, exactly as the ?? it replaced did", async () => {
    // Tightening this into a refusal would turn a harmless, already-working
    // response into a hard failure for any company that answers null.
    const { c } = qbo({ pages: [{ QueryResponse: { Invoice: null } }] });
    await c.connect();
    await expect(c.runRead("get_open_invoices", {})).resolves.toEqual([]);
  });

  it("still treats a MISSING entity key as an empty result, not a fault", async () => {
    // An empty QuickBooks company answers `{}` with no entity key at all. That
    // is a legitimate "no rows" and must not be caught by the guard.
    const { c } = qbo({ pages: [{ QueryResponse: {} }] });
    await c.connect();
    await expect(c.runRead("get_open_invoices", {})).resolves.toEqual([]);
  });
});
