/**
 * WARP-1525 / ADR-032 — Prisma schema regression for RBAC v2 T1:
 * AccessRole + per-axis grant tables + User/UserInvite.accessRoleId.
 *
 * These tests run against the schema.prisma file text (no DB needed)
 * to lock the contract for what the generated client must expose
 * (same discipline as department.schema.test.ts for WARP-1255):
 *
 *   - `FeatureAccessLevel` enum: view, act, manage.
 *   - `ToolAccessLevel` enum: view, use.
 *   - `ConnectorAccessLevel` enum: read, read_write.
 *   - `AccessExceptionEffect` enum: allow, deny.
 *   - `AccessRole` model: slug (unique), startingPoint (Role — the
 *     admin|family|guest constraint is SERVICE-layer, not a DB check),
 *     state String default "active", axis-c defaults nullable, axis-d
 *     booleans default false, users/invites/grant-list relations.
 *   - `AccessRoleFeatureGrant`: PK (roleId, moduleId), moduleId reuses the
 *     App-Modules `ModuleId` enum (one feature vocabulary, no drift).
 *   - `AccessRoleToolGrant`: PK (roleId, domain), domain is a String —
 *     tools-core's ToolDomain is TS-only, not a pgEnum.
 *   - `AccessRoleConnectorGrant`: PK (roleId, provider).
 *   - `UserAccessException`: (userId, moduleId) unique, feature-axis only.
 *   - `User` gains nullable accessRoleId (onDelete: Restrict — deleting an
 *     in-use role must never silently strip people's assignment; the
 *     service layer blocks it with "reassign first") + accessExceptions.
 *   - `UserInvite` gains nullable accessRoleId (Restrict, same reasoning).
 *   - Grant/exception rows CASCADE with their role/user (composition).
 *
 * Per ADR-032 §2: all additive; no destructive migration; no data backfill.
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
    d.includes("warp_1525_accessrole_rbac_v2"),
  );
  expect(
    dirs.length,
    "must ship a `warp_1525_accessrole_rbac_v2` migration directory",
  ).toBe(1);
  return readFileSync(
    path.join(MIGRATIONS_DIR, dirs[0]!, "migration.sql"),
    "utf-8",
  );
}

function modelBlock(schema: string, name: string): string {
  const block = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
  expect(block, `model ${name} must exist`).not.toBeNull();
  return block![0];
}

describe("WARP-1525 schema: RBAC v2 enums", () => {
  it("declares FeatureAccessLevel enum with view, act, manage", () => {
    const schema = readSchema();
    const enumBlock = schema.match(/enum FeatureAccessLevel \{[\s\S]*?\n\}/);
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![0]).toMatch(/\bview\b/);
    expect(enumBlock![0]).toMatch(/\bact\b/);
    expect(enumBlock![0]).toMatch(/\bmanage\b/);
  });

  it("declares ToolAccessLevel enum with view, use", () => {
    const schema = readSchema();
    const enumBlock = schema.match(/enum ToolAccessLevel \{[\s\S]*?\n\}/);
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![0]).toMatch(/\bview\b/);
    expect(enumBlock![0]).toMatch(/\buse\b/);
  });

  it("declares ConnectorAccessLevel enum with read, read_write", () => {
    const schema = readSchema();
    const enumBlock = schema.match(/enum ConnectorAccessLevel \{[\s\S]*?\n\}/);
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![0]).toMatch(/\bread\b/);
    expect(enumBlock![0]).toMatch(/\bread_write\b/);
  });

  it("declares AccessExceptionEffect enum with allow, deny", () => {
    const schema = readSchema();
    const enumBlock = schema.match(/enum AccessExceptionEffect \{[\s\S]*?\n\}/);
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![0]).toMatch(/\ballow\b/);
    expect(enumBlock![0]).toMatch(/\bdeny\b/);
  });
});

describe("WARP-1525 schema: AccessRole model", () => {
  it("declares AccessRole with unique slug", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model AccessRole \{/m);
    const block = modelBlock(schema, "AccessRole");
    expect(block).toMatch(/slug\s+String\s+@unique/);
  });

  it("startingPoint is the Role enum, with the admin|family|guest constraint documented as service-layer (NOT a DB check)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRole");
    expect(block).toMatch(/startingPoint\s+Role\b/);
    // The constraint lives in the service layer + zod (T3), never the DB —
    // lock the comment so a later refactor doesn't silently promise a CHECK.
    expect(block).toMatch(/admin\|family\|guest/);
    expect(block).toMatch(/never owner\/service/i);
    expect(block).toMatch(/service/i);
  });

  it("state is a String defaulting to active (matching the ADR-032 §2 spec)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRole");
    expect(block).toMatch(/state\s+String\s+@default\("active"\)/);
  });

  it("axis-c usage defaults are nullable (person's UserUsagePolicy row overrides)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRole");
    expect(block).toMatch(/storageQuotaBytes\s+BigInt\?/);
    expect(block).toMatch(/maxUploadSizeMb\s+Int\?/);
    expect(block).toMatch(/llmDailyMessageCap\s+Int\?/);
  });

  it("axis-d booleans default false (fail-toward-least-privilege)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRole");
    expect(block).toMatch(/cloudModelsAllowed\s+Boolean\s+@default\(false\)/);
    expect(block).toMatch(/mayOperateLocks\s+Boolean\s+@default\(false\)/);
  });

  it("createdBy is a String (local User.id UUID, no FK — matches Department.createdBy)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRole");
    expect(block).toMatch(/createdBy\s+String\b/);
  });

  it("carries the round-trip relations: users, invites, and the three grant lists", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRole");
    expect(block).toMatch(/users\s+User\[\]/);
    expect(block).toMatch(/invites\s+UserInvite\[\]/);
    expect(block).toMatch(/featureGrants\s+AccessRoleFeatureGrant\[\]/);
    expect(block).toMatch(/toolGrants\s+AccessRoleToolGrant\[\]/);
    expect(block).toMatch(/connectorGrants\s+AccessRoleConnectorGrant\[\]/);
  });
});

describe("WARP-1525 schema: per-axis grant tables", () => {
  it("AccessRoleFeatureGrant has composite PK (roleId, moduleId) and reuses the ModuleId enum", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRoleFeatureGrant");
    expect(block).toMatch(/@@id\(\[roleId, moduleId\]\)/);
    expect(block).toMatch(/moduleId\s+ModuleId\b/);
    expect(block).toMatch(/level\s+FeatureAccessLevel\b/);
  });

  it("AccessRoleFeatureGrant rows cascade with their role", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRoleFeatureGrant");
    expect(block).toMatch(
      /role\s+AccessRole\s+@relation\(fields: \[roleId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it("AccessRoleToolGrant has composite PK (roleId, domain); domain is a String because tools-core ToolDomain is TS-only (not a pgEnum)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRoleToolGrant");
    expect(block).toMatch(/@@id\(\[roleId, domain\]\)/);
    expect(block).toMatch(/domain\s+String\b/);
    expect(block).toMatch(/level\s+ToolAccessLevel\b/);
    // Lock the why-String comment so nobody "fixes" it into a pgEnum later.
    expect(block).toMatch(/not a pgEnum/i);
    expect(block).toMatch(
      /role\s+AccessRole\s+@relation\(fields: \[roleId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it("AccessRoleConnectorGrant has composite PK (roleId, provider)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "AccessRoleConnectorGrant");
    expect(block).toMatch(/@@id\(\[roleId, provider\]\)/);
    expect(block).toMatch(/provider\s+String\b/);
    expect(block).toMatch(/level\s+ConnectorAccessLevel\b/);
    expect(block).toMatch(
      /role\s+AccessRole\s+@relation\(fields: \[roleId\], references: \[id\], onDelete: Cascade\)/,
    );
  });
});

describe("WARP-1525 schema: UserAccessException", () => {
  it("declares UserAccessException with (userId, moduleId) unique", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model UserAccessException \{/m);
    const block = modelBlock(schema, "UserAccessException");
    expect(block).toMatch(/@@unique\(\[userId, moduleId\]\)/);
  });

  it("is feature-axis only: moduleId ModuleId + AccessExceptionEffect + optional level", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "UserAccessException");
    expect(block).toMatch(/moduleId\s+ModuleId\b/);
    expect(block).toMatch(/effect\s+AccessExceptionEffect\b/);
    // level is required when effect=allow — service-enforced, so nullable here.
    expect(block).toMatch(/level\s+FeatureAccessLevel\?/);
    expect(block).toMatch(/grantedBy\s+String\b/);
  });

  it("exception rows cascade with their user", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "UserAccessException");
    expect(block).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
  });
});

describe("WARP-1525 schema: User + UserInvite accessRoleId", () => {
  it("User gains nullable accessRoleId (null = plain built-in tier, fully backward compatible)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "User");
    expect(block).toMatch(/accessRoleId\s+String\?/);
  });

  it("User.accessRole is onDelete: Restrict — a role delete must never silently strip assignments", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "User");
    expect(block).toMatch(
      /accessRole\s+AccessRole\?\s+@relation\(fields: \[accessRoleId\], references: \[id\], onDelete: Restrict\)/,
    );
  });

  it("User has the accessExceptions relation and an index on accessRoleId", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "User");
    expect(block).toMatch(/accessExceptions\s+UserAccessException\[\]/);
    expect(block).toMatch(/@@index\(\[accessRoleId\]\)/);
  });

  it("UserInvite gains nullable accessRoleId with onDelete: Restrict (any invite row referencing the role blocks its delete)", () => {
    const schema = readSchema();
    const block = modelBlock(schema, "UserInvite");
    expect(block).toMatch(/accessRoleId\s+String\?/);
    expect(block).toMatch(
      /accessRole\s+AccessRole\?\s+@relation\(fields: \[accessRoleId\], references: \[id\], onDelete: Restrict\)/,
    );
  });
});

describe("WARP-1525 migration: additive, uniformly idempotent (safe to re-run)", () => {
  it("guards every CREATE TYPE with the DO/EXCEPTION duplicate_object idiom", () => {
    const sql = readMigrationSql();
    for (const t of [
      "FeatureAccessLevel",
      "ToolAccessLevel",
      "ConnectorAccessLevel",
      "AccessExceptionEffect",
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
      "AccessRole",
      "AccessRoleFeatureGrant",
      "AccessRoleToolGrant",
      "AccessRoleConnectorGrant",
      "UserAccessException",
    ]) {
      expect(
        new RegExp(String.raw`CREATE TABLE IF NOT EXISTS "${table}"`).test(sql),
        `${table} must be CREATE TABLE IF NOT EXISTS`,
      ).toBe(true);
    }
    const bareCreate = sql.match(
      /CREATE (?:UNIQUE )?(?:INDEX|TABLE)(?! IF NOT EXISTS)/g,
    );
    expect(
      bareCreate,
      `every CREATE INDEX/TABLE must use IF NOT EXISTS; found: ${bareCreate?.join(", ")}`,
    ).toBeNull();
    // Both accessRoleId columns are added with ADD COLUMN IF NOT EXISTS.
    expect(sql).toMatch(
      /ALTER TABLE "User"\s+ADD COLUMN IF NOT EXISTS "accessRoleId"/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "UserInvite"\s+ADD COLUMN IF NOT EXISTS "accessRoleId"/,
    );
  });

  it("adds the accessRoleId FKs as guarded constraints with ON DELETE RESTRICT", () => {
    // Both column FKs are added OUTSIDE a CREATE TABLE block (the tables
    // pre-exist), so each needs its own DO/EXCEPTION guard — the exact
    // defect the WARP-1255 migration was flagged for in PR #981.
    const sql = readMigrationSql();
    for (const table of ["User", "UserInvite"]) {
      const guardedFk = new RegExp(
        String.raw`DO \$\$ BEGIN\s+ALTER TABLE "${table}"\s+ADD CONSTRAINT "${table}_accessRoleId_fkey"[\s\S]*?ON DELETE RESTRICT[\s\S]*?EXCEPTION\s+WHEN duplicate_object THEN null;\s+END \$\$;`,
      );
      expect(
        guardedFk.test(sql),
        `${table}_accessRoleId_fkey must be guarded and ON DELETE RESTRICT`,
      ).toBe(true);
    }
  });

  it("grant/exception FKs cascade with their role/user", () => {
    const sql = readMigrationSql();
    for (const fk of [
      "AccessRoleFeatureGrant_roleId_fkey",
      "AccessRoleToolGrant_roleId_fkey",
      "AccessRoleConnectorGrant_roleId_fkey",
      "UserAccessException_userId_fkey",
    ]) {
      const cascading = new RegExp(
        String.raw`CONSTRAINT "${fk}"[\s\S]*?ON DELETE CASCADE`,
      );
      expect(cascading.test(sql), `${fk} must be ON DELETE CASCADE`).toBe(true);
    }
  });

  it("has no bare (unguarded) ALTER TABLE ... ADD CONSTRAINT", () => {
    const sql = readMigrationSql();
    const bareAlterConstraint = /(^|\n)ALTER TABLE "[^"]+"\s+ADD CONSTRAINT/g;
    const matches = sql.match(bareAlterConstraint);
    expect(
      matches,
      `standalone ALTER TABLE ... ADD CONSTRAINT must be guarded; found: ${matches?.join(" | ")}`,
    ).toBeNull();
  });

  it("does not seed or mutate any rows (purely additive, no backfill)", () => {
    const sql = readMigrationSql();
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    expect(sql).not.toMatch(/\bDROP\s+/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
