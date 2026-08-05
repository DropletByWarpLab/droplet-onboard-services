/**
 * WARP-1732 — schema-level assertions for the `FabricMember` model.
 *
 * Same shape as `ap-device.schema.test.ts`: vitest's setup mocks
 * `@prisma/client`, so there is no DB here. What this file guards is the
 * schema text plus the presence and idempotence of the matching migration —
 * a text-regression guard that trips in the DB-less lane rather than in the
 * pg-integration phase.
 *
 * The invariants below are the ones a well-meaning future edit is most
 * likely to "tidy away", and each one has a reason in ADR-035:
 *   - the anchor MAC is the primary key (§2), not an id + unique;
 *   - `role` is a bare String and must NOT become an enum (§5 — roles grow);
 *   - PoE columns are nullable Ints (null = not advertised ≠ 0 ports);
 *   - the migration seeds nothing and re-runs clean.
 *
 * Pairs with:
 *   - prisma/schema.prisma (model FabricMember)
 *   - prisma/migrations/20260805000000_warp_1732_fabric_member/migration.sql
 *   - src/services/fabric-member-reconciler.ts
 *   - docs/ADR-035-network-fabric.md §2, §5, §6
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function findPrismaDir(): string {
  const candidates = [
    join(process.cwd(), "prisma"),
    join(process.cwd(), "apps", "orchestrator", "prisma"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "schema.prisma"))) {
      return resolve(candidate);
    }
  }
  throw new Error(
    `Could not locate prisma/schema.prisma from ${process.cwd()} — tried ${candidates.join(", ")}`,
  );
}

const PRISMA_DIR = findPrismaDir();
const schema = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");
const MIGRATION_DIR = join(
  PRISMA_DIR,
  "migrations",
  "20260805000000_warp_1732_fabric_member",
);

function fabricMemberBlock(): string {
  const match = schema.match(/model\s+FabricMember\s*\{([\s\S]*?)\n\}/);
  expect(match, "model FabricMember must exist in schema.prisma").toBeTruthy();
  return match![1];
}

describe("Prisma schema — FabricMember (WARP-1732)", () => {
  it("keys on the anchor MAC as the PRIMARY KEY (ADR-035 §2)", () => {
    // Not `id String @id` + `@unique` on the MAC: the MAC IS the identity,
    // and a surrogate key would let the same device land twice.
    expect(fabricMemberBlock()).toMatch(/anchorMac\s+String\s+@id/);
  });

  it("stores role as a bare String — NOT an enum (ADR-035 §5: roles grow)", () => {
    expect(fabricMemberBlock()).toMatch(/^\s*role\s+String\s*$/m);
    // A `FabricRole` enum would mean the routing service cannot start
    // announcing a new role without a migration — the exact coupling §5
    // rules out.
    expect(schema).not.toMatch(/enum\s+FabricRole\b/);
  });

  it("carries the observed facts as nullable columns", () => {
    const block = fabricMemberBlock();
    for (const col of ["model", "version", "lastIp", "hostname"]) {
      expect(block).toMatch(new RegExp(`^\\s*${col}\\s+String\\?`, "m"));
    }
  });

  it("stores PoE facts as nullable Ints — null means 'not advertised', never 0", () => {
    const block = fabricMemberBlock();
    expect(block).toMatch(/^\s*poePorts\s+Int\?/m);
    expect(block).toMatch(/^\s*poeBudget\s+Int\?/m);
  });

  it("carries firstSeen + lastSeen, the ADR-035 §6 staleness signal", () => {
    const block = fabricMemberBlock();
    expect(block).toMatch(/^\s*firstSeen\s+DateTime\s+@default\(now\(\)\)/m);
    expect(block).toMatch(/^\s*lastSeen\s+DateTime\s+@default\(now\(\)\)/m);
    // Reads are most-recently-seen-first and the staleness question is a
    // range scan on lastSeen.
    expect(block).toMatch(/@@index\(\[lastSeen\]\)/);
  });

  it("does NOT carry a lifecycle status column — ApDevice owns AP lifecycle", () => {
    // Observations only. A `status` here would be a second, derived state
    // machine racing ADR-005's, which is the drift ADR-035 argues against.
    expect(fabricMemberBlock()).not.toMatch(/^\s*status\s+/m);
  });
});

describe("Migration 20260805000000_warp_1732_fabric_member", () => {
  const sql = existsSync(join(MIGRATION_DIR, "migration.sql"))
    ? readFileSync(join(MIGRATION_DIR, "migration.sql"), "utf8")
    : "";

  it("exists, following the recent-migration naming convention", () => {
    expect(existsSync(join(MIGRATION_DIR, "migration.sql"))).toBe(true);
  });

  it("creates the table and both indexes idempotently, so a re-run is a no-op", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "FabricMember"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "FabricMember_role_idx"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "FabricMember_lastSeen_idx"/);
  });

  it("seeds no rows — there is no seed row-count that could drift on re-run", () => {
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("is purely additive — it alters and drops nothing", () => {
    // ApDevice in particular must come through untouched.
    expect(sql).not.toMatch(/\bALTER TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });
});
