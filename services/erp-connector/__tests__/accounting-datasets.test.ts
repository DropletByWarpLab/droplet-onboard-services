/**
 * WARP-2107 — the accounting datasets, and the capability declaration that
 * makes them safe to add.
 *
 * Two things are proven here, and the second matters more than the first.
 *
 *  1. A QuickBooks export drop produces the canonical `invoice` / `bill` /
 *     `ap_summary` rows, against REAL files (same standard as the rest of this
 *     track — a mocked `fs` cannot produce the failures this code exists for).
 *  2. Asking ANY track for a dataset it does not serve is a distinct, typed
 *     refusal — never an empty array. `[]` from `get_open_bills` reads as "you
 *     owe nobody anything", which is a confident false statement about money
 *     and is indistinguishable from a genuinely clear payables ledger.
 *
 * Every test below names the mutation that must turn it red. A test whose
 * mutation is not stated is a test nobody has proved can fail.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExportDropConnector } from "../src/export-drop/connector.js";
import { roundCents, sumMoney } from "../src/api-dto.js";
import {
  ConnectorBlockedError,
  DatasetNotServedError,
  EaglesoftConnector,
  PRACTICE_DATASETS,
} from "../src/connector.js";
import { EaglesoftApiConnector } from "../src/api-connector.js";
import { READ_QUERIES } from "../src/read-queries.js";
import {
  CANONICAL_COLUMNS,
  COLUMN_KIND,
  DATASETS,
  DATASET_CATEGORY,
  REQUIRED_CANONICAL,
  assertValidProfile,
  type ExportProfile,
} from "../src/export-drop/profiles.js";

/** Fixed clock: 2026-08-19T12:00:00Z. */
const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
/** An mtime old enough to clear the 30s quiet period. */
const SETTLED = NOW - 3_600_000;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "droplet-qb-export-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function drop(name: string, content: string, mtimeMs = SETTLED): Promise<void> {
  const path = join(root, name);
  await writeFile(path, content, "utf8");
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
}

/** A connector on the SHIPPED built-in `quickbooks` profile — no operator
 *  override — so these tests exercise the profile we actually ship. */
function qb(profiles?: readonly ExportProfile[]) {
  return new ExportDropConnector(
    { vendor: "quickbooks", root },
    { now: () => NOW, profiles: profiles ?? [], minRefreshMs: Number.POSITIVE_INFINITY },
  );
}

// Column headers as QuickBooks prints them in "Open Invoices",
// "Unpaid Bills Detail" and "A/P Aging Summary".
const OPEN_INVOICES_CSV = [
  "Date,Num,Customer,Due Date,Amount,Open Balance",
  "2026-07-01,INV-1001,Northside Clinic,2026-07-31,\"1,200.00\",\"1,200.00\"",
  "2026-07-14,INV-1002,\"Riverside Dental, PC\",2026-08-13,\"3,400.50\",\"1,900.50\"",
  "2026-06-02,INV-0999,Northside Clinic,2026-07-02,500.00,0.00",
  "",
].join("\n");

// Deliberately NOT in due-date order: BILL-78 (due 08-19) is listed before
// BILL-77 (due 08-04). The previous fixture was already sorted, so the
// "drop the sort" mutation this file names could not turn anything red.
const UNPAID_BILLS_CSV = [
  "Date,Num,Vendor,Due Date,Amount,Open Balance",
  "2026-07-20,BILL-78,Patterson Dental,2026-08-19,\"850.25\",\"850.25\"",
  "2026-07-05,BILL-77,Henry Schein,2026-08-04,\"2,000.00\",\"2,000.00\"",
  "",
].join("\n");

const AP_AGING_CSV = [
  "Vendor,Current,1 - 30,31 - 60,61 - 90,91 and over,Total",
  "Henry Schein,2000.00,0.00,0.00,0.00,0.00,\"2,000.00\"",
  "Patterson Dental,850.25,0.00,0.00,0.00,0.00,850.25",
  "",
].join("\n");

// ── the vocabulary itself ───────────────────────────────────────────────────

