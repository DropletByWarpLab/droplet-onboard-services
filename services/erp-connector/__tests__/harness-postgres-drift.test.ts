/**
 * Keeps the Postgres dry-setup harness (`harness/`) honest against the code it
 * stands in for.
 *
 * That harness is the SQL track's only runnable target today — the direct-SQL
 * connector is entirely stubbed (no SAP client, no driver), so nothing executes
 * its statements automatically. `smoke.sql` is therefore SQL a human copied out
 * of `read-queries.ts` / `write-commands.ts` by hand, and the mock schema is a
 * hand-written stand-in for PattersonPM. Both drift silently: add a column to a
 * read query and the harness keeps passing while testing the old shape, which
 * is worse than not testing it, because it reads as coverage.
 *
 * So this suite closes the loop without needing Docker or a database:
 *
 *   1. It PARSES the mock schema out of `harness/init/01-schema.sql` and builds
 *      every registered read query and write command against it. A query that
 *      starts touching a column the mock lacks fails here, at unit-test speed.
 *   2. It checks the statements `smoke.sql` runs still match what the
 *      registries generate.
 *   3. It checks the mock's least-privilege grants still match the write
 *      command's declared `allowedColumns`, and that no forbidden table was
 *      handed a write grant.
 *
 * This does NOT execute SQL — running the harness is still
 * `harness/dry-run.sh` against the Postgres container. It proves the harness is
 * testing the CURRENT code, which is the part that was silently rotting.
 */
import { describe, expect, it } from "vitest";
import { buildSchemaMap, type IntrospectedTable } from "../src/schema-map.js";
import { READ_QUERIES } from "../src/read-queries.js";
import { FORBIDDEN_WRITE_TABLES, WRITE_COMMANDS } from "../src/write-commands.js";
import { readPackageFile } from "./helpers/test-paths.js";

// Anchored to this test file, not the runner's cwd, through the one helper
// this package's roots live in (WARP-2654).
const read = (p: string) => readPackageFile("harness", p);

const SCHEMA_SQL = read("init/01-schema.sql");
const PROVISION_SQL = read("init/03-provision.sql");
const SMOKE_SQL = read("smoke.sql");

/** Collapse whitespace so a statement split across lines in a .sql file
 *  compares equal to the single-line string the registry builds. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();
const FLAT_SMOKE = flat(SMOKE_SQL);

/**
 * Parse `CREATE TABLE <owner>.<name> ( ... );` blocks into the introspected
 * shape the connector's schema map is built from. Deliberately simple: it only
 * has to understand the harness's own DDL, which we control.
 */
