/**
 * WARP-455 — Prisma schema regression for the local user directory.
 *
 * These tests run against the schema.prisma file text (no DB needed)
 * to lock the contract for what the generated client must expose:
 *
 *   - `User` model: id, username (unique), displayName, email?, role,
 *     isLocal, createdAt, updatedAt.
 *   - `Group` model: id, name (unique), description?, createdAt, updatedAt.
 *   - `GroupMembership` (User ↔ Group with unique compound).
 *
 * Per the no-guessing rule (CLAUDE.md) the `role` column references
 * the existing WARP-171 `Role` enum — do not introduce a parallel
 * free-form text column or a new enum.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SCHEMA_PATH } from "./helpers/test-paths.js";

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

describe("WARP-455 schema: local user directory", () => {
  it("declares a User model", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model User \{/m);
  });

  it("User.role references the WARP-171 Role enum (no free-form text)", () => {
    const schema = readSchema();
    const userBlock = schema.match(/model User \{[\s\S]*?\n\}/);
    expect(userBlock).not.toBeNull();
    // The column must be `role Role` (the enum from jwt.service.ts mirror),
    // not `role String` — the no-guessing rule.
    expect(userBlock![0]).toMatch(/\brole\s+Role\b/);
    expect(userBlock![0]).not.toMatch(/\brole\s+String\b/);
  });

  it("User has a unique username column", () => {
    const schema = readSchema();
    const userBlock = schema.match(/model User \{[\s\S]*?\n\}/);
    expect(userBlock).not.toBeNull();
    expect(userBlock![0]).toMatch(/username\s+String\s+@unique/);
  });

  it("User has an isLocal boolean that defaults to true", () => {
    // Distinguishes locally-provisioned users from Nextcloud-mirror
    // entries so the dashboard can render the right affordances and
    // the delete handler can refuse to remove an OCS-owned identity.
    const schema = readSchema();
    const userBlock = schema.match(/model User \{[\s\S]*?\n\}/);
    expect(userBlock).not.toBeNull();
    expect(userBlock![0]).toMatch(/isLocal\s+Boolean\s+@default\(true\)/);
  });

  it("declares a Group model with a unique name", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model Group \{/m);
    const groupBlock = schema.match(/model Group \{[\s\S]*?\n\}/);
    expect(groupBlock).not.toBeNull();
    expect(groupBlock![0]).toMatch(/name\s+String\s+@unique/);
  });

  it("declares a GroupMembership join model with a unique (userId, groupId)", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model GroupMembership \{/m);
    const block = schema.match(/model GroupMembership \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/@@unique\(\[userId, groupId\]\)/);
  });
});
