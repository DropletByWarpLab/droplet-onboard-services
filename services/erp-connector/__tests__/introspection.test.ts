/**
 * WARP-1094 — introspection catalog-query tests (brief §9.1; review B-4/B-5/C-5).
 *
 * Unit tests only; these are string CONSTANTS + a pure selector, no I/O. They
 * pin the dialect branching and the presence of the write-safety discovery
 * queries (triggers, foreign keys, watermark columns).
 */
import { describe, it, expect } from "vitest";
import {
  LIST_TABLES_SQL,
  LIST_COLUMNS_SQL,
  LEGACY_LIST_TABLES_SQL,
  LEGACY_LIST_COLUMNS_SQL,
  LIST_TRIGGERS_SQL,
  LIST_FOREIGN_KEYS_SQL,
  FIND_WATERMARK_COLUMNS_SQL,
  catalogQueriesFor,
} from "../src/introspection.js";

describe("catalogQueriesFor (review C-5)", () => {
  it("selects the modern SYS.SYSTAB* family for v10+ engines", () => {
    const q = catalogQueriesFor("modern");
    expect(q.listTables).toBe(LIST_TABLES_SQL);
    expect(q.listColumns).toBe(LIST_COLUMNS_SQL);
    expect(q.listTables).toContain("SYS.SYSTAB");
  });

  it("selects the legacy SYSTABLE/SYSCOLUMN family for ASA7", () => {
    const q = catalogQueriesFor("legacy");
    expect(q.listTables).toBe(LEGACY_LIST_TABLES_SQL);
    expect(q.listColumns).toBe(LEGACY_LIST_COLUMNS_SQL);
    expect(q.listTables).toContain("SYSTABLE");
    expect(q.listTables).not.toContain("SYS.SYSTAB ");
  });
});

describe("write-safety discovery queries (review B-4/B-5)", () => {
  it("discovers triggers on base tables", () => {
    expect(LIST_TRIGGERS_SQL).toContain("SYS.SYSTRIGGER");
  });

  it("discovers foreign-key relationships", () => {
    expect(LIST_FOREIGN_KEYS_SQL).toContain("SYS.SYSFKEY");
  });

  it("scans for DEFAULT TIMESTAMP watermark columns (research §3)", () => {
    expect(FIND_WATERMARK_COLUMNS_SQL).toContain("SYS.SYSTABCOL");
    expect(FIND_WATERMARK_COLUMNS_SQL).toContain("TIMESTAMP");
  });
});
