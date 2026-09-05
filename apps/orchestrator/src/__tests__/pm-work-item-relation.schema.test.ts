/**
 * WARP-2586 (ADR-045 slice G) — schema + migration assertions for
 * PmWorkItemRelation and the same-project parenting trigger.
 *
 * Vitest mocks @prisma/client (see ./setup.ts), so these tests guard the
 * migration SQL and schema.prisma content directly. Same pattern as
 * pm-schema-hardening.schema.test.ts and vpn-peer-unique-ip.schema.test.ts —
 * this repo's established way of covering the class of invariant that
 * `prisma db push` silently skips, because CHECK constraints and triggers live
 * only in migration SQL and a datamodel push never runs them.
 *
 * The BEHAVIOUR of those constraints is proven against a real Postgres in
 * pm-work-item-relation.pg.test.ts. This file proves they are still SHIPPED.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// WARP-2654: paths are anchored to the owning file, never to the runner's
// cwd — the guard in test-paths.guard.test.ts refuses cwd-relative lookups.
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

const SCHEMA = readSchema();

function findMigrationDir(needle: string): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.includes(needle));
  expect(dirs.length, `must ship a migration directory matching "${needle}"`).toBeGreaterThan(0);
  return dirs[0];
}

const DIR = findMigrationDir("warp_2586_pm_work_item_relation");
const SQL = readFileSync(join(MIGRATIONS_DIR, DIR, "migration.sql"), "utf8");

describe("PmWorkItemRelation migration (WARP-2586)", () => {
  it("creates the PmRelationKind enum with exactly the three kinds", () => {
    expect(
      /CREATE TYPE "PmRelationKind" AS ENUM \('BLOCKS', 'RELATES', 'DUPLICATES'\)/.test(SQL),
    ).toBe(true);
  });

  it("creates the table with both ends CASCADE — an edge with one end missing is not an edge", () => {
    expect(/CREATE TABLE "PmWorkItemRelation"/.test(SQL)).toBe(true);
    for (const col of ["fromId", "toId"]) {
      expect(
        new RegExp(
          `ALTER TABLE "PmWorkItemRelation" ADD CONSTRAINT "PmWorkItemRelation_${col}_fkey"[\\s\\S]*?ON DELETE CASCADE`,
        ).test(SQL),
        `${col} must cascade`,
      ).toBe(true);
    }
  });

  it("indexes BOTH directions — an unindexed FK is the WARP-845 hazard", () => {
    expect(
      /CREATE UNIQUE INDEX "PmWorkItemRelation_fromId_toId_kind_key" ON "PmWorkItemRelation"\("fromId", "toId", "kind"\)/.test(
        SQL,
      ),
    ).toBe(true);
    expect(
      /CREATE INDEX "PmWorkItemRelation_fromId_kind_idx" ON "PmWorkItemRelation"\("fromId", "kind"\)/.test(
        SQL,
      ),
    ).toBe(true);
    expect(
      /CREATE INDEX "PmWorkItemRelation_toId_kind_idx" ON "PmWorkItemRelation"\("toId", "kind"\)/.test(
        SQL,
      ),
    ).toBe(true);
  });

  it("forbids a self-edge with a CHECK", () => {
    expect(
      /ADD CONSTRAINT "PmWorkItemRelation_no_self_edge"\s*CHECK \("fromId" <> "toId"\)/.test(SQL),
    ).toBe(true);
  });

  it("pins the symmetric canonical order, and pins the COLLATION it compares in", () => {
    // The collation is not decoration. The service canonicalises with
    // JavaScript `<` (UTF-16 code-unit order); plain Postgres text `<` follows
    // the database collation, and an ICU collation orders punctuation
    // differently — so on such a cluster the service would write an ordering
    // this constraint rejects. COLLATE "C" makes both sides byte order.
    expect(/ADD CONSTRAINT "PmWorkItemRelation_symmetric_canonical_order"/.test(SQL)).toBe(true);
    expect(
      /CHECK \("kind" = 'BLOCKS' OR "fromId" COLLATE "C" < "toId" COLLATE "C"\)/.test(SQL),
      'the canonical-order CHECK must compare COLLATE "C", or it disagrees with the service on an ICU-collated cluster',
    ).toBe(true);
  });

  it("extends PmActivityVerb with relation_added / relation_removed, idempotently", () => {
    for (const verb of ["relation_added", "relation_removed"]) {
      expect(new RegExp(`ALTER TYPE "PmActivityVerb" ADD VALUE '${verb}'`).test(SQL)).toBe(true);
      expect(
        new RegExp(`enumlabel = '${verb}'`).test(SQL),
        `${verb} must be added behind the pg_enum existence guard`,
      ).toBe(true);
    }
  });

  it("never USES a verb it added in the same transaction", () => {
    // Postgres refuses to use an enum value added by ALTER TYPE inside the
    // same transaction, and Prisma applies a migration file in one. The repair
    // pass therefore writes 'parent_removed', committed by the WARP-884/885
    // migration — not one of the two values added above.
    expect(/'parent_removed'::"PmActivityVerb"/.test(SQL)).toBe(true);
    expect(/'relation_added'::"PmActivityVerb"/.test(SQL)).toBe(false);
    expect(/'relation_removed'::"PmActivityVerb"/.test(SQL)).toBe(false);
  });
});

describe("same-project parenting is enforced by a TRIGGER, and the repair runs first (WARP-2586)", () => {
  it("audits every repaired row BEFORE nulling it — the promotion is never silent", () => {
    expect(
      /INSERT INTO "PmActivity"[\s\S]*?'parent_removed'::"PmActivityVerb"[\s\S]*?FROM "PmWorkItem" c[\s\S]*?WHERE c\."projectId" <> p\."projectId"/.test(
        SQL,
      ),
      "the repair pass must write one parent_removed row per repaired child before the UPDATE",
    ).toBe(true);
    const auditAt = SQL.indexOf('INSERT INTO "PmActivity"');
    const repairAt = SQL.indexOf('UPDATE "PmWorkItem" c');
    expect(auditAt).toBeGreaterThan(-1);
    expect(repairAt).toBeGreaterThan(auditAt);
  });

  it("installs the guard as a trigger, not a CHECK — a CHECK cannot contain a subquery", () => {
    expect(/CREATE OR REPLACE FUNCTION pmworkitem_enforce_parent_same_project\(\)/.test(SQL)).toBe(
      true,
    );
    expect(/DROP TRIGGER IF EXISTS pmworkitem_parent_same_project ON "PmWorkItem"/.test(SQL)).toBe(
      true,
    );
    expect(
      /CREATE TRIGGER pmworkitem_parent_same_project\s*BEFORE INSERT OR UPDATE OF "parentId", "projectId" ON "PmWorkItem"/.test(
        SQL,
      ),
      "the trigger must fire on both parentId and projectId writes — the invariant breaks from either side",
    ).toBe(true);
    expect(/ERRCODE = 'check_violation'/.test(SQL)).toBe(true);
  });

  it("uses a timestamp strictly greater than the previous migration", () => {
    const stamps = [
      ...new Set(
        readdirSync(MIGRATIONS_DIR)
          .filter((d) => /^\d{14}_/.test(d))
          .map((d) => d.slice(0, 14)),
      ),
    ].sort();
    const stamp = DIR.slice(0, 14);
    const idx = stamps.indexOf(stamp);
    expect(idx).toBeGreaterThan(-1);
    if (idx > 0) expect(stamp > stamps[idx - 1]).toBe(true);
  });
});

describe("schema.prisma declares the relation model (WARP-2586)", () => {
  it("declares PmRelationKind with the three kinds", () => {
    const match = /enum PmRelationKind \{([\s\S]*?)\}/.exec(SCHEMA);
    expect(match, "PmRelationKind enum must exist").not.toBeNull();
    for (const k of ["BLOCKS", "RELATES", "DUPLICATES"]) expect(match![1]).toContain(k);
  });

  it("declares PmWorkItemRelation with the unique triple and both directional indexes", () => {
    const match = /model PmWorkItemRelation \{([\s\S]*?)\n\}/.exec(SCHEMA);
    expect(match, "PmWorkItemRelation model must exist").not.toBeNull();
    const body = match![1];
    expect(body).toContain("@@unique([fromId, toId, kind])");
    expect(body).toContain("@@index([fromId, kind])");
    expect(body).toContain("@@index([toId, kind])");
    // Cascade on both ends, so the datamodel and the migration agree and
    // `migrate diff` reports no drift.
    expect((body.match(/onDelete: Cascade/g) ?? []).length).toBe(2);
  });

  it("PmWorkItem carries both back-relations, so the read can match on either end", () => {
    const match = /model PmWorkItem \{([\s\S]*?)\n\}/.exec(SCHEMA);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('@relation("PmRelationFrom")');
    expect(match![1]).toContain('@relation("PmRelationTo")');
  });

  it("PmActivityVerb declares relation_added and relation_removed", () => {
    const match = /enum PmActivityVerb \{([\s\S]*?)\}/.exec(SCHEMA);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("relation_added");
    expect(match![1]).toContain("relation_removed");
  });
});