function parseMockSchema(sql: string): IntrospectedTable[] {
  const tables: IntrospectedTable[] = [];
  // Identifiers may be double-quoted: WARP-2280 added the `order` dataset, and
  // `CREATE TABLE dba.order` is a syntax error in Postgres because `order` is
  // reserved. The connector never has this problem — `resolveTable` quotes
  // every identifier it emits — but the harness DDL is hand-written, so the
  // parser has to read what valid DDL actually looks like. Without the optional
  // quotes here the table is silently missing from the mock map and every read
  // against it fails as "drift" that is really a parser gap.
  const tableRe = /CREATE TABLE\s+"?(\w+)"?\."?(\w+)"?\s*\(([\s\S]*?)\n\);/g;

  for (const [, owner, name, body] of sql.matchAll(tableRe)) {
    const columns = body
      .split("\n")
      .map((line) => line.replace(/--.*$/, "").trim())
      .filter(Boolean)
      // Skip table-level constraints; only column definitions start with a
      // bare identifier followed by a type.
      .filter((line) => !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 2 && /^\w+$/.test(parts[0]))
      .map(([colName, type]) => ({ name: colName, type: type.replace(/[(,].*$/, "") }));
    tables.push({ name, owner, columns });
  }
  return tables;
}

const MOCK_TABLES = parseMockSchema(SCHEMA_SQL);
const MOCK_MAP = buildSchemaMap(MOCK_TABLES);

describe("harness DDL parses into a usable schema map", () => {
  it("finds the tables the connector depends on", () => {
    const names = MOCK_TABLES.map((t) => t.name).sort();
    expect(names).toContain("appointment");
    expect(names).toContain("patient");
    expect(names).toContain("account");
    expect(MOCK_TABLES.every((t) => t.owner === "dba")).toBe(true);
  });

  it("reads the appointment columns, including the watermark", () => {
    const appt = MOCK_TABLES.find((t) => t.name === "appointment")!;
    expect(appt.columns.map((c) => c.name)).toEqual([
      "appt_id", "patient_id", "provider_id", "operatory_id",
      "appt_time", "status", "reason", "last_modified",
    ]);
  });
});

describe("every registered statement still builds against the mock schema", () => {
  it.each(READ_QUERIES.map((q) => [q.name, q] as const))(
    "read query %s resolves every identifier it needs",
    (_name, query) => {
      // A read query that grew a column the mock lacks throws
      // SchemaResolutionError here — the drift signal, caught without a DB.
      expect(() => query.build(MOCK_MAP, query.exampleParams)).not.toThrow();
    },
  );

  it.each(READ_QUERIES.map((q) => [q.name, q] as const))(
    "read query %s only depends on tables the mock actually has",
    (_name, query) => {
      for (const table of query.dependsOnTables) {
        expect(MOCK_TABLES.map((t) => t.name)).toContain(table);
      }
    },
  );

  it.each(WRITE_COMMANDS.map((c) => [c.name, c] as const))(
    "write command %s builds its UPDATE and its verify query",
    (_name, cmd) => {
      const params: Record<string, unknown> = {};
      for (const p of cmd.requiredParams) params[p] = "x";
      for (const col of cmd.allowedColumns) params[col] = "x";
      expect(() => cmd.buildStatement(MOCK_MAP, params)).not.toThrow();
      expect(() => cmd.verifyQuery(MOCK_MAP, params)).not.toThrow();
    },
  );
});

describe("smoke.sql still runs the SQL the registries generate", () => {
  /** The drift-sensitive half of a statement: the projected columns and the
   *  table. `smoke.sql` binds literals where the registry emits `?`, so the
   *  clauses after them can't be compared verbatim — but a renamed, added, or
   *  dropped column changes THIS prefix, which is the failure being guarded. */
  function selectPrefix(sql: string): string {
    const m = sql.match(/^SELECT .*? FROM "\w+"\."\w+"/);
    if (!m) throw new Error(`not a SELECT with a resolvable FROM: ${sql}`);
    return m[0];
  }

  it.each(
    READ_QUERIES
      // get_patient and get_recall_due project the same columns as
      // find_patient, so smoke.sql covers their shape through it.
      .filter((q) => ["get_schedule_today", "find_patient", "get_ar_summary"].includes(q.name))
      .map((q) => [q.name, q] as const),
  )("smoke.sql projects %s's current column list", (_name, query) => {
    const prefix = selectPrefix(query.build(MOCK_MAP, query.exampleParams).sql);
    expect(
      FLAT_SMOKE,
      `smoke.sql is stale: it no longer contains ${query.name}'s generated projection\n  ${prefix}`,
    ).toContain(prefix);
  });

  it("smoke.sql updates the same table and columns the write command does", () => {
    const cmd = WRITE_COMMANDS.find((c) => c.name === "reschedule_appointment")!;
    const built = cmd.buildStatement(MOCK_MAP, {
      appt_id: 1, last_modified: "x", appt_time: "t", status: "s",
    });
    expect(built.sql).toContain('UPDATE "dba"."appointment"');
    expect(FLAT_SMOKE).toContain('UPDATE "dba"."appointment"');
    // The optimistic guard is the whole point of the write — smoke.sql must
    // still exercise both guard columns.
    expect(FLAT_SMOKE).toContain('"appt_id" = 5002 AND "last_modified" =');
  });
});

describe("the mock's least-privilege grants track the write registry", () => {
  it("grants UPDATE on exactly the command's allowedColumns — no more, no less", () => {
    const cmd = WRITE_COMMANDS.find((c) => c.name === "reschedule_appointment")!;
    const grant = PROVISION_SQL.match(/GRANT UPDATE\s*\(([^)]*)\)/);
    expect(grant, "no column-scoped GRANT UPDATE found in 03-provision.sql").not.toBeNull();

    const granted = grant![1].split(",").map((c) => c.trim()).sort();
    // Over-granting means the mock would accept a write the real box refuses;
    // under-granting means the harness fails for a reason production wouldn't.
    expect(granted).toEqual([...cmd.allowedColumns].sort());
  });

  it("never grants a write on a forbidden financial/clinical table", () => {
    const writeGrants = [...PROVISION_SQL.matchAll(/GRANT\s+(UPDATE|INSERT|DELETE)[^;]*?ON\s+dba\.(\w+)/gi)];
    expect(writeGrants.length).toBeGreaterThan(0); // the regex must actually match something
    for (const [, verb, table] of writeGrants) {
      expect(
        FORBIDDEN_WRITE_TABLES,
        `03-provision.sql grants ${verb} on forbidden table dba.${table}`,
      ).not.toContain(table.toLowerCase());
    }
  });

  it("keeps droplet_ro free of any write grant", () => {
    // Everything after the droplet_rw role is created belongs to the writer.
    const roSection = PROVISION_SQL.split(/CREATE ROLE droplet_rw/)[0];
    expect(roSection).not.toMatch(/GRANT\s+(UPDATE|INSERT|DELETE)/i);
  });
});
