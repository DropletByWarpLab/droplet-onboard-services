/**
 * WARP-2280 — the widened dataset vocabulary, and the proof that widening it
 * disturbed nothing that was already there.
 *
 * The union went from six names to twenty across five business domains. The
 * dangerous failure of a change like this is not a compile error — `tsc`
 * catches those, and the compile-time half of this story is asserted in
 * `src/export-drop/vocabulary-contract.ts`, because **`vitest` does not
 * typecheck** and this package's `tsconfig.json` excludes `__tests__` outright.
 * The dangerous failure is quiet: a reordered column array, a renamed column,
 * a built-in profile that now claims one more file than it used to. Every one
 * of those changes what an owner sees and none of them shows up in review.
 *
 * So the six original datasets are pinned here as literal data copied from
 * `74492c21` — the commit WARP-2280 was written against — rather than derived
 * from the module under test, which would make the assertion circular.
 *
 * Every test names the mutation that must turn it red. A test whose mutation
 * is not stated is a test nobody has proved can fail.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILT_IN_PROFILES,
  CANONICAL_COLUMNS,
  COLUMN_KIND,
  DATASETS,
  DATASET_CATEGORY,
  ProfileError,
  REQUIRED_CANONICAL,
  SINGLE_CURRENCY_LEDGER_DATASETS,
  isDatasetName,
  matchDataset,
  parseProfileJson,
  profilesForVendor,
  type DatasetName,
} from "../src/export-drop/profiles.js";
import { READ_QUERIES } from "../src/read-queries.js";
import { ExportDropConnector } from "../src/export-drop/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { DEFAULT_SCAN_LIMITS, scanDropDirectory } from "../src/export-drop/scan.js";

// ── the pinned original six, verbatim from 74492c21 ─────────────────────────

/**
 * The six names, their categories and their canonical column arrays exactly as
 * they stood before the widening.
 *
 * Copied by hand out of `git show 74492c21:services/erp-connector/src/
 * export-drop/profiles.ts`. Deliberately NOT generated from the module: a
 * fixture derived from the thing it guards agrees with every mutation of it.
 */
const PINNED_AT_74492C21: Readonly<
  Record<string, { category: string; columns: readonly string[] }>
> = {
  appointment: {
    category: "practice",
    columns: ["appt_id", "appt_time", "provider_id", "operatory_id", "status", "patient_id"],
  },
  patient: { category: "practice", columns: ["patient_id", "first_name", "last_name"] },
  account: { category: "accounting", columns: ["account_id", "balance"] },
  invoice: {
    category: "accounting",
    columns: ["invoice_id", "issued_at", "due_at", "customer_id", "amount", "balance", "status"],
  },
  bill: {
    category: "accounting",
    columns: ["bill_id", "issued_at", "due_at", "vendor_id", "amount", "balance", "status"],
  },
  ap_summary: { category: "accounting", columns: ["vendor_id", "balance"] },
};

/** The names WARP-2280 added, in the order the vendors own them. */
const ADDED_BY_WARP_2280: readonly DatasetName[] = [
  "charge",
  "refund",
  "payout",
  "balance_transaction",
  "subscription",
  "contact",
  "company",
  "deal",
  "ticket",
  "order",
  "product",
  "customer",
  "campaign",
  "audience",
];

/** WARP-2466 — the three shapes the connector reconciliation found had no
 *  interchangeable equivalent in WARP-2280's twenty. */
const ADDED_BY_WARP_2466: readonly DatasetName[] = [
  "engagement",
  "audience_member",
  "ecommerce_order",
];

