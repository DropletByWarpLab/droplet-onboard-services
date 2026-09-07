/**
 * WARP-2707 / ADR-046 — the named read queries, expressed as operations over
 * CANONICAL rows rather than as SQL.
 *
 * ## The problem this solves
 *
 * `read-queries.ts` is the injection-proof data plane for the LAN tracks: each
 * entry resolves identifiers through the schema map and binds every value as
 * `?`. A REST vendor has no schema map and no `?`, so every cloud connector so
 * far has re-implemented each query's SEMANTICS in TypeScript — Brevo's
 * `find_contact` does a client-side `startsWith` on `last_name` and then
 * `ORDER BY last_name, first_name`, in prose, because Brevo's own `filter`
 * parameter documents only `equals` and pushing it down would silently answer a
 * different question than the one asked.
 *
 * That re-implementation is the largest single block of per-vendor code, and it
 * is the same block in every vendor. Twenty-five read queries reduce to SIX
 * shapes over canonical columns:
 *
 *   • list everything                        (`get_ar_summary`, `get_audiences`)
 *   • prefix-match one text column           (`find_contact`, `find_patient`)
 *   • equal one column to a parameter        (`get_company`, `get_deals_by_stage`)
 *   • window one instant column by from/to   (`get_recent_charges`, `get_payouts`)
 *   • keep rows under a numeric threshold    (`get_low_stock_products`)
 *   • two equality filters at once           (`get_audience_members`)
 *
 * So they become data. One table, shared by every profile, and the vendor's job
 * shrinks to "hand me canonical rows for this dataset" — which is exactly what
 * `RestDatasetSpec` describes.
 *
 * ## Why the filtering is CLIENT-SIDE, and why that is not a shortcut
 *
 * Pushing a filter into the vendor's query string requires knowing that the
 * vendor's operator means what the read query means. Brevo's `equals` is not
 * `LIKE 'smith%'`; Klaviyo's filter operators differ per endpoint; Square's
 * differ per resource. Getting that wrong does not error — it returns a
 * plausible, wrong answer. Filtering canonical rows after projection is the
 * only place where one implementation is correct for every vendor, which is the
 * whole premise of the track.
 *
 * The cost is honest and bounded: the watermark still narrows the fetch (that
 * IS pushed down, per dataset, in `RestDatasetSpec.watermark`), so the client
 * side filters a delta rather than a whole account. Where a vendor's dataset is
 * genuinely large and a filter genuinely pushes down, that vendor has outgrown
 * the track and gets a bespoke connector — as Mailchimp and Stripe have.
 *
 * ## The ordering is part of the contract
 *
 * Every entry declares `orderBy`, because the LAN queries all carry an
 * `ORDER BY` and a caller that got rows in vendor order from one track and
 * sorted order from another would be reading two different contracts through
 * one name.
 */
import type { DatasetName } from "../export-drop/profiles.js";

/** How a named read query narrows the canonical rows of its dataset. */
export type RestReadFilter =
  /** No narrowing — the dataset as read. */
  | { readonly kind: "all" }
  /**
   * Case-insensitive prefix match on one text column.
   *
   * A MISSING or empty parameter returns everything, matching the LAN
   * behaviour where `escapeLike("")` yields `LIKE '%'`. An absent search term
   * is "show me all", not "show me none".
   */
  | { readonly kind: "prefix"; readonly column: string; readonly param: string }
  /** Exact match on one column, compared as text so `5` and `"5"` agree. */
  | { readonly kind: "equals"; readonly column: string; readonly param: string }
  /**
   * Half-open window `[from, to)` on one instant column.
   *
   * Half-open deliberately: `get_recent_charges` for August and the same for
   * September must not both return a charge at exactly `2026-09-01T00:00:00Z`.
   * A closed window double-counts money at every boundary.
   */
  | { readonly kind: "window"; readonly column: string }
  /** Keep rows whose numeric column is at or below a threshold parameter. */
  | { readonly kind: "atMost"; readonly column: string; readonly param: string }
  /** Two equality filters, both of which must hold. */
  | {
      readonly kind: "equalsBoth";
      readonly first: { readonly column: string; readonly param: string };
      readonly second: { readonly column: string; readonly param: string };
    };

