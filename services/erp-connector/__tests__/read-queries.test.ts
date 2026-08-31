/**
 * WARP-1094 — read-query registry (brief §10.1, §10.3, §5 rules 3 & 4).
 *
 * Reads leave Eaglesoft ONLY through a fixed set of named, parameterized
 * queries. Values bind as `?`; identifiers resolve through the introspected
 * schema map, never from caller input. The LLM never emits SQL — it names a
 * registered query. An unknown query name is rejected.
 *
 * Unit tests only (no DB): we assert the built statement is parameterized and
 * that identifier resolution goes through the map (an unmapped table/column
 * throws rather than being concatenated).
 */
import { describe, it, expect } from "vitest";
import {
  READ_QUERIES,
  getReadQuery,
  buildReadStatement,
  scheduleDayBounds,
  UnknownReadQueryError,
} from "../src/read-queries.js";
import { buildSchemaMap, SchemaResolutionError, type IntrospectedTable } from "../src/schema-map.js";

const TABLES: IntrospectedTable[] = [
  {
    name: "appointment",
    owner: "dba",
    columns: [
      { name: "appt_id", type: "integer" },
      { name: "appt_time", type: "timestamp" },
      { name: "provider_id", type: "integer" },
      { name: "operatory_id", type: "integer" },
      { name: "status", type: "varchar" },
      { name: "patient_id", type: "integer" },
    ],
  },
  {
    name: "patient",
    owner: "dba",
    columns: [
      { name: "patient_id", type: "integer" },
      { name: "first_name", type: "varchar" },
      { name: "last_name", type: "varchar" },
    ],
  },
  {
    name: "account",
    owner: "dba",
    columns: [
      { name: "account_id", type: "integer" },
      { name: "balance", type: "numeric" },
      { name: "aging_bucket", type: "integer" },
    ],
  },
  // WARP-2107 — the accounting datasets. No shipping practice-management track
  // serves these (the connectors refuse them via `servesDatasets`), but the
  // registry is the single definition of what each read MEANS, so its SQL is
  // still built and asserted here against a schema that has the tables.
  {
    name: "invoice",
    owner: "dba",
    columns: [
      { name: "invoice_id", type: "integer" },
      { name: "issued_at", type: "timestamp" },
      { name: "due_at", type: "timestamp" },
      { name: "customer_id", type: "integer" },
      { name: "amount", type: "numeric" },
      { name: "balance", type: "numeric" },
      { name: "status", type: "varchar" },
    ],
  },
  {
    name: "bill",
    owner: "dba",
    columns: [
      { name: "bill_id", type: "integer" },
      { name: "issued_at", type: "timestamp" },
      { name: "due_at", type: "timestamp" },
      { name: "vendor_id", type: "integer" },
      { name: "amount", type: "numeric" },
      { name: "balance", type: "numeric" },
      { name: "status", type: "varchar" },
    ],
  },
  {
    name: "ap_summary",
    owner: "dba",
    columns: [
      { name: "vendor_id", type: "integer" },
      { name: "balance", type: "numeric" },
    ],
  },
  // WARP-2280 — the SaaS datasets. Same standing as the accounting block
  // above: no shipping track has a SQL database behind Stripe or HubSpot, but
  // the registry is the single definition of what each read MEANS and its SQL
  // is asserted here against a schema that has the tables. The columns mirror
  // CANONICAL_COLUMNS exactly, so a query that grows a column the vocabulary
  // does not declare fails here.
  {
    name: "charge",
    owner: "dba",
    columns: [
      { name: "charge_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "customer_id", type: "varchar" },
      { name: "amount", type: "numeric" },
      { name: "amount_refunded", type: "numeric" },
      { name: "currency", type: "varchar" },
      { name: "status", type: "varchar" },
    ],
  },
  {
    name: "refund",
    owner: "dba",
    columns: [
      { name: "refund_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "charge_id", type: "varchar" },
      { name: "amount", type: "numeric" },
      { name: "currency", type: "varchar" },
      { name: "status", type: "varchar" },
      { name: "reason", type: "varchar" },
    ],
  },
  {
    name: "payout",
    owner: "dba",
    columns: [
      { name: "payout_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "arrival_at", type: "timestamp" },
      { name: "amount", type: "numeric" },
      { name: "currency", type: "varchar" },
      { name: "status", type: "varchar" },
    ],
  },
  {
    name: "balance_transaction",
    owner: "dba",
    columns: [
      { name: "balance_transaction_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "type", type: "varchar" },
      { name: "gross_amount", type: "numeric" },
      { name: "fee_amount", type: "numeric" },
      { name: "net_amount", type: "numeric" },
      { name: "currency", type: "varchar" },
    ],
  },
  {
    name: "subscription",
    owner: "dba",
    columns: [
      { name: "subscription_id", type: "varchar" },
      { name: "customer_id", type: "varchar" },
      { name: "status", type: "varchar" },
      { name: "current_period_start", type: "timestamp" },
      { name: "current_period_end", type: "timestamp" },
      { name: "amount", type: "numeric" },
      { name: "currency", type: "varchar" },
      { name: "interval", type: "varchar" },
    ],
  },
  {
    name: "contact",
    owner: "dba",
    columns: [
      { name: "contact_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "first_name", type: "varchar" },
      { name: "last_name", type: "varchar" },
      { name: "email", type: "varchar" },
      { name: "company_id", type: "varchar" },
      { name: "lifecycle_stage", type: "varchar" },
    ],
  },
  {
    name: "company",
    owner: "dba",
    columns: [
      { name: "company_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "name", type: "varchar" },
      { name: "domain", type: "varchar" },
    ],
  },
  {
    name: "deal",
    owner: "dba",
    columns: [
      { name: "deal_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "closed_at", type: "timestamp" },
      { name: "company_id", type: "varchar" },
      { name: "name", type: "varchar" },
      { name: "stage", type: "varchar" },
      { name: "amount", type: "numeric" },
      { name: "currency", type: "varchar" },
    ],
  },
  {
    name: "ticket",
    owner: "dba",
    columns: [
      { name: "ticket_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "closed_at", type: "timestamp" },
      { name: "contact_id", type: "varchar" },
      { name: "subject", type: "varchar" },
      { name: "status", type: "varchar" },
      { name: "priority", type: "varchar" },
    ],
  },
  {
    name: "order",
    owner: "dba",
    columns: [
      { name: "order_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "customer_id", type: "varchar" },
      { name: "total_amount", type: "numeric" },
      { name: "subtotal_amount", type: "numeric" },
      { name: "tax_amount", type: "numeric" },
      { name: "refunded_amount", type: "numeric" },
      { name: "currency", type: "varchar" },
      { name: "financial_status", type: "varchar" },
      { name: "fulfillment_status", type: "varchar" },
    ],
  },
  {
    name: "product",
    owner: "dba",
    columns: [
      { name: "product_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "title", type: "varchar" },
      { name: "sku", type: "varchar" },
      { name: "price_amount", type: "numeric" },
      { name: "currency", type: "varchar" },
      { name: "inventory_quantity", type: "integer" },
      { name: "status", type: "varchar" },
    ],
  },
  {
    name: "customer",
    owner: "dba",
    columns: [
      { name: "customer_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "first_name", type: "varchar" },
      { name: "last_name", type: "varchar" },
      { name: "email", type: "varchar" },
      { name: "orders_count", type: "integer" },
      { name: "total_spent_amount", type: "numeric" },
      { name: "currency", type: "varchar" },
    ],
  },
  {
    name: "campaign",
    owner: "dba",
    columns: [
      { name: "campaign_id", type: "varchar" },
      { name: "sent_at", type: "timestamp" },
      { name: "audience_id", type: "varchar" },
      { name: "subject", type: "varchar" },
      { name: "status", type: "varchar" },
      { name: "emails_sent", type: "integer" },
      { name: "opens_unique", type: "integer" },
      { name: "clicks_unique", type: "integer" },
    ],
  },
  {
    name: "audience",
    owner: "dba",
    columns: [
      { name: "audience_id", type: "varchar" },
      { name: "created_at", type: "timestamp" },
      { name: "name", type: "varchar" },
      { name: "member_count", type: "integer" },
      { name: "unsubscribe_count", type: "integer" },
    ],
  },
  // WARP-2466 — the three shapes the HubSpot/Mailchimp reconciliation added.
  {
    name: "engagement",
    owner: "dba",
    columns: [
      { name: "engagement_id", type: "varchar" },
      { name: "occurred_at", type: "timestamp" },
      { name: "type", type: "varchar" },
      { name: "contact_id", type: "varchar" },
      { name: "deal_id", type: "varchar" },
    ],
  },
  {
    name: "audience_member",
    owner: "dba",
    columns: [
      { name: "audience_member_id", type: "varchar" },
      { name: "audience_id", type: "varchar" },
      { name: "email", type: "varchar" },
      { name: "subscription_status", type: "varchar" },
      { name: "opted_in_at", type: "timestamp" },
      { name: "last_changed_at", type: "timestamp" },
    ],
  },
  {
    name: "ecommerce_order",
    owner: "dba",
    columns: [
      { name: "ecommerce_order_id", type: "varchar" },
      { name: "store_id", type: "varchar" },
      { name: "customer_id", type: "varchar" },
      { name: "total_amount", type: "numeric" },
      { name: "currency", type: "varchar" },
      { name: "processed_at", type: "timestamp" },
    ],
  },
];

const map = buildSchemaMap(TABLES);

describe("read-query registry", () => {
  it("registers the read queries", () => {
    const names = READ_QUERIES.map((q) => q.name).sort();
    expect(names).toEqual(
      [
        "get_ar_summary",
        "get_schedule_today",
        "find_patient",
        "get_patient",
        "get_recall_due",
        // WARP-2107 — accounting
        "get_open_invoices",
        "get_open_bills",
        "get_ap_summary",
        // WARP-2280 — SaaS
        "get_recent_charges",
        "get_refunds",
        "get_payouts",
        "get_processing_fees",
        "get_subscriptions_by_status",
        "find_contact",
        "get_company",
        "get_deals_by_stage",
        "get_tickets_by_status",
        "get_recent_orders",
        "get_low_stock_products",
        "find_customer",
        "get_campaign_performance",
        "get_audiences",
        "get_engagements",
        "get_audience_members",
        "get_ecommerce_orders",
      ].sort(),
    );
  });

  it("every registered query is parameterized and read-only (SELECT ...)", () => {
    for (const q of READ_QUERIES) {
      const { sql } = buildReadStatement(map, q.name, q.exampleParams);
      expect(sql.trimStart().slice(0, 6).toUpperCase()).toBe("SELECT");
      // No mutating verbs ever appear in a read statement.
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|MERGE|CREATE)\b/i);
    }
  });

  it("binds values as ? parameters (never concatenated)", () => {
    const { sql, params } = buildReadStatement(map, "get_schedule_today", {
      from: "2026-07-07T00:00:00Z",
      to: "2026-07-08T00:00:00Z",
    });
    expect(sql).toContain("?");
    // The date literals must be in params, not spliced into the SQL text.
    expect(sql).not.toContain("2026-07-07");
    expect(params).toEqual(["2026-07-07T00:00:00Z", "2026-07-08T00:00:00Z"]);
  });

  it("resolves table/column identifiers through the schema map", () => {
    const { sql } = buildReadStatement(map, "get_schedule_today", {
      from: "a",
      to: "b",
    });
    expect(sql).toContain('"dba"."appointment"');
    expect(sql).toContain('"appt_time"');
  });

  it("find_patient binds the search term (as a prefix) and selects from patient", () => {
    const { sql, params } = buildReadStatement(map, "find_patient", { query: "smith" });
    expect(sql).toContain('"dba"."patient"');
    // Prefix match: the `%` is appended in Node, the value still binds as `?`.
    expect(params).toEqual(["smith%"]);
    expect(sql).not.toContain("smith");
  });

  it("find_patient escapes LIKE metacharacters so '%'/'_' can't wildcard-scan", () => {
    const { sql, params } = buildReadStatement(map, "find_patient", { query: "%_x" });
    expect(sql).toContain("ESCAPE");
    // %, _ and \ escaped with a backslash; the trailing % (prefix match) stays literal.
    expect(params).toEqual(["\\%\\_x%"]);
    // A bare "%" no longer binds as a match-everything wildcard.
    const wild = buildReadStatement(map, "find_patient", { query: "%" });
    expect(wild.params).toEqual(["\\%%"]);
  });

  it("scheduleDayBounds expands a YYYY-MM-DD into half-open UTC bounds", () => {
    expect(scheduleDayBounds("2026-07-07")).toEqual({
      from: "2026-07-07T00:00:00.000Z",
      to: "2026-07-08T00:00:00.000Z",
    });
    expect(() => scheduleDayBounds("not-a-date")).toThrow(RangeError);
  });

  it("rejects an unknown query name (LLM can only name registered queries)", () => {
    expect(() => getReadQuery("run_arbitrary_sql")).toThrow(UnknownReadQueryError);
    expect(() => buildReadStatement(map, "run_arbitrary_sql", {})).toThrow(
      UnknownReadQueryError,
    );
  });

  it("fails safe when the schema map is missing a depended-on table", () => {
    const partial = buildSchemaMap([TABLES[1]]); // only patient
    expect(() => buildReadStatement(partial, "get_schedule_today", { from: "a", to: "b" })).toThrow(
      SchemaResolutionError,
    );
  });
});
