/**
 * WARP-2540 — the bridge's statement manifest is pinned to THESE registries.
 *
 * `services/erp-sql-bridge` no longer trusts the wire to carry registry-built
 * SQL: it ships `statement_manifest.json` — one normalized skeleton per
 * registered statement (per SET-width for writes) — and refuses anything that
 * does not match, fail-closed, before acquiring a connection. That is only
 * sound if the manifest and the registries agree, and THIS suite is the
 * agreement: it rebuilds every registered statement from the actual
 * registries, normalizes it exactly the way the bridge does
 * (`allowlist.normalize_statement`), and fails if the shipped manifest
 * differs in either direction.
 *
 * So: change `read-queries.ts` / `write-commands.ts`, watch this go red, and
 * copy the manifest it prints into
 * `services/erp-sql-bridge/statement_manifest.json`. A registry change that
 * forgets the manifest breaks CI here — not a practice's integration.
 *
 * This is deliberately not a second definition of the SQL (the "never build
 * SQL twice" rule): skeletons are derived FROM the registry output, prove
 * shape only, and nothing executes them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { READ_QUERIES } from "../src/read-queries.js";
import { WRITE_COMMANDS } from "../src/write-commands.js";
import {
  LEGACY_LIST_COLUMNS_SQL,
  LEGACY_LIST_TABLES_SQL,
  LIST_COLUMNS_SQL,
  LIST_TABLES_SQL,
} from "../src/introspection.js";
import type { SchemaMap } from "../src/schema-map.js";

const MANIFEST_URL = new URL(
  "../../erp-sql-bridge/statement_manifest.json",
  import.meta.url,
);

const ID = "<id>";

/** Index of the closing `"` of the identifier opening at `start`, or -1. */
function endOfIdentifier(sql: string, start: number): number {
  const n = sql.length;
  let j = start + 1;
  while (j < n) {
    if (sql.charAt(j) === '"') {
      if (j + 1 < n && sql.charAt(j + 1) === '"') {
        j += 2;
        continue;
      }
      return j;
    }
    j += 1;
  }
  return -1;
}

/**
 * Mirror of `allowlist.normalize_statement` (services/erp-sql-bridge): mask
 * every double-quoted identifier (a doubled quote stays inside one
 * identifier) to `<id>` — EXCEPT the table of a qualified `"owner"."table"`,
 * which is kept verbatim (WARP-2874, so a skeleton says which table the
 * statement reads) — collapse whitespace runs, refuse (null) an unterminated
 * identifier or a raw `<id>` marker. The mirror-vector tests below keep the
 * two implementations honest with each other.
 */
