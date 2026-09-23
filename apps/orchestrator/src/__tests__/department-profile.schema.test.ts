/**
 * WARP-2976 (ADR-059 P1) — schema pins for a department's dashboard
 * arrangement. The route tests exercise the behaviour; these pin the shape the
 * behaviour rests on, so a later edit that turns the template into free text,
 * lets a profile outlive its department, or seeds rows in a migration fails
 * here instead of on a box.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, SCHEMA_PATH } from "./helpers/test-paths.js";
import { DEPARTMENT_TEMPLATES } from "../routes/department-profile.routes.js";

const schema = readFileSync(SCHEMA_PATH, "utf-8");

function block(kind: "enum" | "model", name: string): string {
  const m = schema.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`));
  expect(m, `schema must declare ${kind} ${name}`).not.toBeNull();
  return m![0];
}

function migrationSql(): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.includes("warp_2976_department_profile"));
  expect(dirs.length, "must ship exactly one warp_2976_department_profile migration").toBe(1);
  return readFileSync(path.join(MIGRATIONS_DIR, dirs[0]!, "migration.sql"), "utf-8");
}

describe("WARP-2976 schema: DepartmentProfile", () => {
  it("DepartmentTemplate is an enum whose values are exactly the route's template list", () => {
    const values = block("enum", "DepartmentTemplate")
      .split("\n")
      .slice(1, -1)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));
    expect(values).toEqual([...DEPARTMENT_TEMPLATES]);
  });

  it("one profile per department, keyed by it, and it never outlives the department", () => {
    const model = block("model", "DepartmentProfile");
    expect(model).toMatch(/departmentId\s+String\s+@id/);
    expect(model).toMatch(/@relation\(fields: \[departmentId\], references: \[id\], onDelete: Cascade\)/);
    expect(model).toMatch(/template\s+DepartmentTemplate\b/);
    expect(model).toMatch(/navHrefs\s+String\[\]/);
    expect(model).toMatch(/homeWidgets\s+Json\b/);
  });

  it("Department exposes the optional back-relation (absent = not set up)", () => {
    expect(block("model", "Department")).toMatch(/profile\s+DepartmentProfile\?/);
  });

  it("the migration creates the enum and the table and seeds nothing", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/CREATE TYPE "DepartmentTemplate" AS ENUM/);
    expect(sql).toMatch(/CREATE TABLE "DepartmentProfile"/);
    expect(sql).toMatch(/REFERENCES "Department"\("id"\) ON DELETE CASCADE/);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
  });
});
