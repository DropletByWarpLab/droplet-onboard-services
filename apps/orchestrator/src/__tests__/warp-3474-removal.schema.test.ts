/**
 * WARP-3474 — the Security command center and doors modules are maintained
 * outside this repository (enterprise-functionality). This pins the database
 * half of that removal in the DB-less lane every PR runs: the schema no longer
 * declares them, and the one forward migration that cleans a box which already
 * ran them keeps the shape that makes it safe to run on any database.
 *
 * What it cannot see (what the cleanup does to rows, to a trigger, to a CHECK)
 * was proven against a real Postgres when the migration was written; the
 * migration is shipped, so what is pinned here is its text.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

const schema = readSchema().replace(/\r\n/g, "\n");

const FORWARD_SUFFIX = "_warp_3474_remove_security_doors_modules";

function forwardFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(FORWARD_SUFFIX));
}

function forwardPath(): string {
  const folders = forwardFolders();
  if (folders.length !== 1) throw new Error(`expected exactly one *${FORWARD_SUFFIX} folder, found ${folders.length}`);
  return join(MIGRATIONS_DIR, folders[0]!, "migration.sql");
}

/** The statements alone: the header may SAY things the code must not do. */
function statements(): string {
  return readFileSync(forwardPath(), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

function block(kind: "model" | "enum", name: string): string {
  const match = schema.match(new RegExp(`\\n${kind}\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`${kind} ${name} not found in schema.prisma`);
  return match[1]!;
}

/** The value lines of an enum, in order (doc comments dropped). */
function enumValues(name: string): string[] {
  return block("enum", name)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));
}

/** Every `model X {` / `enum X {` name the schema declares. */
function declaredNames(): string[] {
  return [...schema.matchAll(/^(?:model|enum)\s+(\w+)\s*\{/gm)].map((m) => m[1]!);
}

function droppedTables(sql: string): string[] {
  return [...sql.matchAll(/DROP TABLE IF EXISTS "(\w+)" CASCADE;/g)].map((m) => m[1]!);
}

function droppedTypes(sql: string): string[] {
  return [...sql.matchAll(/DROP TYPE IF EXISTS\s+([^;]+);/g)].flatMap((m) =>
    [...m[1]!.matchAll(/"(\w+)"/g)].map((n) => n[1]!),
  );
}

describe("WARP-3474 schema: the removed modules are gone", () => {
  it("declares no Security* model or enum, no AccessPoint / AccessEvent, and none of the door enums", () => {
    const removed =
      /^(?:Security[A-Z]\w*|AccessPoint|AccessPointStatus|AccessEvent|AccessEventKind|AccessForcedClaim|AccessTroubleCode|DoorPositionSource)$/;
    expect(declaredNames().filter((name) => removed.test(name))).toEqual([]);
  });

  it("ModuleId has neither the security nor the doors module", () => {
    const values = enumValues("ModuleId");
    expect(values).not.toContain("security");
    expect(values).not.toContain("doors");
    // …and nothing else was lost with them.
    expect(values).toEqual(expect.arrayContaining(["chat", "cameras", "smart_home", "network", "money"]));
  });

  it("DepartmentTemplate keeps its other six values, and the department models stay", () => {
    expect(enumValues("DepartmentTemplate")).toEqual(["sales", "finance", "operations", "front_desk", "it", "custom"]);
    expect(block("model", "Department")).toMatch(/profile\s+DepartmentProfile\?/);
    expect(block("model", "User")).toMatch(/activeDepartmentChoice\s+ActiveDepartmentChoice\?/);
  });

  it("User carries no back-relation to the removed alert-recipient table", () => {
    expect(block("model", "User")).not.toMatch(/securityAlertRecipient/);
  });
});

describe("WARP-3474 migration: the forward cleanup", () => {
  it("is exactly one folder, and its migration.sql is LF-only", () => {
    expect(forwardFolders()).toHaveLength(1);
    // Bytes, not text: .gitattributes pins migration.sql to eol=lf and the
    // *.schema.test.ts guards read the bytes. A CR here is a Windows checkout
    // that ignored the pin.
    expect(readFileSync(forwardPath()).includes(13)).toBe(false);
  });

  it("deletes the module rows with the enum compared as text, so it parses whether or not the enum has the labels", () => {
    const sql = statements();
    for (const table of ["ModuleSetting", "AccessRoleFeatureGrant", "UserAccessException"]) {
      expect(sql).toContain(`DELETE FROM "${table}" WHERE "moduleId"::text IN ('security', 'doors');`);
    }
    expect(sql).toContain(`DELETE FROM "AccessRoleToolGrant" WHERE "domain" IN ('security', 'doors');`);
    // A bare comparison would fail to parse on a database whose enum lacks the labels.
    expect(sql).not.toMatch(/"moduleId"\s+(?:=|IN)\s/);
  });

  it("rebuilds DepartmentTemplate only while the live type still has 'security', and keeps the departments", () => {
    const sql = statements();
    expect(sql).toMatch(/enumlabel = 'security'/);
    expect(sql).toMatch(
      /CREATE TYPE "DepartmentTemplate_new" AS ENUM \(\s*'sales', 'finance', 'operations', 'front_desk', 'it', 'custom'\s*\)/,
    );
    expect(sql).toMatch(/SET "template" = 'custom'\s+WHERE "template"::text = 'security'/);
    expect(sql).not.toMatch(/DELETE FROM "Department(?:Profile)?"/);
    expect(droppedTables(sql)).not.toContain("DepartmentProfile");
    expect(droppedTables(sql)).not.toContain("ActiveDepartmentChoice");
  });

  it("drops 26 tables, 4 functions and 46 enum types, every one IF EXISTS, tables first and types last", () => {
    const sql = statements();
    const tables = droppedTables(sql);
    const functions = [...sql.matchAll(/DROP FUNCTION IF EXISTS "(\w+)"\(/g)].map((m) => m[1]!);
    const types = droppedTypes(sql);
    expect(tables).toHaveLength(26);
    expect(functions).toHaveLength(4);
    expect(types).toHaveLength(46);
    expect(new Set(tables).size).toBe(26);
    expect(new Set(types).size).toBe(46);
    // The kept types are never named by a DROP … IF EXISTS.
    for (const kept of ["ModuleId", "DepartmentTemplate", "ActiveDepartmentScope", "NotificationAckMethod", "PushOutcome"]) {
      expect(types).not.toContain(kept);
    }
    // No DROP outside the guarded forms; the DO block's type swap is the one other.
    const unguarded = [...sql.matchAll(/\bDROP\s+(?:TABLE|TYPE|FUNCTION)\s+(?!IF EXISTS)[^;]*;/g)].map((m) => m[0]);
    expect(unguarded).toEqual(['DROP TYPE "DepartmentTemplate";']);
    // Tables, then the functions their triggers called, then the types their columns used.
    expect(sql.lastIndexOf("DROP TABLE IF EXISTS")).toBeLessThan(sql.indexOf("DROP FUNCTION IF EXISTS"));
    expect(sql.lastIndexOf("DROP FUNCTION IF EXISTS")).toBeLessThan(sql.indexOf("DROP TYPE IF EXISTS"));
  });

  it("drops nothing the schema still declares", () => {
    const sql = statements();
    const declared = new Set(declaredNames());
    expect([...droppedTables(sql), ...droppedTypes(sql)].filter((name) => declared.has(name))).toEqual([]);
  });
});
