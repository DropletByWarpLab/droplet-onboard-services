/**
 * WARP-455 — Prisma schema regression for the Scope axis.
 *
 * Locks the contract for the second RBAC axis on top of WARP-171's
 * role enum:
 *
 *   - `Scope` Prisma enum (pgEnum): team | exec_only | finance |
 *     engineering | ops | private. Six values, hard-locked here so a
 *     new resource that hangs off requireScope() can't drift past the
 *     middleware's truth-table without a schema change.
 *
 *   - `ScopeBinding` join model (User ↔ Scope, many-to-many) with
 *     a unique compound `(userId, scope)` so a user can't be bound to
 *     the same scope twice.
 *
 * Scope is intentionally a pgEnum (not a free-form text column or a
 * separate Scope table). The set is small, fully known up front, and
 * driven by code (the requireScope() middleware switches on these
 * values). Adding a new value is a schema migration — that's the
 * desired velocity. A table would invert the cost: trivial to add a
 * row, expensive to keep code and data in sync.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SCHEMA_PATH } from "./helpers/test-paths.js";

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

describe("WARP-455 schema: Scope axis", () => {
  it("declares a Scope enum with the six canonical values", () => {
    const schema = readSchema();
    const enumBlock = schema.match(/enum Scope \{[\s\S]*?\n\}/);
    expect(enumBlock).not.toBeNull();
    const body = enumBlock![0];
    for (const value of [
      "team",
      "exec_only",
      "finance",
      "engineering",
      "ops",
      "private",
    ]) {
      expect(body).toMatch(new RegExp(`\\b${value}\\b`));
    }
  });

  it("declares a ScopeBinding model with @@unique([userId, scope])", () => {
    const schema = readSchema();
    expect(schema).toMatch(/^model ScopeBinding \{/m);
    const block = schema.match(/model ScopeBinding \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/@@unique\(\[userId, scope\]\)/);
  });

  it("ScopeBinding.scope references the Scope enum (no free-form text)", () => {
    const schema = readSchema();
    const block = schema.match(/model ScopeBinding \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\bscope\s+Scope\b/);
    expect(block![0]).not.toMatch(/\bscope\s+String\b/);
  });

  it("User.scopeBindings reverse-relation is declared", () => {
    // The reverse relation has to be present on User for the Prisma
    // client's typed include API to work and for `prisma.user.delete`
    // cascade semantics to apply.
    const schema = readSchema();
    const userBlock = schema.match(/model User \{[\s\S]*?\n\}/);
    expect(userBlock).not.toBeNull();
    expect(userBlock![0]).toMatch(/scopeBindings\s+ScopeBinding\[\]/);
  });
});