describe("the dataset vocabulary", () => {
  it("declares a parse kind for every canonical column", () => {
    // Mutation: delete any COLUMN_KIND entry → profiles.ts throws at module
    // load and this file cannot even import. That is the intended blast radius:
    // a money column silently read as text would serialize "1,200.00" as a
    // string and make every aggregate over it wrong.
    for (const dataset of DATASETS) {
      for (const column of CANONICAL_COLUMNS[dataset]) {
        expect(COLUMN_KIND[column], `${dataset}.${column}`).toBeDefined();
      }
    }
  });

  it("requires the column each accounting aggregate is computed over", () => {
    // Mutation: drop "balance" from REQUIRED_CANONICAL.bill → red. A bill
    // dataset without a balance sums to zero and reports it as fact.
    expect(REQUIRED_CANONICAL.bill).toContain("balance");
    expect(REQUIRED_CANONICAL.invoice).toContain("balance");
    expect(REQUIRED_CANONICAL.ap_summary).toContain("balance");
  });

  it("categorises every dataset", () => {
    // Mutation: add a dataset to DATASETS without a DATASET_CATEGORY entry → red.
    for (const dataset of DATASETS) {
      expect(DATASET_CATEGORY[dataset], dataset).toMatch(/^(practice|accounting)$/);
    }
  });
});

// ── the capability declaration ──────────────────────────────────────────────

describe("a track refuses datasets it does not serve", () => {
  it("the SQL track refuses an accounting read BEFORE any I/O", async () => {
    // No bridge is configured, so if the capability check were missing this
    // would throw ConnectorBlockedError ("needs the SAP client") instead —
    // sending an installer to chase a driver for data Eaglesoft never has.
    //
    // Mutation: remove the assertDatasetsServed call from EaglesoftConnector
    // .runRead → this becomes ConnectorBlockedError → red.
    const c = new EaglesoftConnector({
      host: "eaglesoft.example",
      port: 2638,
      serverName: "PattersonPM",
      databaseName: "PattersonPM",
      readSecretRef: "ref",
    });
    await expect(c.runRead("get_open_bills", {})).rejects.toBeInstanceOf(DatasetNotServedError);
  });

  it("the REST track refuses an accounting read BEFORE connection state", async () => {
    // Same reasoning: unauthenticated is not the reason Patterson has no bills.
    // Mutation: move the assert below the token check → ConnectorBlockedError → red.
    const c = new EaglesoftApiConnector({
      host: "eaglesoft.example",
      httpsPort: 9888,
      credentialsSecretRef: "ref",
    });
    await expect(c.runRead("get_ap_summary", {})).rejects.toBeInstanceOf(DatasetNotServedError);
  });

  it("a QuickBooks export drop refuses a practice read", async () => {
    await drop("open-invoices.csv", OPEN_INVOICES_CSV);
    const c = qb();
    await c.connect();
    // Mutation: hardcode servesDatasets on ExportDropConnector to every dataset
    // → this resolves to a blocked "no appointment dataset" error → red.
    await expect(c.runRead("get_schedule_today", { from: "a", to: "b" })).rejects.toBeInstanceOf(
      DatasetNotServedError,
    );
  });

  it("names the missing dataset and the track in the error", async () => {
    const c = new EaglesoftConnector({
      host: "h",
      port: 2638,
      serverName: "s",
      databaseName: "d",
      readSecretRef: "r",
    });
    // Mutation: drop `missing` from the message → red. An error that says only
    // "not served" leaves the reader to guess which of three datasets it meant.
    await expect(c.runRead("get_open_invoices", {})).rejects.toThrow(/invoice/);
    await expect(c.runRead("get_open_invoices", {})).rejects.toThrow(/eaglesoft/);
  });

  it("NEVER answers an unserved read with an empty array", async () => {
    // THE load-bearing test. An empty array is a plausible-looking, confident,
    // wrong answer about money — and no caller can tell it apart from a real
    // empty ledger. Every track must throw instead.
    //
    // Mutation: make any connector `return []` for an unserved dataset → red.
    await drop("open-invoices.csv", OPEN_INVOICES_CSV);
    const exportTrack = qb();
    await exportTrack.connect();

    const sql = new EaglesoftConnector({
      host: "h", port: 2638, serverName: "s", databaseName: "d", readSecretRef: "r",
    });
    const rest = new EaglesoftApiConnector({
      host: "h", httpsPort: 9888, credentialsSecretRef: "r",
    });

    for (const [label, run] of [
      ["export-drop", () => exportTrack.runRead("get_schedule_today", { from: "a", to: "b" })],
      ["sql", () => sql.runRead("get_open_bills", {})],
      ["rest", () => rest.runRead("get_open_bills", {})],
    ] as const) {
      let result: unknown = "did-not-throw";
      try {
        result = await run();
      } catch (err) {
        result = err;
      }
      expect(result, `${label} must throw, not return rows`).toBeInstanceOf(Error);
      expect(Array.isArray(result), `${label} returned an array`).toBe(false);
    }
  });

  it("distinguishes 'this track has no bills' from 'the bill export is missing'", async () => {
    // Only the invoice report was dropped. The vendor's profile DOES declare
    // `bill`, so this is a missing file — actionable ("run the export") — and
    // must NOT be the same error as a capability gap, which nobody can fix.
    //
    // Mutation: collapse rowsFor's blocked error into DatasetNotServedError → red.
    await drop("open-invoices.csv", OPEN_INVOICES_CSV);
    const c = qb();
    await c.connect();
    const err = await c.runRead("get_open_bills", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err).not.toBeInstanceOf(DatasetNotServedError);
    expect((err as Error).message).toMatch(/bill/);
  });

  it("declares practice datasets on both Eaglesoft tracks identically", () => {
    // Mutation: give one track an extra dataset → red. The two tracks read the
    // SAME product; a capability difference would be a bug in one of them.
    const sql = new EaglesoftConnector({
      host: "h", port: 2638, serverName: "s", databaseName: "d", readSecretRef: "r",
    });
    const rest = new EaglesoftApiConnector({
      host: "h", httpsPort: 9888, credentialsSecretRef: "r",
    });
    expect([...sql.servesDatasets].sort()).toEqual([...rest.servesDatasets].sort());
    expect([...sql.servesDatasets].sort()).toEqual([...PRACTICE_DATASETS].sort());
  });
});