/** One read query, as data. */
export interface RestReadSemantics {
  readonly dataset: DatasetName;
  readonly filter: RestReadFilter;
  /** Applied left to right, ascending — the `ORDER BY` of the LAN query. */
  readonly orderBy: readonly string[];
}

/**
 * The twenty-five named read queries.
 *
 * Each entry's `dataset` MUST equal the single entry in that query's
 * `dependsOnTables` in `read-queries.ts`, and each `column` MUST appear in
 * `CANONICAL_COLUMNS[dataset]`. Neither is checkable from this module alone —
 * both are pinned by `rest-read-semantics.test.ts`, which reads the real
 * registry and the real column map rather than a copy of either. A table that
 * merely LOOKS right next to them is the failure mode; the test is what makes
 * it right.
 */
export const REST_READ_SEMANTICS: Readonly<Record<string, RestReadSemantics>> = {
  // ── practice management ───────────────────────────────────────────────────
  get_schedule_today: {
    dataset: "appointment",
    filter: { kind: "window", column: "appt_time" },
    orderBy: ["appt_time", "appt_id"],
  },
  find_patient: {
    dataset: "patient",
    filter: { kind: "prefix", column: "last_name", param: "query" },
    orderBy: ["last_name", "first_name"],
  },
  get_patient: {
    dataset: "patient",
    filter: { kind: "equals", column: "patient_id", param: "patientId" },
    orderBy: ["patient_id"],
  },
  get_ar_summary: {
    dataset: "account",
    filter: { kind: "all" },
    orderBy: ["account_id"],
  },
  // `recall` is not one of the twenty-three canonical datasets, and the LAN
  // query reads a recall table no REST profile declares. It is listed so the
  // coverage test can see it is DELIBERATELY unserved rather than forgotten —
  // a REST connection asked for it raises DatasetNotServedError, which is the
  // honest answer ("this connection works and will never have that data"),
  // not an empty array.
  //   get_recall_due — intentionally absent.

  // ── accounting ────────────────────────────────────────────────────────────
  get_open_invoices: {
    dataset: "invoice",
    filter: { kind: "all" },
    orderBy: ["due_at", "invoice_id"],
  },
  get_open_bills: {
    dataset: "bill",
    filter: { kind: "all" },
    orderBy: ["due_at", "bill_id"],
  },
  get_ap_summary: {
    dataset: "ap_summary",
    filter: { kind: "all" },
    orderBy: ["vendor_id"],
  },

  // ── payments ──────────────────────────────────────────────────────────────
  get_recent_charges: {
    dataset: "charge",
    filter: { kind: "window", column: "created_at" },
    orderBy: ["created_at", "charge_id"],
  },
  get_refunds: {
    dataset: "refund",
    filter: { kind: "window", column: "created_at" },
    orderBy: ["created_at", "refund_id"],
  },
  get_payouts: {
    dataset: "payout",
    filter: { kind: "window", column: "created_at" },
    orderBy: ["created_at", "payout_id"],
  },
  get_processing_fees: {
    dataset: "balance_transaction",
    filter: { kind: "window", column: "created_at" },
    orderBy: ["created_at", "balance_transaction_id"],
  },
  get_subscriptions_by_status: {
    dataset: "subscription",
    filter: { kind: "equals", column: "status", param: "status" },
    orderBy: ["current_period_end", "subscription_id"],
  },

  // ── CRM ───────────────────────────────────────────────────────────────────
  find_contact: {
    dataset: "contact",
    filter: { kind: "prefix", column: "last_name", param: "query" },
    orderBy: ["last_name", "first_name"],
  },
  get_company: {
    dataset: "company",
    filter: { kind: "equals", column: "company_id", param: "companyId" },
    orderBy: ["company_id"],
  },
  get_deals_by_stage: {
    dataset: "deal",
    filter: { kind: "equals", column: "stage", param: "stage" },
    orderBy: ["closed_at", "deal_id"],
  },
  get_tickets_by_status: {
    dataset: "ticket",
    filter: { kind: "equals", column: "status", param: "status" },
    orderBy: ["created_at", "ticket_id"],
  },
  get_engagements: {
    dataset: "engagement",
    filter: { kind: "window", column: "occurred_at" },
    orderBy: ["occurred_at", "engagement_id"],
  },

  // ── commerce ──────────────────────────────────────────────────────────────
  get_recent_orders: {
    dataset: "order",
    filter: { kind: "window", column: "created_at" },
    orderBy: ["created_at", "order_id"],
  },
  get_low_stock_products: {
    dataset: "product",
    filter: { kind: "atMost", column: "inventory_quantity", param: "threshold" },
    orderBy: ["inventory_quantity", "product_id"],
  },
  find_customer: {
    dataset: "customer",
    filter: { kind: "prefix", column: "last_name", param: "query" },
    orderBy: ["last_name", "first_name"],
  },

  // ── marketing ─────────────────────────────────────────────────────────────
  get_campaign_performance: {
    dataset: "campaign",
    filter: { kind: "window", column: "sent_at" },
    orderBy: ["sent_at", "campaign_id"],
  },
  get_audiences: {
    dataset: "audience",
    filter: { kind: "all" },
    orderBy: ["audience_id"],
  },
  get_audience_members: {
    dataset: "audience_member",
    filter: {
      kind: "equalsBoth",
      first: { column: "audience_id", param: "audienceId" },
      second: { column: "subscription_status", param: "status" },
    },
    orderBy: ["audience_member_id"],
  },
  get_ecommerce_orders: {
    dataset: "ecommerce_order",
    filter: { kind: "window", column: "processed_at" },
    orderBy: ["processed_at", "ecommerce_order_id"],
  },

  // ── WARP-2832 — scheduling, people, projects ──────────────────────────────
  //
  // 🔴 These three entries are the SILENT half of adding a dataset. This table
  // is keyed by a bare `string`, so a REST vendor can declare a dataset, ship
  // its descriptor, pass every drift gate, fingerprint it at connect — and
  // then refuse every read with `DatasetNotServedError`, because `runRead`
  // finds no semantics for the query name. Nothing goes red. That is exactly
  // how Cal.com came to be connectable and unreadable.
  get_bookings: {
    dataset: "booking",
    // Half-open on the START time, matching the LAN query: a booking at
    // exactly midnight belongs to one day, not to both.
    filter: { kind: "window", column: "starts_at" },
    orderBy: ["starts_at", "booking_id"],
  },
  find_employee: {
    dataset: "employee",
    filter: { kind: "prefix", column: "last_name", param: "query" },
    orderBy: ["last_name", "first_name"],
  },
  get_tasks_by_status: {
    dataset: "task",
    filter: { kind: "equals", column: "status", param: "status" },
    // Oldest first: the item waiting longest is the one worth surfacing.
    orderBy: ["created_at", "task_id"],
  },
};