describe("the widening is additive — the original six are untouched", () => {
  it("keeps every original name, its category and its columns byte-identical", () => {
    // Mutation: reorder CANONICAL_COLUMNS.invoice, rename one of its columns,
    // or refile `account` under "practice" → red. This is the whole point of
    // the fixture: none of those three is visible in a diff review of a file
    // that grew by fourteen entries.
    for (const [dataset, pinned] of Object.entries(PINNED_AT_74492C21)) {
      expect(isDatasetName(dataset), `${dataset} left the vocabulary`).toBe(true);
      const name = dataset as DatasetName;
      expect(DATASET_CATEGORY[name], `${dataset} category`).toBe(pinned.category);
      // toEqual on an array is order-sensitive, which is the assertion: the
      // canonical column list IS the row's column order on every track.
      expect(CANONICAL_COLUMNS[name], `${dataset} columns`).toEqual(pinned.columns);
    }
  });

  it("keeps the original six FIRST and in their original order", () => {
    // Mutation: sort DATASETS alphabetically, or insert a SaaS name among the
    // dental ones → red. Order is not decorative here: `DatasetName` is
    // `(typeof DATASETS)[number]`, and the array is what a reader scans to
    // learn which domain a name belongs to.
    expect(DATASETS.slice(0, 6)).toEqual([
      "appointment",
      "patient",
      "account",
      "invoice",
      "bill",
      "ap_summary",
    ]);
  });

  it("adds exactly fourteen names, then WARP-2466's three, and nothing else", () => {
    // Mutation: add a dataset without deciding its category and columns → red
    // here before it is red anywhere subtler.
    //
    // WARP-2466's reconciliation took the union to twenty-three. Its three are
    // the HubSpot/Mailchimp shapes that turned out NOT to be interchangeable
    // with an existing name — `engagement` sits with the CRM names it belongs
    // to and the two marketing ones sit at the end. Per-name evidence: the
    // table in `profiles.ts`'s docstring.
    expect(DATASETS).toHaveLength(23);
    const added = DATASETS.slice(6);
    expect(added.filter((d) => !ADDED_BY_WARP_2466.includes(d))).toEqual(ADDED_BY_WARP_2280);
    expect(added.filter((d) => ADDED_BY_WARP_2466.includes(d))).toEqual(ADDED_BY_WARP_2466);
  });
});

// ── the vocabulary's own rules ──────────────────────────────────────────────

describe("the widened vocabulary is internally consistent", () => {
  it("categorises every dataset into the widened union", () => {
    // Mutation: revert DatasetCategory to "practice" | "accounting" → tsc goes
    // red first, but if the union were loosened to `string` this catches the
    // typo that follows.
    const allowed = ["practice", "accounting", "payments", "commerce", "crm", "marketing"];
    for (const dataset of DATASETS) {
      expect(allowed, dataset).toContain(DATASET_CATEGORY[dataset]);
    }
    // All six category values are actually USED. A category nothing is filed
    // under is a value union that grew for no reason.
    expect([...new Set(DATASETS.map((d) => DATASET_CATEGORY[d]))].sort()).toEqual(
      [...allowed].sort(),
    );
  });

  it("declares a parse kind for every canonical column of every dataset", () => {
    // Mutation: delete any COLUMN_KIND entry → profiles.ts throws at module
    // load and this file cannot import. A money column read as text serializes
    // "1,234.56" as a string and makes every aggregate over it wrong.
    for (const dataset of DATASETS) {
      for (const column of CANONICAL_COLUMNS[dataset]) {
        expect(COLUMN_KIND[column], `${dataset}.${column}`).toBeDefined();
      }
    }
  });

  it("gives every money-carrying SaaS dataset an explicit currency column", () => {
    // Mutation: drop "currency" from CANONICAL_COLUMNS.charge →
    // assertMoneyColumnsCarryCurrency throws at module load. Asserted here too
    // so the rule is legible where a reader looks for it, and so the EXEMPTION
    // list cannot quietly grow: an amount whose currency must be guessed is not
    // a number.
    for (const dataset of DATASETS) {
      const columns = CANONICAL_COLUMNS[dataset];
      const hasMoney = columns.some((c) => COLUMN_KIND[c] === "money");
      if (!hasMoney) continue;
      if (SINGLE_CURRENCY_LEDGER_DATASETS.includes(dataset)) continue;
      expect(columns, `${dataset} carries money without a currency`).toContain("currency");
    }
    // The exemption is exactly the four pre-existing ledger datasets. Mutation:
    // add a SaaS dataset to the exemption list to dodge the rule above → red.
    expect([...SINGLE_CURRENCY_LEDGER_DATASETS].sort()).toEqual([
      "account",
      "ap_summary",
      "bill",
      "invoice",
    ]);
  });

  it("never asks a count column to carry a currency", () => {
    // Mutation: declare member_count as "money" → it lands in the currency
    // rule above and `audience` is forced to grow a currency column for a
    // number of people → red.
    expect(COLUMN_KIND.member_count).toBe("count");
    expect(COLUMN_KIND.emails_sent).toBe("count");
    expect(COLUMN_KIND.inventory_quantity).toBe("count");
    expect(CANONICAL_COLUMNS.audience).not.toContain("currency");
  });

  it("requires the column each new dataset exists to answer about", () => {
    // Mutation: drop "amount" from REQUIRED_CANONICAL.charge → a charge
    // dataset with no amount aggregates to zero and reports it as fact, the
    // payments twin of a bill with no balance.
    expect(REQUIRED_CANONICAL.charge).toContain("amount");
    expect(REQUIRED_CANONICAL.charge).toContain("currency");
    expect(REQUIRED_CANONICAL.audience).toContain("member_count");
    expect(REQUIRED_CANONICAL.campaign).toContain("emails_sent");
    // Every required column must be a canonical column of that dataset —
    // a required name that is not in the list can never be satisfied.
    for (const dataset of DATASETS) {
      for (const required of REQUIRED_CANONICAL[dataset]) {
        expect(CANONICAL_COLUMNS[dataset], `${dataset}.${required}`).toContain(required);
      }
    }
  });

  it("gives every dataset at least one read query that can reach it", () => {
    // Mutation: add a dataset to DATASETS without a READ_QUERIES entry → red.
    // A declared dataset no query depends on is a capability a connector can
    // advertise and nothing can ever ask for.
    const reachable = new Set(READ_QUERIES.flatMap((q) => q.dependsOnTables));
    for (const dataset of DATASETS) {
      expect([...reachable], `no read query depends on ${dataset}`).toContain(dataset);
    }
  });

  it("lets no read query depend on a name outside the vocabulary", () => {
    // Mutation: type dependsOnTables as string[] and typo one entry → red.
    // A query naming a dataset nothing serves would be offered and then answer
    // with an empty result rather than a refusal.
    for (const query of READ_QUERIES) {
      for (const dataset of query.dependsOnTables) {
        expect(isDatasetName(dataset), `${query.name} → ${dataset}`).toBe(true);
      }
    }
  });
});