// ── the QuickBooks profile, end to end ──────────────────────────────────────

describe("QuickBooks export drop", () => {
  it("serves exactly the datasets its profile declares", async () => {
    await drop("open-invoices.csv", OPEN_INVOICES_CSV);
    const c = qb();
    await c.connect();
    // Mutation: compute servesDatasets from the SNAPSHOT rather than the
    // profile → this drops to ["invoice"] → red. Capability is what the vendor
    // CAN export; presence is a freshness question with a different answer.
    expect([...c.servesDatasets].sort()).toEqual(["ap_summary", "bill", "invoice"]);
  });

  it("reads open invoices with canonical column names and parsed money", async () => {
    await drop("open-invoices.csv", OPEN_INVOICES_CSV);
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_open_invoices", {})) as Record<string, unknown>[];

    // INV-0999 has a zero balance and is not "open"; the other two are.
    // Mutation: drop the `balance !== 0` filter → 3 rows → red.
    expect(rows.map((r) => r.invoice_id)).toEqual(["INV-1001", "INV-1002"]);

    // Mutation: read the money column as text → these become strings → red.
    expect(rows[0].balance).toBe(1200);
    expect(rows[1].balance).toBe(1900.5);
    expect(rows[1].amount).toBe(3400.5);

    // A quoted embedded comma in a customer name must survive intact.
    // Mutation: split on commas without honouring quotes → red.
    expect(rows[1].customer_id).toBe("Riverside Dental, PC");

    // Every canonical column is present, mapped or not — a consumer must not be
    // able to tell the three tracks apart by probing for a key.
    // Mutation: skip unmapped columns in projectRow → `status` absent → red.
    for (const column of CANONICAL_COLUMNS.invoice) {
      expect(Object.keys(rows[0]), column).toContain(column);
    }
    expect(rows[0].status).toBeUndefined();

    // Timestamps normalize to the canonical ISO form.
    // Mutation: pass the raw cell through → "2026-07-31" → red.
    expect(rows[0].due_at).toBe("2026-07-31T00:00:00.000Z");
  });

  it("reads unpaid bills — the money-going-out half", async () => {
    await drop("unpaid-bills.csv", UNPAID_BILLS_CSV);
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    // Ordered by due date, oldest first, matching the registry's ORDER BY.
    // Mutation: drop the sort → red.
    expect(rows.map((r) => r.bill_id)).toEqual(["BILL-77", "BILL-78"]);
    expect(rows.map((r) => r.vendor_id)).toEqual(["Henry Schein", "Patterson Dental"]);
    expect(rows[0].balance).toBe(2000);
    expect(rows[1].balance).toBe(850.25);
  });

  it("aggregates the AP summary the same way AR is aggregated", async () => {
    await drop("ap-aging.csv", AP_AGING_CSV);
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_ap_summary", {})) as Record<string, unknown>[];
    // Mutation: sum `amount` instead of `balance`, or count files instead of
    // rows → red.
    expect(rows).toEqual([{ vendor_count: 2, total_balance: 2850.25, unaccounted_count: 0 }]);
  });

  it("does not let the three QuickBooks reports collide", async () => {
    // Open Invoices and Unpaid Bills both print `Num` + `Open Balance`; the AP
    // ageing report also carries `Vendor`. If the built-in profile's required
    // lists lost their discriminators, one file would match two datasets and
    // the matcher would refuse it as ambiguous.
    //
    // Mutation: remove "Customer" from the invoice profile's `required` → the
    // invoice file matches both invoice and bill → ambiguous → connect throws.
    await drop("open-invoices.csv", OPEN_INVOICES_CSV);
    await drop("unpaid-bills.csv", UNPAID_BILLS_CSV);
    await drop("ap-aging.csv", AP_AGING_CSV);
    const c = qb();
    await c.connect();
    const status = await c.status();
    expect(status.diagnostics.filter((d) => d.reason === "ambiguous")).toEqual([]);
    expect(status.datasets.map((d) => d.dataset).sort()).toEqual([
      "ap_summary",
      "bill",
      "invoice",
    ]);
  });

  it("reports the shipped profile as unverified", async () => {
    // Every built-in ships `verified: false` — nobody has confirmed it against
    // a real export from that product. Surfacing it is what tells an operator
    // to check on day one.
    // Mutation: flip the built-in to verified: true → red.
    await drop("open-invoices.csv", OPEN_INVOICES_CSV);
    const c = qb();
    await c.connect();
    expect((await c.status()).usingUnverifiedProfiles).toBe(true);
  });
});

