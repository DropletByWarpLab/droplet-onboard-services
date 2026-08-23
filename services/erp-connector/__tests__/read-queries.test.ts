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
