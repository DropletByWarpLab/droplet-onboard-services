/**
 * WARP-1964 — export profiles: how one PMS's exported columns map onto the
 * canonical row shapes the read registry already returns.
 *
 * A profile is DATA, not code. Adding a practice-management system to this
 * track is a profile entry plus a test — never a new connector class — which is
 * what makes the track vendor-agnostic rather than Eaglesoft-with-extra-steps.
 * Operators can supply their own profiles as JSON (see {@link parseProfileJson})
 * so an install can map a product we have never seen without waiting for a
 * release.
 *
 * Two rules keep a wrong profile from becoming wrong data:
 *
 *  1. **Detection is by header signature, never by filename.** A file is
 *     claimed only if every `required` header is present. A profile that does
 *     not match simply does not claim the file; the file is then reported as
 *     unrecognized *together with the headers it actually had*, which is
 *     exactly what an operator needs to author the right profile.
 *  2. **Ambiguity is refused, not resolved.** Two profiles matching one file is
 *     a profile-authoring bug; picking the first would silently pick a coin
 *     flip. Detection is also scoped to the connection's own vendor, so
 *     unrelated products can never collide in the first place.
 *
 * PURE: no I/O.
 */

/**
 * The logical datasets this track can serve. These are the tables the read
 * registry's queries depend on (`ReadQuery.dependsOnTables`).
 *
 * WARP-2107 widened this from the original dental-only trio to cover
 * accounting. The vocabulary is deliberately ONE list rather than a
 * per-category one: a dataset name is the join between a profile, a read
 * query's `dependsOnTables`, and a connector's declared capability, and
 * splitting it would mean three places to keep in agreement instead of one.
 */
export const DATASETS = [
  // practice-management (WARP-1964)
  "appointment",
  "patient",
  "account",
  // accounting (WARP-2107)
  "invoice",
  "bill",
  "ap_summary",
] as const;
export type DatasetName = (typeof DATASETS)[number];

/**
 * What a dataset is *about*.
 *
 * This is descriptive, not a permission: a vendor profile may legitimately
 * span both (a practice-management system that also carries receivables
 * already does — `account` is a practice profile's accounting-shaped dataset).
 * It exists so a caller can say "this connection has no accounting data"
 * without hardcoding a name list, and so the dashboard can group them.
 */
export const DATASET_CATEGORY: Readonly<Record<DatasetName, "practice" | "accounting">> = {
  appointment: "practice",
  patient: "practice",
  account: "accounting",
  invoice: "accounting",
  bill: "accounting",
  ap_summary: "accounting",
};

/**
 * The canonical column names per dataset — the SELECT identifiers the SQL track
 * emits, which the REST track already reproduces (`api-dto.ts`). A row this
 * track returns must be indistinguishable from the same row on either other
 * track, so this list is the contract and not a suggestion.
 */
export const CANONICAL_COLUMNS: Readonly<Record<DatasetName, readonly string[]>> = {
  appointment: ["appt_id", "appt_time", "provider_id", "operatory_id", "status", "patient_id"],
  patient: ["patient_id", "first_name", "last_name"],
  account: ["account_id", "balance"],
  // Money OWED TO the business. `balance` is what remains unpaid, which is not
  // the same as `amount` — an invoice part-paid still has its original amount,
  // and summing amounts instead of balances overstates receivables.
  invoice: ["invoice_id", "issued_at", "due_at", "customer_id", "amount", "balance", "status"],
  // Money OWED BY the business — the half WARP-1991 records as having no data
  // source anywhere in the product.
  bill: ["bill_id", "issued_at", "due_at", "vendor_id", "amount", "balance", "status"],
  ap_summary: ["vendor_id", "balance"],
};

/**
 * The canonical columns a dataset cannot be served without. `appt_time` is
 * required because the schedule read is a time-window filter; `last_name`
 * because the patient read is a name prefix search. A profile missing one of
 * these would produce a dataset that parses and then answers every query
 * wrongly, so it is rejected at registration instead.
 *
 * For the accounting datasets the required column is the one the aggregate is
 * computed over. A `bill` dataset without `balance` would sum to zero and
 * report it as fact — the same class of confidently-wrong answer, in the one
 * domain where nobody would notice it was wrong.
 */