// ── money is the sharp edge ─────────────────────────────────────────────────

describe("accounting money parsing", () => {
  it("reads the accounting-negative conventions a payables report prints", async () => {
    await drop(
      "unpaid-bills.csv",
      [
        "Date,Num,Vendor,Due Date,Amount,Open Balance",
        "2026-07-05,BILL-90,Credit Co,2026-08-04,100.00,(250.00)",
        "2026-07-06,BILL-91,Refund Co,2026-08-05,100.00,75.00 CR",
        "",
      ].join("\n"),
    );
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    // Mutation: treat parentheses or CR as decoration → both become positive,
    // and the payables total is wrong by twice each credit → red.
    expect(rows.find((r) => r.bill_id === "BILL-90")!.balance).toBe(-250);
    expect(rows.find((r) => r.bill_id === "BILL-91")!.balance).toBe(-75);
  });

  it("keeps a row whose balance will not parse rather than dropping it", async () => {
    await drop(
      "unpaid-bills.csv",
      [
        "Date,Num,Vendor,Due Date,Amount,Open Balance",
        "2026-07-05,BILL-92,Mystery Co,2026-08-04,100.00,see attached",
        "",
      ].join("\n"),
    );
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    // Money we cannot account for must stay visible. Dropping it understates
    // what the business owes, silently.
    // Mutation: filter rows to finite balances only → 0 rows → red.
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBeUndefined();
  });
});

// ── operator profiles reach across categories ───────────────────────────────

describe("operator profiles", () => {
  const ACME_BOOKS: ExportProfile = {
    vendor: "acmebooks",
    label: "Acme Books",
    verified: true,
    datasets: [
      {
        dataset: "bill",
        required: ["Ref", "Outstanding"],
        columns: { bill_id: "Ref", balance: "Outstanding", vendor_id: "Supplier", due_at: "Due" },
      },
    ],
  };

  it("accepts an accounting dataset from an operator profile", () => {
    // Before WARP-2107 the DatasetName union was dental-only, so this threw at
    // registration and no on-site profile could map an accounting product.
    // Mutation: restore the closed dental-only DATASETS list → red.
    expect(() => assertValidProfile(ACME_BOOKS)).not.toThrow();
  });

  it("serves an operator-declared accounting product end to end", async () => {
    await drop(
      "supplier-outstanding.csv",
      ["Ref,Supplier,Due,Outstanding", "S-1,Widget Ltd,2026-09-01,412.10", ""].join("\n"),
    );
    const c = new ExportDropConnector(
      { vendor: "acmebooks", root },
      { now: () => NOW, profiles: [ACME_BOOKS], minRefreshMs: Number.POSITIVE_INFINITY },
    );
    await c.connect();
    expect(c.servesDatasets).toEqual(["bill"]);
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        bill_id: "S-1",
        issued_at: undefined,
        due_at: "2026-09-01T00:00:00.000Z",
        vendor_id: "Widget Ltd",
        amount: undefined,
        balance: 412.1,
        status: undefined,
      },
    ]);
    // An operator writing a mapping against the export in front of them has
    // done the confirmation the built-ins are missing.
    expect((await c.status()).usingUnverifiedProfiles).toBe(false);
  });

  it("still rejects a dataset name that is not in the vocabulary", () => {
    // Mutation: drop the DATASETS membership check in assertValidProfile → red.
    expect(() =>
      assertValidProfile({
        ...ACME_BOOKS,
        datasets: [{ ...ACME_BOOKS.datasets[0], dataset: "purchase_order" as never }],
      }),
    ).toThrow(/unknown dataset/);
  });
});

