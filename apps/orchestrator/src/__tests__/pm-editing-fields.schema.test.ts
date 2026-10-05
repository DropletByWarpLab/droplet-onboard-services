/**
 * WARP-3520 (ADR-069 WS-4) — schema + migration assertions for the work item's
 * KIND (`type`), its `estimate`, and the four activity verbs that describe them.
 *
 * Vitest mocks @prisma/client (see ./setup.ts), so this guards the migration SQL
 * and schema.prisma text directly — the repo's established way of covering the
 * class of invariant `prisma db push` silently skips (a CHECK lives only in
 * migration SQL). The BEHAVIOUR of the CHECK is proven against a real Postgres
 * in pm-editing-fields.pg.test.ts; this file proves it is still SHIPPED.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

const SCHEMA = readSchema();

const DIR = readdirSync(MIGRATIONS_DIR).filter((d) => d.endsWith("_warp_3520_pm_editing_fields"));
const SQL = readFileSync(join(MIGRATIONS_DIR, DIR[0] ?? "missing", "migration.sql"), "utf8");

describe("PmWorkItem type + estimate migration (WARP-3520)", () => {
  it("ships exactly one migration folder, at the slice's reserved timestamp", () => {
    expect(DIR).toEqual(["20261004130000_warp_3520_pm_editing_fields"]);
  });

  it("creates PmWorkItemType with the six kinds, in the order the dashboard lists them", () => {
    expect(
      /CREATE TYPE "PmWorkItemType" AS ENUM \('task', 'bug', 'feature', 'improvement', 'question', 'incident'\)/.test(
        SQL,
      ),
    ).toBe(true);
    expect(/enum PmWorkItemType \{\s*task\s*bug\s*feature\s*improvement\s*question\s*incident\s*\}/.test(SCHEMA)).toBe(
      true,
    );
  });

  it("adds type as NOT NULL DEFAULT 'task' so existing rows keep a meaning without a backfill", () => {
    expect(/ADD COLUMN "type" "PmWorkItemType" NOT NULL DEFAULT 'task'/.test(SQL)).toBe(true);
    expect(/type\s+PmWorkItemType\s+@default\(task\)/.test(SCHEMA)).toBe(true);
  });

  it("adds estimate as a NULLABLE, default-less double — NULL means not estimated, which is not 0", () => {
    // The `;` straight after the type is the assertion: no NOT NULL, no DEFAULT.
    expect(/ADD COLUMN IF NOT EXISTS "estimate" DOUBLE PRECISION;/.test(SQL)).toBe(true);
    expect(/estimate\s+Float\?/.test(SCHEMA)).toBe(true);
  });

  it("declares estimate idempotently and exactly as WARP-3521 does, so the two slices land in either order", () => {
    // WARP-3521 (cycles / modules) reads this column and declares it with the same
    // IF NOT EXISTS statement and the same schema line. A plain ADD COLUMN here
    // would fail on a database that ran that migration first; a differently
    // aligned or differently placed schema line would merge into a duplicate field.
    expect(/ADD COLUMN "estimate"/.test(SQL), "a plain ADD COLUMN would fail when the column exists").toBe(false);
    expect(/^ {2}estimate {8}Float\?$/m.test(SCHEMA)).toBe(true);
    expect(SCHEMA.match(/^ {2}estimate\s+Float\?$/gm)).toHaveLength(1);
  });

  it("bounds estimate with a CHECK, so a non-route writer cannot store a negative or absurd size", () => {
    expect(
      /ADD CONSTRAINT "PmWorkItem_estimate_range"\s*CHECK \("estimate" IS NULL OR \("estimate" >= 0 AND "estimate" <= 1000\)\)/.test(
        SQL,
      ),
    ).toBe(true);
  });

  it("extends PmActivityVerb with the four WS-4 verbs, idempotently", () => {
    for (const verb of ["start_date_changed", "type_changed", "estimate_changed", "property_changed"]) {
      expect(
        new RegExp(`ALTER TYPE "PmActivityVerb" ADD VALUE IF NOT EXISTS '${verb}'`).test(SQL),
        `${verb} must be added by the migration`,
      ).toBe(true);
      expect(new RegExp(`^\\s+${verb}$`, "m").test(SCHEMA), `${verb} must be in schema.prisma`).toBe(true);
    }
  });

  it("never USES a verb it added in the same transaction", () => {
    // Postgres refuses to use an enum value added by ALTER TYPE in the
    // transaction that added it, and Prisma applies a migration file in one.
    // That is why this slice needs no enum-only migration: nothing below the
    // ALTER TYPEs reads or writes them.
    for (const verb of ["start_date_changed", "type_changed", "estimate_changed", "property_changed"]) {
      expect(new RegExp(`'${verb}'::"PmActivityVerb"`).test(SQL)).toBe(false);
      expect(new RegExp(`INSERT INTO "PmActivity"[\\s\\S]*'${verb}'`).test(SQL)).toBe(false);
    }
  });
});
