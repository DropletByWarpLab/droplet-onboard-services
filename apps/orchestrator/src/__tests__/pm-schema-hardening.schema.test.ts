/**
 * WARP-884 / WARP-885: schema + migration assertions for the PM hardening
 * pass (ADR-026 tech-debt, deferred from #680/#681).
 *
 * Vitest mocks `@prisma/client` (see ./setup.ts) so we can't drive a real DB.
 * These tests guard the migration SQL + schema.prisma content directly —
 * mirrors the vpn-peer-unique-ip.schema.test.ts pattern (glob the migrations
 * dir for the named folder, assert its SQL payload) — which is this repo's
 * established way of covering "prisma db push bypasses migration-only
 * partial indexes" (WARP-885's CI-assertion ask) without a live Postgres.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");
const SCHEMA = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");

function findMigrationDir(needle: string): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.includes(needle));
  expect(dirs.length, `must ship a migration directory matching "${needle}"`).toBeGreaterThan(0);
  return dirs[0];
}

function readMigrationSql(dirName: string): string {
  return readFileSync(join(MIGRATIONS_DIR, dirName, "migration.sql"), "utf8");
}

describe("PmState.isDefault partial unique index (WARP-885 — already shipped)", () => {
  it("still ships in the native_pm_foundation migration (regression guard against accidental removal)", () => {
    const dir = findMigrationDir("native_pm_foundation");
    const sql = readMigrationSql(dir);
    expect(
      /CREATE\s+UNIQUE\s+INDEX\s+"PmState_projectId_isDefault_key"\s+ON\s+"PmState"\s*\(\s*"projectId"\s*\)\s+WHERE\s+"isDefault"\s*=\s*true/i.test(
        sql,
      ),
      'must keep the partial unique index scoped to isDefault = true',
    ).toBe(true);
  });

  it("PmState(projectId, name) is unique (already shipped)", () => {
    const dir = findMigrationDir("native_pm_foundation");
    const sql = readMigrationSql(dir);
    expect(
      /CREATE\s+UNIQUE\s+INDEX\s+"PmState_projectId_name_key"\s+ON\s+"PmState"\s*\(\s*"projectId",\s*"name"\s*\)/i.test(
        sql,
      ),
    ).toBe(true);
  });
});

describe("PM schema hardening migration (WARP-884 / WARP-885)", () => {
  const dir = findMigrationDir("warp_884_885_pm_schema_hardening");
  const sql = readMigrationSql(dir);

  it("adds the explicit completion/archival columns (WARP-884)", () => {
    expect(/ALTER TABLE "PmProject" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false/i.test(sql)).toBe(
      true,
    );
    expect(/ALTER TABLE "PmWorkItem" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false/i.test(sql)).toBe(
      true,
    );
    expect(/ALTER TABLE "PmWorkItem" ADD COLUMN "isCompleted" BOOLEAN NOT NULL DEFAULT false/i.test(sql)).toBe(
      true,
    );
  });

  it("backfills the new booleans from the pre-existing timestamp columns", () => {
    expect(/UPDATE\s+"PmProject"\s+SET\s+"isArchived"\s*=\s*true\s+WHERE\s+"archivedAt"\s+IS NOT NULL/i.test(sql)).toBe(
      true,
    );
    expect(
      /UPDATE\s+"PmWorkItem"\s+SET\s+"isArchived"\s*=\s*true\s+WHERE\s+"archivedAt"\s+IS NOT NULL/i.test(sql),
    ).toBe(true);
    expect(
      /UPDATE\s+"PmWorkItem"\s+SET\s+"isCompleted"\s*=\s*true\s+WHERE\s+"completedAt"\s+IS NOT NULL/i.test(sql),
    ).toBe(true);
  });

  it("extends PmActivityVerb with parent_removed, module_added, module_removed (WARP-885)", () => {
    for (const verb of ["parent_removed", "module_added", "module_removed"]) {
      expect(
        sql.includes(`ADD VALUE '${verb}'`),
        `migration must add PmActivityVerb value '${verb}'`,
      ).toBe(true);
    }
  });

  it("adds PmWorkItemPropertyValue.createdAt, backfilled + defaulted (WARP-885)", () => {
    expect(/ALTER TABLE "PmWorkItemPropertyValue" ADD COLUMN "createdAt"/i.test(sql)).toBe(true);
    expect(/UPDATE\s+"PmWorkItemPropertyValue"\s+SET\s+"createdAt"\s*=\s*"updatedAt"/i.test(sql)).toBe(true);
    expect(
      /ALTER TABLE "PmWorkItemPropertyValue" ALTER COLUMN "createdAt" SET NOT NULL/i.test(sql),
    ).toBe(true);
  });

  it("ships a partial unique index enforcing at most one ACTIVE cycle per project (WARP-885)", () => {
    // A UNIQUE index on PmCycle(projectId)...
    expect(
      /CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+"PmCycle"\s*\(\s*"projectId"\s*\)/i.test(sql),
      'migration must create a UNIQUE index on PmCycle(projectId)',
    ).toBe(true);
    // ...that is PARTIAL, scoped to active cycles.
    expect(
      /WHERE\s+"status"\s*=\s*'active'/i.test(sql),
      'the unique index must be partial: WHERE "status" = \'active\'',
    ).toBe(true);
    // Dedupe pass precedes the index so it can build even if a project
    // somehow already collected more than one active cycle.
    expect(
      /UPDATE\s+"PmCycle"[\s\S]*?SET\s+"status"\s*=\s*'draft'/i.test(sql),
      'migration must revert pre-existing duplicate active cycles to draft before building the index',
    ).toBe(true);
  });

  it("uses a timestamp strictly greater than the previous migration", () => {
    const stamps = [
      ...new Set(
        readdirSync(MIGRATIONS_DIR)
          .filter((d) => /^\d{14}_/.test(d))
          .map((d) => d.slice(0, 14)),
      ),
    ].sort();
    const stamp = dir.slice(0, 14);
    const idx = stamps.indexOf(stamp);
    expect(idx).toBeGreaterThan(-1);
    if (idx > 0) {
      expect(stamp > stamps[idx - 1]).toBe(true);
    }
  });
});

describe("schema.prisma reflects the hardened PM models", () => {
  it("PmProject and PmWorkItem declare the explicit isArchived column", () => {
    expect(/model PmProject \{[\s\S]*?isArchived\s+Boolean\s+@default\(false\)[\s\S]*?\}/.test(SCHEMA)).toBe(
      true,
    );
    expect(/model PmWorkItem \{[\s\S]*?isArchived\s+Boolean\s+@default\(false\)[\s\S]*?\}/.test(SCHEMA)).toBe(
      true,
    );
  });

  it("PmWorkItem declares the explicit isCompleted column", () => {
    expect(/model PmWorkItem \{[\s\S]*?isCompleted\s+Boolean\s+@default\(false\)[\s\S]*?\}/.test(SCHEMA)).toBe(
      true,
    );
  });

  it("PmWorkItemPropertyValue declares createdAt", () => {
    expect(
      /model PmWorkItemPropertyValue \{[\s\S]*?createdAt\s+DateTime\s+@default\(now\(\)\)[\s\S]*?\}/.test(SCHEMA),
    ).toBe(true);
  });

  it("PmActivityVerb enum declares parent_removed, module_added, module_removed", () => {
    const match = /enum PmActivityVerb \{([\s\S]*?)\}/.exec(SCHEMA);
    expect(match, "PmActivityVerb enum must exist").not.toBeNull();
    const body = match![1];
    expect(body).toContain("parent_removed");
    expect(body).toContain("module_added");
    expect(body).toContain("module_removed");
  });
});