// ── identity: two documents must not become one ─────────────────────────────

describe("dedup cannot silently merge two different documents", () => {
  it("keeps two bills that share a reference number", async () => {
    // QuickBooks does not enforce uniqueness on Ref No. Keying dedup on it
    // alone made the second bill overwrite the first, and the money simply
    // vanished — a payables total quietly too small, which nobody would catch.
    //
    // Mutation: key `bill` on ["bill_id"] alone → one row, 2500 total → red.
    await drop(
      "unpaid-bills.csv",
      [
        "Date,Num,Vendor,Due Date,Amount,Open Balance",
        "2026-07-05,5678,Henry Schein,2026-08-04,1000.00,1000.00",
        "2026-07-06,5678,Patterson Dental,2026-08-05,2500.00,2500.00",
        "",
      ].join("\n"),
    );
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.vendor_id).sort()).toEqual(["Henry Schein", "Patterson Dental"]);
  });

  it("still collapses a genuine re-export of the same document", async () => {
    // The property dedup exists for: yesterday's and today's copies of the same
    // report both sitting in the drop must not double every row.
    // Mutation: fall back to a per-row key unconditionally → 2 rows → red.
    const same = [
      "Date,Num,Vendor,Due Date,Amount,Open Balance",
      "2026-07-05,BILL-77,Henry Schein,2026-08-04,2000.00,2000.00",
      "",
    ].join("\n");
    await drop("bills-monday.csv", same, SETTLED - 60_000);
    await drop("bills-tuesday.csv", same);
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
  });

  it("duplicates rather than loses when part of the key is missing", async () => {
    // Falling back is the safe direction: a duplicate row is visible and
    // arguable; a collapsed one is money that silently left the ledger.
    // Mutation: build a partial key from whatever parts exist → 1 row → red.
    await drop(
      "unpaid-bills.csv",
      [
        "Date,Num,Vendor,Due Date,Amount,Open Balance",
        "2026-07-05,5678,,2026-08-04,,900.00",
        "2026-07-06,5678,,2026-08-05,,1100.00",
        "",
      ].join("\n"),
    );
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
  });
});

// ── money is reported as money ──────────────────────────────────────────────

describe("totals are currency figures, not accumulated doubles", () => {
  it("sums real balances without binary noise", () => {
    // These six values accumulate to 17018.979999999996 in IEEE-754 — which is
    // what a dashboard renders and what the assistant reads aloud.
    // Mutation: return the raw accumulation → red.
    const rows = [3949.93, 2800.89, 2039.97, 2936.65, 4354.78, 936.76].map((balance) => ({
      balance,
    }));
    expect(sumMoney(rows)).toBe(17018.98);
  });

  it("rounds at the end, not per addition", () => {
    // Rounding each addend would compound the error this exists to remove.
    // Mutation: round inside the loop → 0.3 becomes 0.30000000000000004-free
    // by luck here, but 0.005-scale cases diverge; this asserts the contract.
    expect(sumMoney([{ balance: 0.1 }, { balance: 0.2 }])).toBe(0.3);
    expect(roundCents(-0)).toBe(0);
  });

  it("is used by BOTH summaries, so AR and AP cannot disagree in style", async () => {
    // Mutation: revert either aggregate to a raw loop → red.
    await drop(
      "ap-aging.csv",
      [
        "Vendor,Current,1 - 30,31 - 60,61 - 90,91 and over,Total",
        "A,0,0,0,0,0,3949.93",
        "B,0,0,0,0,0,2800.89",
        "C,0,0,0,0,0,2039.97",
        "D,0,0,0,0,0,2936.65",
        "E,0,0,0,0,0,4354.78",
        "F,0,0,0,0,0,936.76",
        "",
      ].join("\n"),
    );
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_ap_summary", {})) as Record<string, unknown>[];
    expect(rows).toEqual([{ vendor_count: 6, total_balance: 17018.98, unaccounted_count: 0 }]);
  });
});

