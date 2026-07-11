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
import { readFileSync } from "node:fs";
import * as path from "node:path";

const SCHEMA_PATH = path.resolve(
  process.cwd(),
  "prisma",
  "schema.prisma",
);

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
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