export const REQUIRED_CANONICAL: Readonly<Record<DatasetName, readonly string[]>> = {
  appointment: ["appt_id", "appt_time"],
  patient: ["patient_id", "last_name"],
  account: ["balance"],
  invoice: ["invoice_id", "balance"],
  bill: ["bill_id", "balance"],
  ap_summary: ["balance"],
};

/**
 * How a canonical column's cell is parsed out of an exported file.
 *
 * Declared here rather than branched on by name in the scanner, which is what
 * `projectRow` did while there were exactly two special cases (`appt_time`,
 * `balance`). With money and dates on four datasets that branch becomes a list
 * of names in a different file from the list of columns — so the kind travels
 * WITH the column, and a new canonical column cannot be added without saying
 * how to read it.
 *
 * Every canonical column must appear here; `assertColumnKindsComplete` proves
 * it at module load, so a missing entry is a startup failure rather than a
 * column that silently parses as text (a money column read as text would
 * serialize an amount as the string "1,234.56" and break every aggregate).
 */
export const COLUMN_KIND: Readonly<Record<string, "text" | "money" | "timestamp">> = {
  // practice
  appt_id: "text",
  appt_time: "timestamp",
  provider_id: "text",
  operatory_id: "text",
  status: "text",
  patient_id: "text",
  first_name: "text",
  last_name: "text",
  account_id: "text",
  balance: "money",
  // accounting
  invoice_id: "text",
  bill_id: "text",
  issued_at: "timestamp",
  due_at: "timestamp",
  customer_id: "text",
  vendor_id: "text",
  amount: "money",
};

