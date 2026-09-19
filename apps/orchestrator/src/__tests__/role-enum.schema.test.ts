/**
 * WARP-171: schema-level assertions for the Prisma `Role` enum.
 *
 * Vitest's setup mocks `@prisma/client` (see ./setup.ts) so we can't drive
 * a real DB here. The contract this test guards is the schema text itself:
 * the `Role` enum must mirror the TS union, and `UserInvite.role` must use
 * the enum (not the legacy free-form `String @default("user")` declaration
 * the CLAUDE.md no-guessing rule already forbids).
 *
 * Anyone removing the enum or reverting the column type will trip this test
 * before they hit the integration-test or migration-rollout phase. Pairs
 * with `prisma/migrations/<ts>_warp_171_role_enum/migration.sql` which
 * carries the backfill.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const SCHEMA_PATH = join(PRISMA_DIR, "schema.prisma");
const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");

const schema = readFileSync(SCHEMA_PATH, "utf8");

describe("Prisma schema — Role enum (WARP-171 AC #1)", () => {
  it("declares the Role enum with all five values from the TS union", () => {
    // The single source of truth for the TS Role union lives in
    // services/jwt.service.ts; the Prisma enum must mirror it 1:1 so that
    // a session role can be persisted without coercion.
    const enumMatch = schema.match(/enum\s+Role\s*\{([^}]+)\}/);
    expect(enumMatch, "Role enum must be declared in schema.prisma").not.toBeNull();

    const body = enumMatch![1];
    for (const value of ["owner", "admin", "family", "guest", "service"]) {
      expect(
        new RegExp(`\\b${value}\\b`).test(body),
        `Role enum must include '${value}'`,
      ).toBe(true);
    }
  });

  it("uses the Role enum on UserInvite.role (replacing the legacy String column)", () => {
    // The CLAUDE.md no-guessing rule forbids persistent role state as a
    // free-form String. Before WARP-171 the line read:
    //   role  String  @default("user")  // "admin" | "user"
    // After WARP-171 it must reference the Role enum directly.
    const userInviteBlock = schema.match(/model\s+UserInvite\s*\{[\s\S]*?\n\}/);
    expect(userInviteBlock, "UserInvite model must exist").not.toBeNull();

    const block = userInviteBlock![0];
    expect(
      /\brole\s+Role\b/.test(block),
      "UserInvite.role must be typed as the Role enum",
    ).toBe(true);
    expect(
      /\brole\s+String\b/.test(block),
      "UserInvite.role must no longer be a free-form String",
    ).toBe(false);
  });

  it("defaults UserInvite.role to a least-privileged enum value", () => {
    // We default to `family` to match the existing roleFromGroups
    // fallback (an invite created without an explicit role lands the
    // invitee in the regular-household tier, not the owner/admin tier).
    const userInviteBlock = schema.match(/model\s+UserInvite\s*\{[\s\S]*?\n\}/)![0];
    expect(
      /\brole\s+Role\s+@default\(family\)/.test(userInviteBlock),
      "UserInvite.role must default to `family`",
    ).toBe(true);
  });
});

describe("Prisma migration — Role enum (WARP-171 AC #1)", () => {
  it("ships a migration that creates the enum and backfills existing rows", () => {
    // We don't grep the migration filename (it carries a timestamp prefix
    // that's not load-bearing); instead we glob the migrations dir for a
    // file whose name contains `warp_171_role_enum` and assert its SQL
    // payload contains the three required operations: enum creation,
    // backfill of legacy "admin"/"user" strings, and a stable
    // post-migration column type.
    //
    // Re-runnable guarantee: the migration uses `DO ... EXCEPTION` for the
    // enum and `ALTER TABLE ... TYPE` for the column, so a second run on
    // an already-converged DB is a no-op (Postgres throws duplicate_object
    // we swallow, and the column-type change is idempotent).
    const dirs = readdirSync(MIGRATIONS_DIR).filter((d) =>
      d.includes("warp_171_role_enum"),
    );
    expect(
      dirs.length,
      "must ship a `warp_171_role_enum` migration directory",
    ).toBeGreaterThan(0);

    const migrationSql = readFileSync(
      join(MIGRATIONS_DIR, dirs[0], "migration.sql"),
      "utf8",
    );
    expect(/CREATE TYPE "Role"/i.test(migrationSql)).toBe(true);
    expect(/'owner'/.test(migrationSql)).toBe(true);
    expect(/'admin'/.test(migrationSql)).toBe(true);
    expect(/'family'/.test(migrationSql)).toBe(true);
    expect(/'guest'/.test(migrationSql)).toBe(true);
    expect(/'service'/.test(migrationSql)).toBe(true);
    // Backfill the two legacy strings the pre-WARP-171 schema permitted.
    // Accept either pattern: a separate UPDATE statement OR an inline
    // `ALTER COLUMN ... TYPE "Role" USING (...)` cast that maps legacy
    // strings inside a CASE expression. Both achieve the same end state;
    // the USING form is more idempotent because the new type prevents
    // any future rows from carrying junk strings.
    const hasUpdateBackfill = /UPDATE\s+"UserInvite"/i.test(migrationSql);
    const hasUsingBackfill =
      /ALTER\s+COLUMN\s+"role"[\s\S]*?USING[\s\S]*?'admin'[\s\S]*?'family'/i.test(
        migrationSql,
      );
    expect(
      hasUpdateBackfill || hasUsingBackfill,
      "migration must backfill the legacy 'admin'/'user' strings to the new enum",
    ).toBe(true);
  });
});
