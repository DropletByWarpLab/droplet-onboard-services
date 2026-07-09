/**
 * WARP-1094 — schema fingerprint + identifier resolution (brief §9.2, §5 rule 3).
 *
 * `computeSchemaFingerprint` is a PURE function: a stable hash over
 * (table names + column names + types) for the tables we depend on. The
 * fingerprint is the drift guard (invariant 9) — an Eaglesoft upgrade that
 * changes a mapped column MUST change the hash so writes freeze.
 *
 * These are unit tests only. No database is touched (team rule: DB paths stay
 * stubbed, never faked-DB "integration" tested).
 */
import { describe, it, expect } from "vitest";
import {
  computeSchemaFingerprint,
  buildSchemaMap,
  resolveTable,
  resolveColumn,
  SchemaResolutionError,
  type IntrospectedTable,
} from "../src/schema-map.js";

/** Two tables in a deliberately non-sorted order to prove order-independence. */
const TABLES: IntrospectedTable[] = [
  {
    name: "appointment",
    owner: "dba",
    columns: [
      { name: "appt_id", type: "integer" },
      { name: "appt_time", type: "timestamp" },
      { name: "provider_id", type: "integer" },
    ],
  },
  {
    name: "patient",
    owner: "dba",
    columns: [
      { name: "patient_id", type: "integer" },
      { name: "last_name", type: "varchar" },
    ],
  },
];

describe("computeSchemaFingerprint", () => {
  it("is deterministic for the same schema", () => {
    expect(computeSchemaFingerprint(TABLES)).toBe(computeSchemaFingerprint(TABLES));
  });

  it("is a stable hex string (not the empty string)", () => {
    const fp = computeSchemaFingerprint(TABLES);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of table order and column order", () => {
    const reordered: IntrospectedTable[] = [
      {
        name: "patient",
        owner: "dba",
        columns: [
          { name: "last_name", type: "varchar" },
          { name: "patient_id", type: "integer" },
        ],
      },
      {
        name: "appointment",
        owner: "dba",
        columns: [
          { name: "provider_id", type: "integer" },
          { name: "appt_id", type: "integer" },
          { name: "appt_time", type: "timestamp" },
        ],
      },
    ];
    expect(computeSchemaFingerprint(reordered)).toBe(computeSchemaFingerprint(TABLES));
  });

  it("changes when a column is added (drift)", () => {
    const drifted = structuredClone(TABLES);
    drifted[0].columns.push({ name: "operatory_id", type: "integer" });
    expect(computeSchemaFingerprint(drifted)).not.toBe(computeSchemaFingerprint(TABLES));
  });

  it("changes when a column type changes (drift)", () => {
    const drifted = structuredClone(TABLES);
    drifted[0].columns[1].type = "date";
    expect(computeSchemaFingerprint(drifted)).not.toBe(computeSchemaFingerprint(TABLES));
  });

  it("changes when a table owner changes (drift)", () => {
    const drifted = structuredClone(TABLES);
    drifted[0].owner = "someoneelse";
    expect(computeSchemaFingerprint(drifted)).not.toBe(computeSchemaFingerprint(TABLES));
  });

  it("is case-insensitive on identifiers but sensitive to content", () => {
    // Eaglesoft identifiers are case-insensitive; normalizing avoids a
    // spurious drift-lock when introspection reports a different case.
    const upper = structuredClone(TABLES);
    upper[0].name = "APPOINTMENT";
    upper[0].columns[0].name = "APPT_ID";
    expect(computeSchemaFingerprint(upper)).toBe(computeSchemaFingerprint(TABLES));
  });
});

describe("schema-map identifier resolution (invariant 3)", () => {
  const map = buildSchemaMap(TABLES);

  it("resolves a known table to owner.table", () => {
    expect(resolveTable(map, "appointment")).toBe('"dba"."appointment"');
  });

  it("resolves a known column", () => {
    expect(resolveColumn(map, "appointment", "appt_time")).toBe('"appt_time"');
  });

  it("rejects an unknown table (never trust unmapped identifiers)", () => {
    expect(() => resolveTable(map, "ledger")).toThrow(SchemaResolutionError);
  });

  it("rejects an unknown column on a known table", () => {
    expect(() => resolveColumn(map, "appointment", "; DROP TABLE patient--")).toThrow(
      SchemaResolutionError,
    );
  });

  it("resolution is case-insensitive on the logical name", () => {
    expect(resolveColumn(map, "Appointment", "APPT_ID")).toBe('"appt_id"');
  });
});