function normalizeStatement(sql: string): string | null {
  if (sql.includes(ID)) return null;
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql.charAt(i);
    if (ch === '"') {
      const j = endOfIdentifier(sql, i);
      if (j < 0) return null;
      i = j + 1;
      if (sql.slice(i, i + 2) === '."') {
        const k = endOfIdentifier(sql, i + 1);
        if (k < 0) return null;
        out += ID + sql.slice(i, k + 1); // `<id>."table"`
        i = k + 1;
      } else {
        out += ID;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out.trim().split(/\s+/).join(" ");
}

/**
 * Identity schema map: resolves every logical table to `"dba"."<table>"` and
 * every column to itself. The skeletons mask all identifiers anyway, so WHICH
 * physical names resolve is irrelevant — using a permissive map means adding
 * a query with a new logical table cannot silently drop it from this suite.
 */
const permissiveColumns = { get: (c: string) => c } as unknown as Map<string, string>;
const permissiveMap = {
  tables: {
    get: (t: string) => ({ owner: "dba", name: t, columns: permissiveColumns }),
  },
} as unknown as SchemaMap;

const expectedReads = Object.fromEntries(
  READ_QUERIES.map((q) => {
    const { sql } = q.build(permissiveMap, q.exampleParams);
    return [q.name, [normalizeStatement(sql)]];
  }),
);

const expectedWrites = Object.fromEntries(
  WRITE_COMMANDS.map((c) => {
    const skeletons: (string | null)[] = [];
    for (let width = 1; width <= c.allowedColumns.length; width += 1) {
      // Identity/guard params first, then `width` allowlisted columns. The
      // skeleton depends only on the COUNT of SET clauses (every clause masks
      // to `<id> = ?`), so this enumerates every shape the command can emit.
      const params: Record<string, unknown> = {};
      for (const p of c.requiredParams) params[p] = "guard-value";
      for (const col of c.allowedColumns.slice(0, width)) params[col] = "v";
      const { sql } = c.buildStatement(permissiveMap, params);
      skeletons.push(normalizeStatement(sql));
    }
    return [c.name, [...new Set(skeletons)]];
  }),
);

/**
 * WARP-2874 — the catalog statements `/introspect` may run. The bridge checks
 * them by shape with NO name (the caller labels each query, and a label is
 * data), so these keys are documentation; what the bridge matches is the set.
 * Both dialect families are registered because `catalogQueriesFor` picks one
 * at connect time from the detected engine version.
 */
const expectedIntrospect = {
  list_tables: [normalizeStatement(LIST_TABLES_SQL)],
  list_columns: [normalizeStatement(LIST_COLUMNS_SQL)],
  legacy_list_tables: [normalizeStatement(LEGACY_LIST_TABLES_SQL)],
  legacy_list_columns: [normalizeStatement(LEGACY_LIST_COLUMNS_SQL)],
};

const HINT =
  "statement_manifest.json is out of sync with the registries. Replace the " +
  "reads/writes/introspect sections of services/erp-sql-bridge/statement_manifest.json with:\n" +
  JSON.stringify(
    { reads: expectedReads, writes: expectedWrites, introspect: expectedIntrospect },
    null,
    2,
  );

describe("bridge statement manifest stays in sync with the registries", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as {
    reads: Record<string, string[]>;
    writes: Record<string, string[]>;
    introspect: Record<string, string[]>;
  };

  it("registers exactly the read statements the registry emits", () => {
    expect(manifest.reads, HINT).toEqual(expectedReads);
  });

  it("registers exactly the write statements the registry emits", () => {
    expect(manifest.writes, HINT).toEqual(expectedWrites);
  });

  it("registers exactly the catalog statements introspection emits", () => {
    // WARP-2874: `/introspect` used to run any SELECT the wire carried.
    expect(manifest.introspect, HINT).toEqual(expectedIntrospect);
  });

  it("binds every read and write skeleton to a table", () => {
    // WARP-2874: with the table masked too, `get_open_invoices` and
    // `get_open_bills` (and three other groups) normalized alike, so either
    // name admitted the other's SQL. A skeleton that carries `<id>.<id>` is
    // one the bridge cannot bind to a table.
    for (const [name, skeletons] of Object.entries({ ...expectedReads, ...expectedWrites })) {
      for (const s of skeletons) {
        expect(s, `${name} names no table`).toContain(`${ID}."`);
        expect(s, `${name} still masks its table`).not.toContain(`${ID}.${ID}`);
      }
    }
  });

  it("no two registered names share a shape", () => {
    // The property that makes the statement NAME mean anything on the wire.
    for (const table of [expectedReads, expectedWrites]) {
      const seen = new Map<string, string>();
      for (const [name, skeletons] of Object.entries(table)) {
        for (const s of skeletons) {
          expect(seen.get(s ?? ""), `${name} shares a shape with ${seen.get(s ?? "")}`).toBe(
            undefined,
          );
          seen.set(s ?? "", name);
        }
      }
    }
  });

  it("every registry statement normalizes cleanly", () => {
    // A registry statement the normalizer refuses would be un-runnable in
    // production — that is a registry bug, caught here.
    for (const skeletons of [...Object.values(expectedReads), ...Object.values(expectedWrites)]) {
      for (const s of skeletons) expect(s).not.toBeNull();
    }
  });
});

describe("normalizer mirror vectors (must match allowlist.normalize_statement)", () => {
  // The same vectors are asserted Python-side in
  // services/erp-sql-bridge/tests/test_allowlist.py — change one, change both.
  it("masks every identifier but the table", () => {
    expect(normalizeStatement('SELECT "a" FROM "dba"."patient" WHERE "b" = ?')).toBe(
      'SELECT <id> FROM <id>."patient" WHERE <id> = ?',
    );
  });

  it("keeps a doubled quote inside one identifier", () => {
    expect(normalizeStatement('SELECT "a""b" FROM "dba"."t"')).toBe('SELECT <id> FROM <id>."t"');
  });

  it("keeps a doubled quote inside one table name", () => {
    expect(normalizeStatement('SELECT "a" FROM "dba"."t""x"')).toBe(
      'SELECT <id> FROM <id>."t""x"',
    );
  });

  it("masks an unqualified identifier", () => {
    expect(normalizeStatement('SELECT "a" FROM "t"')).toBe("SELECT <id> FROM <id>");
  });

  it("collapses whitespace runs", () => {
    expect(normalizeStatement('SELECT\n  "a"\t FROM   "dba"."t"')).toBe(
      'SELECT <id> FROM <id>."t"',
    );
  });

  it("refuses an unterminated identifier", () => {
    expect(normalizeStatement('SELECT "unterminated FROM x')).toBeNull();
  });

  it("refuses a raw mask marker", () => {
    expect(normalizeStatement('SELECT <id> FROM <id>."t"')).toBeNull();
  });
});
