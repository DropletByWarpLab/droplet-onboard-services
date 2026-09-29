/**
 * Schema + migration assertions for per-user folder colours.
 *
 * Vitest mocks `@prisma/client` (see ./setup.ts), so the contracts live in the
 * migration SQL + schema.prisma: re-run-safe idioms, `color` an explicit enum
 * column (no "absence means X" derivation), unique on (userId, ncFileId), and
 * the schema enum / migration enum / route palette agreeing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");
const SCHEMA = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");
const ROUTE = readFileSync(join(__dirname, "../routes/files.ts"), "utf8");

const dir = readdirSync(MIGRATIONS_DIR).find((d) => d.endsWith("_files_folder_color"));
const SQL = dir ? readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8") : "";

const COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

describe("FileFolderColor migration", () => {
  it("ships a migration directory", () => {
    expect(dir).toBeTruthy();
  });

  it("creates the enum via the duplicate_object idiom, and the table/indexes IF NOT EXISTS", () => {
    expect(
      /DO \$\$ BEGIN[\s\S]*?CREATE TYPE "FolderColor"[\s\S]*?WHEN duplicate_object THEN null;[\s\S]*?END \$\$;/.test(SQL),
    ).toBe(true);
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS "FileFolderColor"/);
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "FileFolderColor_userId_ncFileId_key"/);
  });

  it("types color as the enum, not text", () => {
    expect(SQL).toMatch(/"color"\s+"FolderColor" NOT NULL/);
  });

  it("enum members agree across migration, schema and route", () => {
    const list = COLORS.map((c) => `'${c}'`).join(", ");
    expect(SQL).toContain(`AS ENUM (${list})`);
    const block = SCHEMA.match(/enum FolderColor \{([\s\S]*?)\}/)?.[1] ?? "";
    expect(block.split(/\s+/).filter(Boolean)).toEqual(COLORS);
    const routeList = ROUTE.match(/FOLDER_COLOR_VALUES = \[([\s\S]*?)\] as const/)?.[1] ?? "";
    expect([...routeList.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual(COLORS);
  });
});

describe("FileFolderColor model", () => {
  const model = SCHEMA.match(/model FileFolderColor \{([\s\S]*?)\n\}/)?.[1] ?? "";

  it("is keyed on (userId, ncFileId) with color as an explicit enum", () => {
    expect(model).toMatch(/color\s+FolderColor/);
    expect(model).toMatch(/@@unique\(\[userId, ncFileId\]\)/);
  });
});