// ── the export-drop profile corpus is undisturbed ───────────────────────────

/**
 * Every built-in vendor profile as it stands, pinned. The widening added no
 * dataset to any built-in — the fourteen new names are cloud-track vocabulary
 * and no practice exports a Stripe payout as a CSV.
 */
const PINNED_BUILT_INS: Readonly<Record<string, readonly string[]>> = {
  eaglesoft: ["appointment", "patient", "account"],
  quickbooks: ["invoice", "bill", "ap_summary"],
  opendental: ["appointment", "patient", "account"],
};

describe("the built-in export profiles claim exactly what they claimed before", () => {
  it("declares the same vendors and the same datasets per vendor", () => {
    // Mutation: add a `customer` dataset to the quickbooks built-in → red.
    // A built-in that grew a dataset would start claiming files it never
    // claimed, which is the silent failure this pin exists for.
    const actual = Object.fromEntries(
      BUILT_IN_PROFILES.map((p) => [p.vendor, p.datasets.map((d) => d.dataset)]),
    );
    expect(actual).toEqual(PINNED_BUILT_INS);
  });

  it("claims a file for each built-in dataset from its required headers alone", () => {
    // Mutation: drop one `required` header from any built-in → that dataset's
    // signature stops being distinctive, and either this match fails or the
    // ambiguity assertion below does. Both are red, which is the point.
    for (const profile of BUILT_IN_PROFILES) {
      for (const ds of profile.datasets) {
        const result = matchDataset(ds.required, profilesForVendor(profile.vendor));
        expect(result.kind, `${profile.vendor}.${ds.dataset}`).toBe("matched");
        if (result.kind !== "matched") continue;
        expect(result.candidate.dataset.dataset).toBe(ds.dataset);
        expect(result.candidate.profile.vendor).toBe(profile.vendor);
      }
    }
  });

  it("still refuses an ambiguous header row instead of picking one", () => {
    // The QuickBooks reports overlap: Open Invoices and Unpaid Bills Detail
    // both print Num + Open Balance and differ only by Customer vs Vendor. A
    // file carrying BOTH discriminators matches two profiles.
    //
    // Mutation: make matchDataset return hits[0] on multiple hits → this
    // becomes "matched" → red. Picking the first is a coin flip that decides
    // whether a row is money owed TO or BY the business.
    const result = matchDataset(
      ["Num", "Open Balance", "Customer", "Vendor"],
      profilesForVendor("quickbooks"),
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.datasets).toEqual(["quickbooks.bill", "quickbooks.invoice"]);
  });

  it("still reports an unrecognized file rather than guessing at it", () => {
    // Mutation: fall back to a best-effort partial match → red. An operator
    // authoring a profile on site needs "unrecognized", not a wrong claim.
    const result = matchDataset(
      ["Charge ID", "Amount", "Currency"],
      profilesForVendor("quickbooks"),
    );
    expect(result.kind).toBe("unrecognized");
  });

  it("reports the headers an unrecognized file actually had", async () => {
    // The unrecognized path is what lets an operator author the right profile
    // on site without shipping us the file. Mutation: drop the observed
    // headers from the failure detail → red, and an operator is left with
    // "nothing matched" and no way to find out why.
    const root = await mkdtemp(join(tmpdir(), "droplet-vocab-"));
    try {
      const path = join(root, "mystery.csv");
      await writeFile(path, "Widget Code,Quantity On Hand\nW-1,4\n", "utf8");
      const settled = new Date(Date.UTC(2026, 7, 19, 11, 0, 0));
      await utimes(path, settled, settled);

      const c = new ExportDropConnector(
        { vendor: "quickbooks", root },
        {
          now: () => Date.UTC(2026, 7, 19, 12, 0, 0),
          profiles: [],
          minRefreshMs: Number.POSITIVE_INFINITY,
        },
      );
      const err = await c.connect().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorBlockedError);
      const message = (err as Error).message;
      expect(message).toContain("mystery.csv");
      expect(message).toContain("Widget Code");
      expect(message).toContain("Quantity On Hand");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── the union is load-bearing where a name arrives as a string ──────────────

describe("an unrecognized dataset name is refused, never admitted", () => {
  it("refuses an operator profile naming a dataset outside the vocabulary", () => {
    // WARP-2306: `parseProfileJson` used to CAST `dr.dataset as DatasetName`,
    // so an unknown name became a typed key that was not there and only failed
    // later. Mutation: restore the cast → the name flows through to
    // assertValidProfile, and the message no longer names the known list → the
    // second assertion goes red.
    const json = JSON.stringify({
      vendor: "acmebooks",
      label: "Acme Books",
      datasets: [
        { dataset: "purchase_order", required: ["Ref"], columns: { bill_id: "Ref" } },
      ],
    });
    expect(() => parseProfileJson(json)).toThrow(ProfileError);
    expect(() => parseProfileJson(json)).toThrow(/unknown dataset "purchase_order"/);
  });

  it("refuses a non-string dataset name without letting it reach a Record lookup", () => {
    // Mutation: drop the isDatasetName guard → `dr.dataset` is 42, and
    // CANONICAL_COLUMNS[42] is undefined at the `allowed.includes` call, which
    // throws a TypeError instead of a ProfileError an operator can read.
    const json = JSON.stringify({
      vendor: "acmebooks",
      datasets: [{ dataset: 42, required: ["Ref"], columns: { bill_id: "Ref" } }],
    });
    expect(() => parseProfileJson(json)).toThrow(ProfileError);
  });

  it("narrows a string to a dataset name only when it is one", () => {
    // Mutation: implement isDatasetName as `typeof value === "string"` → red.
    expect(isDatasetName("charge")).toBe(true);
    expect(isDatasetName("invoice")).toBe(true);
    expect(isDatasetName("stripe_ledger")).toBe(false);
    expect(isDatasetName("payments.charge")).toBe(false);
    expect(isDatasetName(undefined)).toBe(false);
    expect(isDatasetName(42)).toBe(false);
  });

  it("scans an operator-declared SaaS dataset into canonical rows", async () => {
    // The widening is not cloud-only by construction: an operator who exports
    // a Stripe payout report as CSV can map it today, without a release. This
    // exercises the whole widened surface at once — DATASETS membership at
    // registration, CANONICAL_COLUMNS for the projection, COLUMN_KIND for the
    // parse, NATURAL_KEY for the dedup.
    //
    // Mutations: leave `payout` out of DATASETS → registration throws → red.
    // Read the money column as text → `amount` is the string "1,250.00" → red.
    // Drop `payout` from NATURAL_KEY → the scan cannot key the row → red.
    const root = await mkdtemp(join(tmpdir(), "droplet-vocab-payout-"));
    try {
      const path = join(root, "payouts.csv");
      await writeFile(
        path,
        [
          "Payout,Created,Amount,Currency,State",
          'po_1,2026-08-01,"1,250.00",usd,paid',
          // The same payout re-exported: dedup must REPLACE it, not double the
          // money. Mutation: drop `payout` from NATURAL_KEY's identity → two
          // rows → red.
          'po_1,2026-08-01,"1,250.00",usd,paid',
          "",
        ].join("\n"),
        "utf8",
      );
      const settled = new Date(Date.UTC(2026, 7, 19, 11, 0, 0));
      await utimes(path, settled, settled);

      const profiles = parseProfileJson(
        JSON.stringify({
          vendor: "stripeexport",
          label: "Stripe CSV export",
          datasets: [
            {
              dataset: "payout",
              required: ["Payout", "Amount", "Currency"],
              columns: {
                payout_id: "Payout",
                created_at: "Created",
                amount: "Amount",
                currency: "Currency",
                status: "State",
              },
            },
          ],
        }),
      );

      const snapshot = await scanDropDirectory(root, profiles, {
        ...DEFAULT_SCAN_LIMITS,
        now: () => Date.UTC(2026, 7, 19, 12, 0, 0),
      });
      const payouts = snapshot.datasets.get("payout");
      expect(payouts, "the payout dataset was not scanned").toBeDefined();
      expect(payouts!.rows).toHaveLength(1);
      const row = payouts!.rows[0];
      // Decimal MAJOR units, per the canonical contract — a number, not
      // the string "1,250.00" that a text parse would produce.
      expect(row.amount).toBe(1250);
      expect(row.currency).toBe("usd");
      expect(row.payout_id).toBe("po_1");
      // Every canonical column is present-and-undefined rather than absent, so
      // a consumer cannot tell the three tracks apart by probing for a key.
      expect(Object.keys(row).sort()).toEqual([...CANONICAL_COLUMNS.payout].sort());
      expect(row.arrival_at).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a new read the export track cannot answer — never an empty array", async () => {
    // The export track dispatches reads by name and its `default` arm blocks
    // rather than returning []. WARP-2280 added fourteen queries that no track
    // implements yet, so this arm is now genuinely reachable, and what it does
    // matters: `[]` from `get_payouts` reads as "no money moved", which is a
    // confident false statement of exactly the kind DatasetNotServedError was
    // created to prevent.
    //
    // Mutation: make the default arm `return []` → red. Mutation: implement
    // the read → this test is the thing that must be updated deliberately.
    const root = await mkdtemp(join(tmpdir(), "droplet-vocab-refuse-"));
    try {
      const path = join(root, "payouts.csv");
      await writeFile(path, 'Payout,Amount,Currency\npo_1,"1,250.00",usd\n', "utf8");
      const settled = new Date(Date.UTC(2026, 7, 19, 11, 0, 0));
      await utimes(path, settled, settled);

      const profiles = parseProfileJson(
        JSON.stringify({
          vendor: "stripeexport",
          label: "Stripe CSV export",
          datasets: [
            {
              dataset: "payout",
              required: ["Payout", "Amount", "Currency"],
              columns: { payout_id: "Payout", amount: "Amount", currency: "Currency" },
            },
          ],
        }),
      );
      const c = new ExportDropConnector(
        { vendor: "stripeexport", root },
        {
          now: () => Date.UTC(2026, 7, 19, 12, 0, 0),
          profiles,
          minRefreshMs: Number.POSITIVE_INFINITY,
        },
      );
      await c.connect();
      // The capability IS declared — this is not a "does not serve" case.
      expect(c.servesDatasets).toEqual(["payout"]);

      const err = await c
        .runRead("get_payouts", { from: "2026-07-01T00:00:00Z", to: "2026-09-01T00:00:00Z" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorBlockedError);
      expect(err).not.toBeInstanceOf(DatasetNotServedError);
      expect((err as Error).message).toMatch(/not served by the export-drop track/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
