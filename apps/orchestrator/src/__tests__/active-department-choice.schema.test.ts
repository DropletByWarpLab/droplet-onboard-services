/**
 * WARP-2981 (ADR-059 P6, DS-003) — schema pins for the department a person's
 * shell is arranged around, kept on the server.
 *
 * The route tests exercise the behaviour; these pin the shape it rests on, so
 * a later edit that adds a nullable "no department" column (the absence of a
 * row IS Whole business), lets a choice outlive its person or department,
 * seeds rows, or makes the migration unsafe to run twice fails here instead
 * of on a box.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, SCHEMA_PATH } from "./helpers/test-paths.js";

const schema = readFileSync(SCHEMA_PATH, "utf-8");

function model(name: string): string {
  const m = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
  expect(m, `schema must declare model ${name}`).not.toBeNull();
  return m![0];
}

/** The model's field lines, comments and block attributes dropped. */
function fieldLines(block: string): string[] {
  return block
    .split("\n")
    .slice(1, -1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"));
}

function migrationFolder(): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.endsWith("_warp_2981_active_department_choice"));
  expect(dirs.length, "must ship exactly one warp_2981_active_department_choice migration").toBe(1);
  return dirs[0]!;
}

function migrationSql(): string {
  return readFileSync(path.join(MIGRATIONS_DIR, migrationFolder(), "migration.sql"), "utf-8");
}

/** The SQL with `--` comments removed, so a word in the header cannot satisfy a pin. */
function migrationStatements(): string {
  return migrationSql()
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

describe("WARP-2981 schema: ActiveDepartmentChoice", () => {
  it("one row per person, keyed by them — a second row for the same person cannot exist", () => {
    expect(model("ActiveDepartmentChoice")).toMatch(/\buserId\s+String\s+@id\b/);
  });

  it("carries exactly userId, departmentId, updatedAt and the two relations — no state column, no nullable 'none'", () => {
    const names = fieldLines(model("ActiveDepartmentChoice")).map((l) => l.split(/\s+/)[0]);
    expect(names.sort()).toEqual(["department", "departmentId", "updatedAt", "user", "userId"]);
    // A chosen department is never optional: no row, not a null, is Whole business.
    expect(model("ActiveDepartmentChoice")).toMatch(/\bdepartmentId\s+String\s*$/m);
  });

  it("never outlives the person or the department (both FKs cascade)", () => {
    const block = model("ActiveDepartmentChoice");
    expect(block).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(block).toMatch(
      /department\s+Department\s+@relation\(fields: \[departmentId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(block).toMatch(/@@index\(\[departmentId\]\)/);
  });

  it("User and Department carry the back-relations (no columns)", () => {
    expect(model("User")).toMatch(/\bactiveDepartmentChoice\s+ActiveDepartmentChoice\?/);
    expect(model("Department")).toMatch(/\bactiveChoices\s+ActiveDepartmentChoice\[\]/);
  });

  it("is stamped 20260925040000 — after stage's newest and the stamps the open ADR-059 PRs reserved", () => {
    expect(migrationFolder()).toBe("20260925040000_warp_2981_active_department_choice");
  });

  it("the migration creates the table, its index and both cascading FKs, and seeds nothing", () => {
    const sql = migrationStatements();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "ActiveDepartmentChoice"/);
    expect(sql).toMatch(/CONSTRAINT "ActiveDepartmentChoice_pkey" PRIMARY KEY \("userId"\)/);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "ActiveDepartmentChoice_departmentId_idx" ON "ActiveDepartmentChoice"\("departmentId"\)/,
    );
    expect(sql).toMatch(
      /"ActiveDepartmentChoice_userId_fkey"\s+FOREIGN KEY \("userId"\) REFERENCES "User"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /"ActiveDepartmentChoice_departmentId_fkey"\s+FOREIGN KEY \("departmentId"\) REFERENCES "Department"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
  });

  it("is safe to run twice: the table and index use IF NOT EXISTS, each FK is duplicate_object-guarded", () => {
    const sql = migrationStatements();
    expect(sql).not.toMatch(/CREATE TABLE "ActiveDepartmentChoice"/);
    expect(sql).not.toMatch(/CREATE INDEX "ActiveDepartmentChoice/);
    const addConstraints = sql.match(/ADD CONSTRAINT/g) ?? [];
    const guards = sql.match(/WHEN duplicate_object THEN (NULL|null);/g) ?? [];
    expect(addConstraints).toHaveLength(2);
    expect(guards).toHaveLength(2);
  });
});
