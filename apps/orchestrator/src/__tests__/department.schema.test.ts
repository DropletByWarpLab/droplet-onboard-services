/**
 * WARP-1255 — Prisma schema regression for departments and teams.
 *
 * These tests run against the schema.prisma file text (no DB needed)
 * to lock the contract for what the generated client must expose:
 *
 *   - `Department` model: id, name (unique), slug (unique), kind, state,
 *     parentId (self-relation via "DeptHierarchy"), createdBy, createdAt.
 *   - `DepartmentKind` enum: HOUSEHOLD, DEPARTMENT, TEAM.
 *   - `ProvisionState` enum: pending, provisioning, active, failed, archiving, archived.
 *   - `NcSyncState` enum: pending, synced, failed, removing.
 *   - `DepartmentRight` enum: reader, contributor, manager.
 *   - `DepartmentMembership` model: (departmentId, userId) unique, right.
 *   - `UserInviteDepartment` model: (inviteId, departmentId) unique, right.
 *   - `UserUsagePolicy` model: userId (PK, FK User), storageQuotaBytes?, quotaSyncState.
 *   - `File` model gains departmentId column with index.
 *
 * Per WARP-1255: all state is explicit enums (no IS-NULL-derived); all user FKs
 * are local User.id UUID; parentId creates one-level nesting (TEAM → DEPARTMENT parent).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, SCHEMA_PATH } from "./helpers/test-paths.js";


function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

function readMigrationSql(): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) =>
    d.includes("warp_1255_departments"),
  );
  expect(
    dirs.length,
    "must ship a `warp_1255_departments` migration directory",
  ).toBe(1);
  return readFileSync(
    path.join(MIGRATIONS_DIR, dirs[0]!, "migration.sql"),
    "utf-8",
  );
}

describe("WARP-1255 schema: departments and teams", () => {
  it("declares DepartmentRight enum with reader, contributor, manager", () => {
    const schema = readSchema();
    const enumBlock = schema.match(
      /enum DepartmentRight \{[\s\S]*?\n\}/,
    );
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![0]).toMatch(/\breader\b/);
    expect(enumBlock![0]).toMatch(/\bcontributor\b/);
    expect(enumBlock![0]).toMatch(/\bmanager\b/);
  });

  it("declares DepartmentKind enum with HOUSEHOLD, DEPARTMENT, TEAM", () => {
    const schema = readSchema();
    const enumBlock = schema.match(
      /enum DepartmentKind \{[\s\S]*?\n\}/,
    );
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![0]).toMatch(/\bHOUSEHOLD\b/);
    expect(enumBlock![0]).toMatch(/\bDEPARTMENT\b/);
    expect(enumBlock![0]).toMatch(/\bTEAM\b/);
  });

  it("declares ProvisionState enum with required states", () => {
    const schema = readSchema();
    const enumBlock = schema.match(
      /enum ProvisionState \{[\s\S]*?\n\}/,
    );
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![0]).toMatch(/\bpending\b/);
    expect(enumBlock![0]).toMatch(/\bprovisioning\b/);
    expect(enumBlock![0]).toMatch(/\bactive\b/);
    expect(enumBlock![0]).toMatch(/\bfailed\b/);
    expect(enumBlock![0]).toMatch(/\barchiving\b/);
    expect(enumBlock![0]).toMatch(/\barchived\b/);
  });

  it("declares NcSyncState enum with required states", () => {
    const schema = readSchema();
    const enumBlock = schema.match(
      /enum NcSyncState \{[\s\S]*?\n\}/,
    );
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![0]).toMatch(/\bpending\b/);
    expect(enumBlock![0]).toMatch(/\bsynced\b/);
    expect(enumBlock![0]).toMatch(/\bfailed\b/);
    expect(enumBlock![0]).toMatch(/\bremoving\b/);
  });

  it("declares a Department model with unique name and slug", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model Department \{/m);
    const deptBlock = schema.match(/model Department \{[\s\S]*?\n\}/);
    expect(deptBlock).not.toBeNull();
    expect(deptBlock![0]).toMatch(/name\s+String\s+@unique/);
    expect(deptBlock![0]).toMatch(/slug\s+String\s+@unique/);
  });

  it("Department has a kind field that defaults to DEPARTMENT", () => {
    const schema = readSchema();
    const deptBlock = schema.match(/model Department \{[\s\S]*?\n\}/);
    expect(deptBlock).not.toBeNull();
    expect(deptBlock![0]).toMatch(/kind\s+DepartmentKind\s+@default\(DEPARTMENT\)/);
  });

  it("Department has a state field that defaults to pending", () => {
    const schema = readSchema();
    const deptBlock = schema.match(/model Department \{[\s\S]*?\n\}/);
    expect(deptBlock).not.toBeNull();
    expect(deptBlock![0]).toMatch(/state\s+ProvisionState\s+@default\(pending\)/);
  });

  it("Department has a parentId for self-relation with DeptHierarchy relation name", () => {
    const schema = readSchema();
    const deptBlock = schema.match(/model Department \{[\s\S]*?\n\}/);
    expect(deptBlock).not.toBeNull();
    expect(deptBlock![0]).toMatch(/parentId\s+String\?/);
    expect(deptBlock![0]).toMatch(/parent\s+Department\?\s+@relation\("DeptHierarchy"/);
    expect(deptBlock![0]).toMatch(/teams\s+Department\[\]\s+@relation\("DeptHierarchy"\)/);
  });

  it("Department.createdBy is a String (local User.id UUID)", () => {
    const schema = readSchema();
    const deptBlock = schema.match(/model Department \{[\s\S]*?\n\}/);
    expect(deptBlock).not.toBeNull();
    expect(deptBlock![0]).toMatch(/createdBy\s+String\b/);
  });

  it("declares DepartmentMembership with (departmentId, userId) unique", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model DepartmentMembership \{/m);
    const block = schema.match(/model DepartmentMembership \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/@@unique\(\[departmentId, userId\]\)/);
  });

  it("DepartmentMembership.userId is String (local User.id UUID), not username", () => {
    const schema = readSchema();
    const block = schema.match(/model DepartmentMembership \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/userId\s+String\b/);
  });

  it("DepartmentMembership.right references DepartmentRight enum", () => {
    const schema = readSchema();
    const block = schema.match(/model DepartmentMembership \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/right\s+DepartmentRight\s+@default\(contributor\)/);
  });

  it("DepartmentMembership has syncState: NcSyncState", () => {
    const schema = readSchema();
    const block = schema.match(/model DepartmentMembership \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/syncState\s+NcSyncState\s+@default\(pending\)/);
  });

  it("declares UserInviteDepartment with (inviteId, departmentId) unique", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model UserInviteDepartment \{/m);
    const block = schema.match(/model UserInviteDepartment \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/@@unique\(\[inviteId, departmentId\]\)/);
  });

  it("UserInviteDepartment.right references DepartmentRight enum", () => {
    const schema = readSchema();
    const block = schema.match(/model UserInviteDepartment \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/right\s+DepartmentRight\s+@default\(contributor\)/);
  });

  it("declares UserUsagePolicy with userId as PK", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model UserUsagePolicy \{/m);
    const block = schema.match(/model UserUsagePolicy \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/userId\s+String\s+@id/);
  });

  it("UserUsagePolicy.quotaSyncState references NcSyncState enum", () => {
    const schema = readSchema();
    const block = schema.match(/model UserUsagePolicy \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/quotaSyncState\s+NcSyncState\s+@default\(pending\)/);
  });

  it("File model has departmentId column with index", () => {
    const schema = readSchema();
    const fileBlock = schema.match(/model File \{[\s\S]*?\n\}/);
    expect(fileBlock).not.toBeNull();
    expect(fileBlock![0]).toMatch(/departmentId\s+String\?/);
    expect(fileBlock![0]).toMatch(/@@index\(\[departmentId\]\)/);
  });

  it("User model has departmentMemberships relation", () => {
    const schema = readSchema();
    const userBlock = schema.match(/model User \{[\s\S]*?\n\}/);
    expect(userBlock).not.toBeNull();
    expect(userBlock![0]).toMatch(/departmentMemberships\s+DepartmentMembership\[\]/);
  });

  it("User model has usagePolicy relation", () => {
    const schema = readSchema();
    const userBlock = schema.match(/model User \{[\s\S]*?\n\}/);
    expect(userBlock).not.toBeNull();
    expect(userBlock![0]).toMatch(/usagePolicy\s+UserUsagePolicy\?/);
  });

  it("UserInvite model has departmentGrants relation", () => {
    const schema = readSchema();
    const inviteBlock = schema.match(/model UserInvite \{[\s\S]*?\n\}/);
    expect(inviteBlock).not.toBeNull();
    expect(inviteBlock![0]).toMatch(/departmentGrants\s+UserInviteDepartment\[\]/);
  });

  it("Group model is marked deprecated (WARP-1273)", () => {
    const schema = readSchema();
    // Extract the section from @deprecated comment through the closing brace of Group model.
    // Allowing for potential regular comments before the @deprecated line.
    const groupBlock = schema.match(
      /\/\/\/ @deprecated[\s\S]*?model Group \{[\s\S]*?\n\}/,
    );
    expect(groupBlock).not.toBeNull();
    if (groupBlock) {
      expect(groupBlock[0]).toMatch(/@deprecated/);
      expect(groupBlock[0]).toMatch(/model Group \{/);
    }
  });

  it("GroupMembership model is marked deprecated (WARP-1273)", () => {
    const schema = readSchema();
    // Extract the section from @deprecated comment through the closing brace.
    const memBlock = schema.match(
      /\/\/\/ @deprecated[\s\S]*?model GroupMembership \{[\s\S]*?\n\}/,
    );
    expect(memBlock).not.toBeNull();
    if (memBlock) {
      expect(memBlock[0]).toMatch(/@deprecated/);
      expect(memBlock[0]).toMatch(/model GroupMembership \{/);
    }
  });
});

describe("WARP-1255 migration: additive, uniformly idempotent (safe to re-run)", () => {
  it("guards every CREATE TYPE with the DO/EXCEPTION duplicate_object idiom", () => {
    const sql = readMigrationSql();
    // Four enums: DepartmentRight, DepartmentKind, ProvisionState, NcSyncState.
    // Each CREATE TYPE must sit inside a duplicate_object guard so a second
    // run is a no-op instead of erroring "type already exists".
    for (const t of [
      "DepartmentRight",
      "DepartmentKind",
      "ProvisionState",
      "NcSyncState",
    ]) {
      const guard = new RegExp(
        String.raw`DO \$\$ BEGIN[\s\S]*?CREATE TYPE "${t}"[\s\S]*?WHEN duplicate_object THEN null;[\s\S]*?END \$\$;`,
      );
      expect(guard.test(sql), `${t} CREATE TYPE must be guarded`).toBe(true);
    }
  });

  it("creates every table + index with IF NOT EXISTS (re-runnable)", () => {
    const sql = readMigrationSql();
    for (const table of [
      "Department",
      "DepartmentMembership",
      "DepartmentShare",
      "UserInviteDepartment",
      "UserUsagePolicy",
    ]) {
      expect(
        new RegExp(String.raw`CREATE TABLE IF NOT EXISTS "${table}"`).test(sql),
        `${table} must be CREATE TABLE IF NOT EXISTS`,
      ).toBe(true);
    }
    // No bare CREATE INDEX / CREATE TABLE (all must carry IF NOT EXISTS).
    const bareCreate = sql.match(
      /CREATE (?:UNIQUE )?(?:INDEX|TABLE)(?! IF NOT EXISTS)/g,
    );
    expect(
      bareCreate,
      `every CREATE INDEX/TABLE must use IF NOT EXISTS; found: ${bareCreate?.join(", ")}`,
    ).toBeNull();
    // File.departmentId is added with ADD COLUMN IF NOT EXISTS.
    expect(sql).toMatch(
      /ALTER TABLE "File"\s+ADD COLUMN IF NOT EXISTS "departmentId"/,
    );
  });

  it("wraps the self-referencing Department.parentId FK in a duplicate_object guard", () => {
    // WARP-1255 review (PR #981): the self-ref FK is added OUTSIDE the
    // CREATE TABLE IF NOT EXISTS block (unlike the inline FKs on the other
    // tables), so it needs its own DO/EXCEPTION guard or a second run aborts
    // with `constraint "Department_parentId_fkey" already exists`.
    const sql = readMigrationSql();
    const guardedFk =
      /DO \$\$ BEGIN\s+ALTER TABLE "Department"\s+ADD CONSTRAINT "Department_parentId_fkey"[\s\S]*?EXCEPTION\s+WHEN duplicate_object THEN null;\s+END \$\$;/;
    expect(
      guardedFk.test(sql),
      "Department_parentId_fkey must sit inside a DO $$ ... EXCEPTION WHEN duplicate_object guard",
    ).toBe(true);
  });

  it("has no bare (unguarded) ALTER TABLE ... ADD CONSTRAINT", () => {
    // Any top-level ADD CONSTRAINT must be either inline in a CREATE TABLE
    // IF NOT EXISTS or wrapped in a DO/EXCEPTION guard. A standalone
    // `ALTER TABLE ... ADD CONSTRAINT` (immediately preceded by ALTER TABLE,
    // not a DO $$ BEGIN) is the exact defect this migration was flagged for.
    const sql = readMigrationSql();
    const bareAlterConstraint =
      /(^|\n)ALTER TABLE "[^"]+"\s+ADD CONSTRAINT/g;
    const matches = sql.match(bareAlterConstraint);
    expect(
      matches,
      `standalone ALTER TABLE ... ADD CONSTRAINT must be guarded; found: ${matches?.join(" | ")}`,
    ).toBeNull();
  });

  it("does not seed or mutate any rows (purely additive)", () => {
    const sql = readMigrationSql();
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
  });
});
