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
import type { SchemaMap } from "../src/schema-map.js";

const MANIFEST_URL = new URL(
  "../../erp-sql-bridge/statement_manifest.json",
  import.meta.url,
);

const ID = "<id>";

/**
 * Mirror of `allowlist.normalize_statement` (services/erp-sql-bridge): mask
 * every double-quoted identifier (a doubled quote stays inside one
 * identifier) to `<id>`, collapse whitespace runs, refuse (null) an
 * unterminated identifier or a raw `<id>` marker. The mirror-vector tests
 * below keep the two implementations honest with each other.
 */
function normalizeStatement(sql: string): string | null {
  if (sql.includes(ID)) return null;
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql.charAt(i);
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql.charAt(j) === '"') {
          if (j + 1 < n && sql.charAt(j + 1) === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      if (j >= n) return null;
      out += ID;
      i = j + 1;
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

const HINT =
  "statement_manifest.json is out of sync with the registries. Replace the " +
  "reads/writes sections of services/erp-sql-bridge/statement_manifest.json with:\n" +
  JSON.stringify({ reads: expectedReads, writes: expectedWrites }, null, 2);

describe("bridge statement manifest stays in sync with the registries", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as {
    reads: Record<string, string[]>;
    writes: Record<string, string[]>;
  };

  it("registers exactly the read statements the registry emits", () => {
    expect(manifest.reads, HINT).toEqual(expectedReads);
  });

  it("registers exactly the write statements the registry emits", () => {
    expect(manifest.writes, HINT).toEqual(expectedWrites);
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
  it("masks every quoted identifier", () => {
    expect(normalizeStatement('SELECT "a" FROM "dba"."patient" WHERE "b" = ?')).toBe(
      "SELECT <id> FROM <id>.<id> WHERE <id> = ?",
    );
  });

  it("keeps a doubled quote inside one identifier", () => {
    expect(normalizeStatement('SELECT "a""b" FROM "dba"."t"')).toBe(
      "SELECT <id> FROM <id>.<id>",
    );
  });

  it("collapses whitespace runs", () => {
    expect(normalizeStatement('SELECT\n  "a"\t FROM   "dba"."t"')).toBe(
      "SELECT <id> FROM <id>.<id>",
    );
  });

  it("refuses an unterminated identifier", () => {
    expect(normalizeStatement('SELECT "unterminated FROM x')).toBeNull();
  });

  it("refuses a raw mask marker", () => {
    expect(normalizeStatement("SELECT <id> FROM <id>.<id>")).toBeNull();
  });
});