/** Fail at module load if a canonical column has no declared parse kind. */
function assertColumnKindsComplete(): void {
  const missing: string[] = [];
  for (const dataset of DATASETS) {
    for (const column of CANONICAL_COLUMNS[dataset]) {
      if (!(column in COLUMN_KIND)) missing.push(`${dataset}.${column}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `COLUMN_KIND is missing an entry for: ${missing.join(", ")} — ` +
        `every canonical column must declare how its cell is parsed`,
    );
  }
}
assertColumnKindsComplete();

/** One dataset's mapping within a vendor profile. */
export interface DatasetProfile {
  dataset: DatasetName;
  /** Source headers that must ALL be present for this profile to claim a file. */
  required: readonly string[];
  /** canonical column name -> source header spelling. */
  columns: Readonly<Record<string, string>>;
}

/** One practice-management system's export shape. */
export interface ExportProfile {
  /** Vendor key; the provider is `<vendor>-export`. */
  vendor: string;
  /** Human label for diagnostics and (later) the dashboard hub. */
  label: string;
  /**
   * Whether this mapping has been confirmed against a real export produced by
   * that product. Every built-in ships `false` — we have not had an install in
   * front of us. This is surfaced rather than hidden because an unconfirmed
   * mapping is exactly the thing an operator should check on day one.
   */
  verified: boolean;
  datasets: readonly DatasetProfile[];
}

/** Thrown when a profile is structurally invalid. Registration-time failure —
 *  a malformed profile must never reach the matcher. */
export class ProfileError extends Error {
  readonly code = "EXPORT_PROFILE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/**
 * Normalize a header for matching: trim, collapse internal whitespace, lower-case.
 *
 * Exports differ in case and spacing between report versions without the column
 * meaning anything different (`Patient ID`, `PATIENT  ID`, `patient id`).
 * Matching on the normalized form absorbs that; the original spelling is kept
 * for diagnostics.
 */
export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Validate one profile, throwing {@link ProfileError} on the first problem. */
export function assertValidProfile(profile: ExportProfile): void {
  if (!profile.vendor || !/^[a-z0-9][a-z0-9-]*$/.test(profile.vendor)) {
    throw new ProfileError(
      `profile vendor "${profile.vendor}" must be lower-case alphanumeric with dashes`,
    );
  }
  if (profile.datasets.length === 0) {
    throw new ProfileError(`profile "${profile.vendor}" declares no datasets`);
  }
  const seen = new Set<string>();
  for (const ds of profile.datasets) {
    if (!(DATASETS as readonly string[]).includes(ds.dataset)) {
      throw new ProfileError(`profile "${profile.vendor}" has unknown dataset "${ds.dataset}"`);
    }
    if (seen.has(ds.dataset)) {
      throw new ProfileError(`profile "${profile.vendor}" declares dataset "${ds.dataset}" twice`);
    }
    seen.add(ds.dataset);

    if (ds.required.length === 0) {
      throw new ProfileError(
        `profile "${profile.vendor}" dataset "${ds.dataset}" has no required headers — ` +
          `it would claim every file`,
      );
    }
    const allowed = CANONICAL_COLUMNS[ds.dataset];
    for (const canonical of Object.keys(ds.columns)) {
      if (!allowed.includes(canonical)) {
        throw new ProfileError(
          `profile "${profile.vendor}" dataset "${ds.dataset}" maps unknown canonical ` +
            `column "${canonical}" (known: ${allowed.join(", ")})`,
        );
      }
    }
    for (const canonical of REQUIRED_CANONICAL[ds.dataset]) {
      if (!ds.columns[canonical]) {
        throw new ProfileError(
          `profile "${profile.vendor}" dataset "${ds.dataset}" must map "${canonical}"`,
        );
      }
    }
    // Every source header a mapping points at has to be one the matcher
    // actually checked for; otherwise the profile could claim a file and then
    // read a column that is not there.
    const requiredSet = new Set(ds.required.map(normalizeHeader));
    for (const [canonical, header] of Object.entries(ds.columns)) {
      if (REQUIRED_CANONICAL[ds.dataset].includes(canonical) && !requiredSet.has(normalizeHeader(header))) {
        throw new ProfileError(
          `profile "${profile.vendor}" dataset "${ds.dataset}" maps required column ` +
            `"${canonical}" to header "${header}", which is not in its required list`,
        );
      }
    }
  }
}

/**
 * Built-in profiles. All ship `verified: false` — see {@link ExportProfile.verified}.
 *
 * These are starting points that make a first site visit productive, not
 * claims about what a given install emits. Report layouts are configurable in
 * every one of these products, so the operator confirms the mapping against a
 * real export and adjusts via an operator profile if it differs. Because a
 * non-matching profile degrades to "unrecognized file, here are its headers",
 * a wrong guess here costs an operator one edit — it can never produce wrong
 * rows.
 *
 * The `opendental` mapping is modelled on Open Dental's published schema
 * (`appointment.AptNum` / `AptDateTime` / `AptStatus`, `patient.PatNum` /
 * `FName` / `LName`), which is documented publicly; the other two are shaped
 * from the report columns those products present in their UI.
 */
export const BUILT_IN_PROFILES: readonly ExportProfile[] = [
  {
    vendor: "eaglesoft",
    label: "Eaglesoft (Patterson Dental)",
    verified: false,
    datasets: [
      {
        dataset: "appointment",
        required: ["Appointment ID", "Appointment Time"],
        columns: {
          appt_id: "Appointment ID",
          appt_time: "Appointment Time",
          provider_id: "Provider ID",
          operatory_id: "Operatory",
          status: "Status",
          patient_id: "Patient ID",
        },
      },
      {
        dataset: "patient",
        required: ["Patient ID", "Last Name"],
        columns: { patient_id: "Patient ID", first_name: "First Name", last_name: "Last Name" },
      },
      {
        dataset: "account",
        required: ["Account ID", "Balance"],
        columns: { account_id: "Account ID", balance: "Balance" },
      },
    ],
  },
  {
    vendor: "dentrix",
    label: "Dentrix (Henry Schein)",
    verified: false,
    datasets: [
      {
        dataset: "appointment",
        required: ["Appt ID", "Appt Date"],
        columns: {
          appt_id: "Appt ID",
          appt_time: "Appt Date",
          provider_id: "Provider",
          operatory_id: "Operatory",
          status: "Status",
          patient_id: "Patient ID",
        },
      },
      {
        dataset: "patient",
        required: ["Patient ID", "Last Name"],
        columns: { patient_id: "Patient ID", first_name: "First Name", last_name: "Last Name" },
      },
      {
        dataset: "account",
        required: ["Guarantor ID", "Balance"],
        columns: { account_id: "Guarantor ID", balance: "Balance" },
      },
    ],
  },
  {
    // WARP-2107 — the first ACCOUNTING vendor on this track, and the first
    // profile whose datasets are not dental. Shapes are taken from the columns
    // QuickBooks prints in its own report UI; Desktop and Online emit the same
    // report names and broadly the same headers, so one profile covers both
    // products, which is what makes this the cheapest QuickBooks integration
    // available (no SDK, no OAuth, no meter, no vendor approval).
    //
    // Report → dataset mapping this assumes the practice exports:
    //   "Open Invoices"        → invoice
    //   "Unpaid Bills Detail"  → bill
    //   "A/P Aging Summary"    → ap_summary
    //
    // The `required` lists carry DISCRIMINATORS beyond the strictly-required
    // canonical columns, because the three reports overlap heavily. Open
    // Invoices and Unpaid Bills Detail both print `Num` + `Open Balance` and
    // differ only by `Customer` vs `Vendor`; A/P Aging Summary is separated by
    // `Current`, its first ageing bucket. Without those, two profiles would
    // claim one file and the matcher would (correctly) refuse it as ambiguous
    // rather than guess — a refusal is safe, but a needless one wastes a site
    // visit.
    //
    // `status` is deliberately UNMAPPED on both: QuickBooks' open-item reports
    // carry a `Transaction Type` column whose value is the document kind
    // ("Invoice", "Bill"), not a payment status. Mapping it would put a
    // confident wrong value in a field callers read as state — and an unmapped
    // canonical column is present-and-undefined, which is honest.
    vendor: "quickbooks",
    label: "QuickBooks (Intuit) — Desktop or Online",
    verified: false,
    datasets: [
      {
        dataset: "invoice",
        required: ["Num", "Open Balance", "Customer"],
        columns: {
          invoice_id: "Num",
          issued_at: "Date",
          due_at: "Due Date",
          customer_id: "Customer",
          amount: "Amount",
          balance: "Open Balance",
        },
      },
      {
        dataset: "bill",
        required: ["Num", "Open Balance", "Vendor"],
        columns: {
          bill_id: "Num",
          issued_at: "Date",
          due_at: "Due Date",
          vendor_id: "Vendor",
          amount: "Amount",
          balance: "Open Balance",
        },
      },
      {
        dataset: "ap_summary",
        required: ["Vendor", "Total", "Current"],
        columns: { vendor_id: "Vendor", balance: "Total" },
      },
    ],
  },
  {
    vendor: "opendental",
    label: "Open Dental",
    verified: false,
    datasets: [
      {
        dataset: "appointment",
        required: ["AptNum", "AptDateTime"],
        columns: {
          appt_id: "AptNum",
          appt_time: "AptDateTime",
          provider_id: "ProvNum",
          operatory_id: "Op",
          status: "AptStatus",
          patient_id: "PatNum",
        },
      },
      {
        dataset: "patient",
        required: ["PatNum", "LName"],
        columns: { patient_id: "PatNum", first_name: "FName", last_name: "LName" },
      },
      {
        dataset: "account",
        required: ["PatNum", "EstBalance"],
        columns: { account_id: "PatNum", balance: "EstBalance" },
      },
    ],
  },
];

/**
 * The vendor key reserved for installs whose product has no built-in profile.
 * It ships no datasets of its own — an operator profile supplies them — so a
 * `generic-export` connection with no operator profile blocks honestly instead
 * of pretending to support an unknown product.
 */
export const GENERIC_VENDOR = "generic";

/** Every vendor this track can be configured for, built-ins plus the generic
 *  escape hatch. Used to validate a provider key before a connection is saved. */
export function knownVendors(extra: readonly ExportProfile[] = []): string[] {
  const vendors = new Set<string>([GENERIC_VENDOR]);
  for (const p of BUILT_IN_PROFILES) vendors.add(p.vendor);
  for (const p of extra) vendors.add(p.vendor);
  return [...vendors].sort();
}

/**
 * Profiles in force for one vendor: its built-in (if any) plus operator-supplied
 * ones. An operator profile for a vendor REPLACES the built-in rather than
 * merging with it — a half-overridden mapping is the kind of thing nobody can
 * reason about at 8am at a practice, and replacing is the behaviour an operator
 * writing a profile expects.
 */
export function profilesForVendor(
  vendor: string,
  extra: readonly ExportProfile[] = [],
): ExportProfile[] {
  const overrides = extra.filter((p) => p.vendor === vendor);
  if (overrides.length > 0) return overrides;
  return BUILT_IN_PROFILES.filter((p) => p.vendor === vendor);
}

/** A dataset profile paired with the vendor profile that carried it. */
export interface DatasetCandidate {
  profile: ExportProfile;
  dataset: DatasetProfile;
}

/** The outcome of matching one file's headers against a vendor's profiles. */
export type MatchResult =
  | { kind: "matched"; candidate: DatasetCandidate }
  | { kind: "unrecognized" }
  | { kind: "ambiguous"; datasets: string[] };

/**
 * Match a header row against a vendor's profiles.
 *
 * Every `required` header must be present (normalized comparison). Zero matches
 * is `unrecognized`; more than one is `ambiguous` and is refused — see the
 * module docstring for why neither degrades into a guess.
 */
export function matchDataset(
  headers: readonly string[],
  profiles: readonly ExportProfile[],
): MatchResult {
  const present = new Set(headers.map(normalizeHeader));
  const hits: DatasetCandidate[] = [];

  for (const profile of profiles) {
    for (const dataset of profile.datasets) {
      const allPresent = dataset.required.every((h) => present.has(normalizeHeader(h)));
      if (allPresent) hits.push({ profile, dataset });
    }
  }

  if (hits.length === 0) return { kind: "unrecognized" };
  if (hits.length > 1) {
    return {
      kind: "ambiguous",
      datasets: hits.map((h) => `${h.profile.vendor}.${h.dataset.dataset}`).sort(),
    };
  }
  return { kind: "matched", candidate: hits[0] };
}

/**
 * Parse and validate operator-supplied profiles from JSON.
 *
 * Accepts either a single profile object or an array. Every profile is run
 * through {@link assertValidProfile}, so a typo in a column name is a startup
 * error naming the typo rather than a dataset that silently reads the wrong
 * column. An operator profile is always recorded `verified: true` — an operator
 * writing a mapping against the export in front of them has done exactly the
 * confirmation the built-ins are missing.
 */
export function parseProfileJson(json: string): ExportProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ProfileError(`operator profiles are not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const profiles: ExportProfile[] = [];

  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) {
      throw new ProfileError("each operator profile must be a JSON object");
    }
    const rec = raw as Record<string, unknown>;
    const vendor = typeof rec.vendor === "string" ? rec.vendor : "";
    const label = typeof rec.label === "string" ? rec.label : vendor;
    const rawDatasets = Array.isArray(rec.datasets) ? rec.datasets : [];

    const datasets: DatasetProfile[] = rawDatasets.map((d) => {
      if (typeof d !== "object" || d === null) {
        throw new ProfileError(`profile "${vendor}" has a non-object dataset entry`);
      }
      const dr = d as Record<string, unknown>;
      const columnsRaw = dr.columns;
      if (typeof columnsRaw !== "object" || columnsRaw === null) {
        throw new ProfileError(`profile "${vendor}" has a dataset with no columns map`);
      }
      const columns: Record<string, string> = {};
      for (const [k, v] of Object.entries(columnsRaw as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new ProfileError(
            `profile "${vendor}" maps canonical column "${k}" to a non-string header`,
          );
        }
        columns[k] = v;
      }
      const required = Array.isArray(dr.required)
        ? dr.required.filter((h): h is string => typeof h === "string")
        : [];
      return { dataset: dr.dataset as DatasetName, required, columns };
    });

    const profile: ExportProfile = { vendor, label, verified: true, datasets };
    assertValidProfile(profile);
    profiles.push(profile);
  }
  return profiles;
}