/** Read one canonical column as comparable text, or `undefined` when absent. */
function asText(row: Record<string, unknown>, column: string): string | undefined {
  const value = row[column];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/** Read one canonical column as a finite number, or `undefined`. */
function asNumber(row: Record<string, unknown>, column: string): number | undefined {
  const value = row[column];
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Read one canonical column as an epoch-millis instant, or `undefined`. */
function asInstant(row: Record<string, unknown>, column: string): number | undefined {
  const text = asText(row, column);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** A parameter as trimmed text, or `undefined` when absent or blank. */
function paramText(params: Record<string, unknown>, name: string): string | undefined {
  const raw = params[name];
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text === "" ? undefined : text;
}

/**
 * Narrow canonical rows the way the named read query would.
 *
 * 🔴 A row whose filtered column is `undefined` is DROPPED by every filter
 * except `all`. That is deliberate and matches SQL: `NULL LIKE 'smith%'` is not
 * true, and `NULL BETWEEN a AND b` is not true. Keeping unknown rows "just in
 * case" would put a row with no `created_at` into every date window at once.
 */
export function applyRestReadFilter(
  rows: readonly Record<string, unknown>[],
  filter: RestReadFilter,
  params: Record<string, unknown>,
): Record<string, unknown>[] {
  switch (filter.kind) {
    case "all":
      return [...rows];

    case "prefix": {
      const needle = paramText(params, filter.param)?.toLowerCase();
      // An absent term is "show me all", exactly as `escapeLike("")` yields
      // `LIKE '%'` on the LAN track.
      if (needle === undefined) return [...rows];
      return rows.filter((row) => asText(row, filter.column)?.toLowerCase().startsWith(needle) ?? false);
    }

    case "equals": {
      const wanted = paramText(params, filter.param);
      if (wanted === undefined) return [...rows];
      return rows.filter((row) => asText(row, filter.column) === wanted);
    }

    case "equalsBoth": {
      const first = paramText(params, filter.first.param);
      const second = paramText(params, filter.second.param);
      return rows.filter((row) => {
        if (first !== undefined && asText(row, filter.first.column) !== first) return false;
        if (second !== undefined && asText(row, filter.second.column) !== second) return false;
        return true;
      });
    }

    case "window": {
      const fromText = paramText(params, "from");
      const toText = paramText(params, "to");
      const from = fromText === undefined ? undefined : Date.parse(fromText);
      const to = toText === undefined ? undefined : Date.parse(toText);
      // An unparseable bound is refused rather than ignored: silently widening
      // a money window to "everything" because a caller sent a bad date is the
      // kind of confident wrong answer this codebase refuses elsewhere.
      if (from !== undefined && Number.isNaN(from)) {
        throw new RangeError(`"from" is not an instant: ${String(params.from)}`);
      }
      if (to !== undefined && Number.isNaN(to)) {
        throw new RangeError(`"to" is not an instant: ${String(params.to)}`);
      }
      if (from === undefined && to === undefined) return [...rows];
      return rows.filter((row) => {
        const at = asInstant(row, filter.column);
        if (at === undefined) return false;
        if (from !== undefined && at < from) return false;
        // Half-open: `to` is excluded, so adjacent windows never double-count.
        if (to !== undefined && at >= to) return false;
        return true;
      });
    }

    case "atMost": {
      const ceiling = asNumber(params as Record<string, unknown>, filter.param);
      if (ceiling === undefined) return [...rows];
      return rows.filter((row) => {
        const value = asNumber(row, filter.column);
        return value !== undefined && value <= ceiling;
      });
    }
  }
}

/**
 * Sort canonical rows by the query's declared columns, ascending.
 *
 * Stable, and `undefined` sorts LAST on every column — a row missing the sort
 * key has no defensible position among rows that have one, and putting it first
 * would make "the earliest appointment" a row with no time.
 */
export function applyRestReadOrder(
  rows: readonly Record<string, unknown>[],
  orderBy: readonly string[],
): Record<string, unknown>[] {
  return [...rows].sort((left, right) => {
    for (const column of orderBy) {
      const a = asText(left, column);
      const b = asText(right, column);
      if (a === b) continue;
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      // Numeric columns compare numerically; everything else compares as text.
      const na = asNumber(left, column);
      const nb = asNumber(right, column);
      if (na !== undefined && nb !== undefined) return na < nb ? -1 : 1;
      return a < b ? -1 : 1;
    }
    return 0;
  });
}

/** The semantics for a named read query, or `undefined` if the track has none. */
export function restReadSemantics(name: string): RestReadSemantics | undefined {
  return Object.prototype.hasOwnProperty.call(REST_READ_SEMANTICS, name)
    ? REST_READ_SEMANTICS[name]
    : undefined;
}