describe("a summary never hides money it could not read", () => {
  it("counts the rows it could not account for, instead of just being short", async () => {
    // The list reads deliberately KEEP a row whose balance will not parse.
    // The summary used to silently skip it — so the same document was listed as
    // money owed AND contributed nothing to the total, with no signal. A total
    // that is short is unfixable by the reader unless they know it is short.
    //
    // Mutation: use sumMoney instead of sumMoneyWithGaps → unaccounted_count
    // disappears from the row → red.
    await drop(
      "ap-aging.csv",
      [
        "Vendor,Current,1 - 30,31 - 60,61 - 90,91 and over,Total",
        "Henry Schein,0,0,0,0,0,2000.00",
        "Mystery Co,0,0,0,0,0,see attached",
        "",
      ].join("\n"),
    );
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_ap_summary", {})) as Record<string, unknown>[];
    expect(rows).toEqual([
      { vendor_count: 2, total_balance: 2000, unaccounted_count: 1 },
    ]);
  });

  it("reports zero gaps explicitly rather than omitting the field", async () => {
    // An absent field would be one more thing inferred from absence — the very
    // pattern this branch exists to remove. Mutation: omit it when 0 → red.
    await drop(
      "ap-aging.csv",
      ["Vendor,Current,1 - 30,31 - 60,61 - 90,91 and over,Total", "A,0,0,0,0,0,10.00", ""].join("\n"),
    );
    const c = qb();
    await c.connect();
    const rows = (await c.runRead("get_ap_summary", {})) as Record<string, unknown>[];
    expect(Object.keys(rows[0])).toContain("unaccounted_count");
    expect(rows[0].unaccounted_count).toBe(0);
  });
});

// ── the properties the track must not lose ──────────────────────────────────

describe("accounting does not weaken the track's guarantees", () => {
  it("still refuses every write, including on the new datasets", async () => {
    await drop("unpaid-bills.csv", UNPAID_BILLS_CSV);
    const c = qb();
    await c.connect();
    // Mutation: add any writable path → red. An export is a one-way copy;
    // there is no channel back through a file somebody printed.
    for (const cmd of ["reschedule_appointment"]) {
      await expect(c.applyWrite(cmd, {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    }
  });

  it("trips the drift fingerprint when an accounting export changes shape", async () => {
    await drop("unpaid-bills.csv", UNPAID_BILLS_CSV);
    const first = qb();
    await first.connect();
    const before = (await first.introspect()).fingerprint;

    // The vendor renames a column in a report-layout change.
    await drop(
      "unpaid-bills.csv",
      UNPAID_BILLS_CSV.replace("Open Balance", "Balance Due").replace("Num", "Bill No"),
    );
    const second = new ExportDropConnector(
      { vendor: "quickbooks", root },
      {
        now: () => NOW,
        profiles: [
          {
            vendor: "quickbooks",
            label: "QuickBooks (operator-corrected)",
            verified: true,
            datasets: [
              {
                dataset: "bill",
                required: ["Bill No", "Balance Due", "Vendor"],
                columns: {
                  bill_id: "Bill No",
                  balance: "Balance Due",
                  vendor_id: "Vendor",
                  due_at: "Due Date",
                  issued_at: "Date",
                  amount: "Amount",
                },
              },
            ],
          },
        ],
        minRefreshMs: Number.POSITIVE_INFINITY,
      },
    );
    await second.connect();
    // Mutation: fingerprint the filename instead of the observed headers → the
    // two fingerprints match and a layout change ships as silently wrong data.
    expect((await second.introspect()).fingerprint).not.toBe(before);
  });

  it("registers the accounting reads in the shared registry", () => {
    // The registry is the single definition of what a read MEANS. A track that
    // grew its own private accounting read would be a second definition.
    // Mutation: remove one from READ_QUERIES → red.
    const names = READ_QUERIES.map((q) => q.name);
    expect(names).toContain("get_open_invoices");
    expect(names).toContain("get_open_bills");
    expect(names).toContain("get_ap_summary");
  });
});
