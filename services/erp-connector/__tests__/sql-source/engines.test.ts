/**
 * WARP-2011 — the per-engine profile table.
 *
 * Two properties this pins:
 *
 *   1. Views ARE enumerated for the four non-SQL-Anywhere engines. The generic
 *      track's answer to "I need a join" is "create a VIEW and grant SELECT on
 *      it" — a catalog query filtering to base tables would make that answer
 *      impossible while looking like it worked.
 *   2. SQL Anywhere is byte-identical to the pre-WARP-2011 path, so routing an
 *      Eaglesoft connection through this table changes nothing.
 */
import { describe, it, expect } from "vitest";
import {
  ENGINE_PROFILES,
  SQL_ENGINES,
  engineProfile,
  isSqlEngine,
  type SqlEngine,
} from "../../src/sql-source/engines.js";
import { catalogQueriesFor } from "../../src/introspection.js";
import { PRODUCT_VERSION_SQL } from "../../src/version-detect.js";

const GENERIC_ENGINES: SqlEngine[] = ["postgres", "mysql", "mariadb", "sqlserver"];

describe("ENGINE_PROFILES coverage", () => {
  it("has a profile for every declared engine, keyed consistently", () => {
    for (const engine of SQL_ENGINES) {
      const profile = ENGINE_PROFILES[engine];
      expect(profile, engine).toBeDefined();
      expect(profile.engine).toBe(engine);
    }
    expect(Object.keys(ENGINE_PROFILES).sort()).toEqual([...SQL_ENGINES].sort());
  });

  it("narrows operator-supplied strings and refuses unknown engines", () => {
    expect(isSqlEngine("postgres")).toBe(true);
    expect(isSqlEngine("oracle")).toBe(false);
    expect(() => engineProfile("oracle" as SqlEngine)).toThrow(/unknown SQL engine/);
  });
});

describe("catalog queries enumerate views, not just base tables", () => {
  for (const engine of GENERIC_ENGINES) {
    it(`${engine} does not filter on table type`, () => {
      const { listTables } = ENGINE_PROFILES[engine].catalog;
      expect(listTables.toLowerCase()).not.toContain("table_type");
    });

    it(`${engine} honours the catalog contract (table_name + owner, bound ?)`, () => {
      const { listTables, listColumns } = ENGINE_PROFILES[engine].catalog;
      expect(listTables.toLowerCase()).toContain("table_name");
      expect(listTables.toLowerCase()).toContain("owner");
      expect(listColumns.toLowerCase()).toContain("column_name");
      expect(listColumns).toContain("?");
      // The table name binds; it is never concatenated into the catalog SQL.
      expect(listColumns.toLowerCase()).toMatch(/table_name\s*=\s*\?/);
    });
  }
});

describe("per-engine emission traits", () => {
  it("uses the delimiter each engine actually accepts", () => {
    expect(ENGINE_PROFILES.postgres.quoteStyle).toBe("ansi");
    expect(ENGINE_PROFILES.mysql.quoteStyle).toBe("backtick");
    expect(ENGINE_PROFILES.mariadb.quoteStyle).toBe("backtick");
    expect(ENGINE_PROFILES.sqlserver.quoteStyle).toBe("bracket");
    expect(ENGINE_PROFILES.sqlanywhere.quoteStyle).toBe("ansi");
  });

  it("preserves identifier case on every case-sensitive engine", () => {
    for (const engine of GENERIC_ENGINES) {
      expect(ENGINE_PROFILES[engine].identifierCase, engine).toBe("preserve");
    }
  });

  it("never emits an ANSI double quote in MySQL-family catalog SQL", () => {
    // In the default sql_mode a double quote there is a string literal.
    for (const engine of ["mysql", "mariadb"] as const) {
      const { listTables, listColumns } = ENGINE_PROFILES[engine].catalog;
      expect(listTables).not.toContain('"');
      expect(listColumns).not.toContain('"');
    }
  });

  it("pairs the right row-cap syntax with each engine", () => {
    expect(ENGINE_PROFILES.postgres.limitStyle).toBe("limit");
    expect(ENGINE_PROFILES.mysql.limitStyle).toBe("limit");
    expect(ENGINE_PROFILES.mariadb.limitStyle).toBe("limit");
    expect(ENGINE_PROFILES.sqlserver.limitStyle).toBe("top");
    expect(ENGINE_PROFILES.sqlanywhere.limitStyle).toBe("top");
  });

  it("carries each engine's real default port", () => {
    expect(ENGINE_PROFILES.postgres.defaultPort).toBe(5432);
    expect(ENGINE_PROFILES.mysql.defaultPort).toBe(3306);
    expect(ENGINE_PROFILES.mariadb.defaultPort).toBe(3306);
    expect(ENGINE_PROFILES.sqlserver.defaultPort).toBe(1433);
    expect(ENGINE_PROFILES.sqlanywhere.defaultPort).toBe(2638);
  });
});

describe("SQL Anywhere is unchanged", () => {
  it("reuses the shipped modern catalog queries verbatim", () => {
    expect(ENGINE_PROFILES.sqlanywhere.catalog).toEqual(catalogQueriesFor("modern"));
  });

  it("keeps the historical fold-lower behaviour and version probe", () => {
    expect(ENGINE_PROFILES.sqlanywhere.identifierCase).toBe("fold-lower");
    expect(ENGINE_PROFILES.sqlanywhere.versionSql).toBe(PRODUCT_VERSION_SQL);
    expect(ENGINE_PROFILES.sqlanywhere.defaultOwner).toBe("dba");
  });
});
