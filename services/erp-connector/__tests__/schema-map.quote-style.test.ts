/**
 * WARP-2011 — per-engine identifier delimiters.
 *
 * ANSI double quotes are not universal. On MySQL/MariaDB in the default
 * `sql_mode`, `"x"` is a string LITERAL: a map that emits ANSI quotes there
 * produces a statement that compares a constant instead of reading a column.
 * SQL Server accepts `[x]`.
 *
 * MUTATION (mandatory): hardcode `quote()` back to `"…"` — the backtick and
 * bracket expectations below must go red.
 */
import { describe, it, expect } from "vitest";
import {
  buildSchemaMap,
  resolveColumn,
  resolveTable,
  type IntrospectedTable,
} from "../src/schema-map.js";

const TABLES: IntrospectedTable[] = [
  {
    name: "db",
    owner: "owner",
    columns: [{ name: "col", type: "varchar" }],
  },
];

describe("quoteStyle", () => {
  it("defaults to ANSI double quotes", () => {
    const map = buildSchemaMap(TABLES);
    expect(map.quoteStyle).toBe("ansi");
    expect(resolveTable(map, "db")).toBe('"owner"."db"');
    expect(resolveColumn(map, "db", "col")).toBe('"col"');
  });

  it('emits `owner`.`db` for backtick engines', () => {
    const map = buildSchemaMap(TABLES, { quoteStyle: "backtick" });
    expect(resolveTable(map, "db")).toBe("`owner`.`db`");
    expect(resolveColumn(map, "db", "col")).toBe("`col`");
  });

  it("emits [owner].[db] for bracket engines", () => {
    const map = buildSchemaMap(TABLES, { quoteStyle: "bracket" });
    expect(resolveTable(map, "db")).toBe("[owner].[db]");
    expect(resolveColumn(map, "db", "col")).toBe("[col]");
  });
});

describe("delimiter escaping", () => {
  /** An identifier carrying each engine's own delimiter character. */
  const HOSTILE: IntrospectedTable[] = [
    {
      name: 'we"ird',
      owner: "own`er",
      columns: [{ name: "br]acket", type: "varchar" }],
    },
  ];

  it("doubles an embedded ANSI quote rather than stripping it", () => {
    const map = buildSchemaMap(HOSTILE, { identifierCase: "preserve" });
    // Stripping would silently name a DIFFERENT object; doubling is the only
    // rendering that round-trips.
    expect(resolveTable(map, 'we"ird')).toBe('"own`er"."we""ird"');
    expect(resolveTable(map, 'we"ird')).toContain('""');
  });

  it("doubles an embedded backtick rather than stripping it", () => {
    const map = buildSchemaMap(HOSTILE, {
      identifierCase: "preserve",
      quoteStyle: "backtick",
    });
    expect(resolveTable(map, 'we"ird')).toBe("`own``er`.`we\"ird`");
    expect(resolveTable(map, 'we"ird')).toContain("``");
  });

  it("doubles an embedded closing bracket rather than stripping it", () => {
    const map = buildSchemaMap(HOSTILE, {
      identifierCase: "preserve",
      quoteStyle: "bracket",
    });
    expect(resolveColumn(map, 'we"ird', "br]acket")).toBe("[br]]acket]");
  });

  it("never drops a delimiter character from the identifier", () => {
    for (const style of ["ansi", "backtick", "bracket"] as const) {
      const map = buildSchemaMap(HOSTILE, { identifierCase: "preserve", quoteStyle: style });
      const rendered = resolveColumn(map, 'we"ird', "br]acket");
      // "br]acket" has 8 characters; whatever the delimiter, all 8 survive.
      expect(rendered.replace(/]]/g, "]")).toContain("br]acket");
    }
  });
});
