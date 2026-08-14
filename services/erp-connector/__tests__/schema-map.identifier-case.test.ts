/**
 * WARP-2011 — identifier-case fidelity in the schema map.
 *
 * The pre-existing suite passes over this bug because every fixture in it is
 * already lower-case. These fixtures are deliberately mixed-case, which is the
 * normal shape for an EF/.NET-generated schema: `Patients`, `FirstName`.
 *
 * The rule under test: the LOOKUP key is always case-insensitive, but the
 * PHYSICAL identifier that reaches the wire is preserved verbatim when the
 * engine is case-sensitive. Folding it there emits an identifier that does not
 * exist on PostgreSQL, on MySQL/MariaDB on Linux, or on SQL Server under a
 * case-sensitive collation.
 *
 * MUTATION (mandatory): revert `MappedTable` to storing `norm(name)` as the
 * physical identifier — the mixed-case expectations below must go red.
 */
import { describe, it, expect } from "vitest";
import {
  buildSchemaMap,
  computeSchemaFingerprint,
  resolveColumn,
  resolveTable,
  type IntrospectedTable,
} from "../src/schema-map.js";

/** As a case-sensitive catalog reports a quoted, mixed-case schema. */
const MIXED_CASE: IntrospectedTable[] = [
  {
    name: "Patients",
    owner: "Clinic",
    columns: [
      { name: "PatientId", type: "integer" },
      { name: "FirstName", type: "varchar" },
    ],
  },
];

/** The same schema as a case-insensitive catalog reports it. */
const LOWER_CASE: IntrospectedTable[] = [
  {
    name: "patients",
    owner: "clinic",
    columns: [
      { name: "patientid", type: "integer" },
      { name: "firstname", type: "varchar" },
    ],
  },
];

describe("identifierCase: preserve", () => {
  const map = buildSchemaMap(MIXED_CASE, { identifierCase: "preserve" });

  it("emits the physical identifier with its introspected case", () => {
    expect(resolveTable(map, "Patients")).toBe('"Clinic"."Patients"');
    expect(resolveColumn(map, "Patients", "FirstName")).toBe('"FirstName"');
  });

  it("still resolves case-insensitively — lookup and emission are separate", () => {
    expect(resolveTable(map, "patients")).toBe('"Clinic"."Patients"');
    expect(resolveTable(map, "PATIENTS")).toBe('"Clinic"."Patients"');
    expect(resolveColumn(map, "pAtIeNtS", "firstname")).toBe('"FirstName"');
  });

  it("records the mode it was built with", () => {
    expect(map.identifierCase).toBe("preserve");
    expect(map.quoteStyle).toBe("ansi");
  });
});

describe("identifierCase: fold-lower (the default)", () => {
  it("folds the physical identifier, exactly as before WARP-2011", () => {
    const map = buildSchemaMap(MIXED_CASE);
    expect(resolveTable(map, "Patients")).toBe('"clinic"."patients"');
    expect(resolveColumn(map, "Patients", "FirstName")).toBe('"firstname"');
  });

  it("is what an explicit fold-lower produces too", () => {
    const explicit = buildSchemaMap(MIXED_CASE, { identifierCase: "fold-lower" });
    const implicit = buildSchemaMap(MIXED_CASE);
    expect(resolveTable(explicit, "Patients")).toBe(resolveTable(implicit, "Patients"));
  });
});

describe("computeSchemaFingerprint is untouched by this change", () => {
  it("still normalizes, so case alone never trips the drift lock", () => {
    // If the fingerprint became case-sensitive, every existing live eaglesoft
    // connection would false-trip DRIFT_LOCKED on its next connect.
    expect(computeSchemaFingerprint(MIXED_CASE)).toBe(computeSchemaFingerprint(LOWER_CASE));
  });

  it("is byte-identical to the pre-change value for a fixed schema", () => {
    // Golden value captured from `main` before WARP-2011. A change here is a
    // production drift-lock incident, not a test to update.
    expect(computeSchemaFingerprint(LOWER_CASE)).toBe(
      "afff2b32b9d7c6c7b0eaf781769ae5a1ea77fa7c89ebb716cbf1eb4b77309a2a",
    );
  });

  it("does not depend on the map options", () => {
    // The options change emission only; nothing about them reaches the hash.
    buildSchemaMap(MIXED_CASE, { identifierCase: "preserve", quoteStyle: "backtick" });
    expect(computeSchemaFingerprint(MIXED_CASE)).toBe(computeSchemaFingerprint(LOWER_CASE));
  });
});

describe("owner-less engines", () => {
  it("emits an unqualified name when the catalog reports no owner", () => {
    // MySQL/MariaDB have no owner distinct from the database. `""."tbl"` would
    // name an object that cannot exist.
    const map = buildSchemaMap(
      [{ name: "Invoices", owner: "", columns: [{ name: "Id", type: "int" }] }],
      { identifierCase: "preserve", quoteStyle: "backtick" },
    );
    expect(resolveTable(map, "invoices")).toBe("`Invoices`");
  });
});
