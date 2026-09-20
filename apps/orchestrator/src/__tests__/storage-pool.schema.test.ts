/**
 * BUG-3 / ADR-019: schema-level assertions for the StoragePool + PoolMember
 * models and the PoolStatus / DiskRole / ArrayLevel enums.
 *
 * Mirrors the WARP-446 / WARP-218 schema-shape pattern: vitest's setup mocks
 * `@prisma/client` (see ./setup.ts) so we cannot drive a real DB here. The
 * contract this test guards is the schema text itself + the presence and
 * IDEMPOTENCE of the matching migration. Anyone reverting an enum to a
 * free-form string column (which the no-guessing rule forbids), dropping the
 * migration, or removing the re-runnable guards will trip this test before the
 * integration phase.
 *
 * Pairs with:
 *   - prisma/schema.prisma (model StoragePool, model PoolMember,
 *     enums PoolStatus / DiskRole / ArrayLevel)
 *   - prisma/migrations/20260604000000_bug_3_storage_pool/migration.sql
 *   - docs/ADR-019-storage-pool-management.md
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const SCHEMA_PATH = join(PRISMA_DIR, "schema.prisma");
const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");

const schema = readFileSync(SCHEMA_PATH, "utf8");

describe("Prisma schema — storage-pool enums (ADR-019, rule 10)", () => {
  it("declares PoolStatus with all five explicit states incl. `none`", () => {
    const m = schema.match(/enum\s+PoolStatus\s*\{([^}]+)\}/);
    expect(m, "PoolStatus enum must be declared").not.toBeNull();
    const body = m![1];
    for (const value of ["active", "degraded", "resyncing", "failed", "none"]) {
      expect(
        new RegExp(`\\b${value}\\b`).test(body),
        `PoolStatus must include '${value}'`,
      ).toBe(true);
    }
  });

  it("declares DiskRole with all four explicit roles", () => {
    const m = schema.match(/enum\s+DiskRole\s*\{([^}]+)\}/);
    expect(m, "DiskRole enum must be declared").not.toBeNull();
    const body = m![1];
    for (const value of ["active", "spare", "failed", "unassigned"]) {
      expect(
        new RegExp(`\\b${value}\\b`).test(body),
        `DiskRole must include '${value}'`,
      ).toBe(true);
    }
  });

  it("declares ArrayLevel with every supported mdadm level + jbod", () => {
    const m = schema.match(/enum\s+ArrayLevel\s*\{([^}]+)\}/);
    expect(m, "ArrayLevel enum must be declared").not.toBeNull();
    const body = m![1];
    for (const value of ["raid0", "raid1", "raid5", "raid6", "raid10", "jbod"]) {
      expect(
        new RegExp(`\\b${value}\\b`).test(body),
        `ArrayLevel must include '${value}'`,
      ).toBe(true);
    }
  });
});

describe("Prisma schema — StoragePool model (ADR-019)", () => {
  const modelMatch = schema.match(
    /model\s+StoragePool\s*\{([\s\S]+?)\}\s*(?=\nenum|\nmodel|\/\/\/|$)/,
  );

  it("declares StoragePool with `device` as the primary key", () => {
    expect(modelMatch, "StoragePool model must exist").not.toBeNull();
    const body = modelMatch![1];
    expect(body).toMatch(/device\s+String\s+@id/);
  });

  it("uses explicit enum columns, never free-form strings, for state + level", () => {
    const body = modelMatch![1];
    // status uses the enum and defaults to `none` (no derived state).
    expect(body).toMatch(/status\s+PoolStatus/);
    expect(body).toMatch(/@default\(none\)/);
    // level uses the ArrayLevel enum — owner-chosen, no String fallback.
    expect(body).toMatch(/level\s+ArrayLevel/);
  });

  it("indexes status so the dashboard's degraded-array query stays direct", () => {
    const body = modelMatch![1];
    expect(body).toMatch(/@@index\(\[status\]\)/);
  });
});

describe("Prisma schema — PoolMember model (ADR-019)", () => {
  const modelMatch = schema.match(
    /model\s+PoolMember\s*\{([\s\S]+?)\}\s*(?=\nenum|\nmodel|\/\/\/|$)/,
  );

  it("declares PoolMember with an explicit DiskRole enum (no guessed state)", () => {
    expect(modelMatch, "PoolMember model must exist").not.toBeNull();
    const body = modelMatch![1];
    expect(body).toMatch(/role\s+DiskRole/);
    expect(body).toMatch(/@default\(unassigned\)/);
  });

  it("relates to StoragePool and is unique per (pool, device)", () => {
    const body = modelMatch![1];
    expect(body).toMatch(/pool\s+StoragePool\s+@relation/);
    expect(body).toMatch(/@@unique\(\[poolDevice,\s*device\]\)/);
  });
});

describe("Prisma migration — BUG-3 storage pool (idempotent, seeds nothing)", () => {
  function readMigration(): string {
    const dirs = readdirSync(MIGRATIONS_DIR);
    const ours = dirs.find((d) => d.endsWith("bug_3_storage_pool"));
    expect(ours, "expected a bug_3_storage_pool migration directory").toBeDefined();
    return readFileSync(join(MIGRATIONS_DIR, ours!, "migration.sql"), "utf8");
  }

  it("creates the three enums with the idempotent DO/EXCEPTION guard", () => {
    const sql = readMigration();
    for (const t of ["PoolStatus", "DiskRole", "ArrayLevel"]) {
      expect(sql).toMatch(new RegExp(`CREATE TYPE "${t}"`));
    }
    // Each CREATE TYPE must sit inside a duplicate_object guard so a second
    // `prisma migrate dev` run on a converged DB doesn't fail in CI.
    const guards = sql.match(/WHEN duplicate_object THEN null/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it("creates both tables + indexes with IF NOT EXISTS (re-runnable)", () => {
    const sql = readMigration();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "StoragePool"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "PoolMember"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "StoragePool_status_idx"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "PoolMember_poolDevice_device_key"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "PoolMember_poolDevice_idx"/);
  });

  it("SEEDS NOTHING — no INSERT (a fresh box has zero pools; nothing auto-creates one)", () => {
    const sql = readMigration();
    // The owner's hard constraint, pinned at the migration level: this
    // migration must never insert a pool row.
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });
});
