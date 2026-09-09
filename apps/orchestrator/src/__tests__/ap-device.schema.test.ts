/**
 * WARP-446: schema-level assertions for the `ApDevice` model and the
 * `ApDeviceStatus` enum.
 *
 * Mirrors the WARP-171 / WARP-218 schema-shape pattern: vitest's setup
 * mocks `@prisma/client` (see ./setup.ts) so we cannot drive a real DB
 * here. The contract this test guards is the schema text itself + the
 * presence of the matching migration. Anyone reverting the enum to a
 * free-form string column, or removing the migration, will trip this
 * test before they hit the integration phase.
 *
 * Pairs with:
 *   - prisma/schema.prisma (model ApDevice, enum ApDeviceStatus)
 *   - prisma/migrations/20260525120000_warp_446_ap_device/migration.sql
 *   - docs/ADR-005-ap-auto-onboarding.md
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const SCHEMA_PATH = join(PRISMA_DIR, "schema.prisma");
const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");

const schema = readFileSync(SCHEMA_PATH, "utf8");

describe("Prisma schema — ApDeviceStatus enum (WARP-446 AC #3)", () => {
  it("declares the ApDeviceStatus enum with all six state values from ADR-005", () => {
    const enumMatch = schema.match(/enum\s+ApDeviceStatus\s*\{([^}]+)\}/);
    expect(
      enumMatch,
      "ApDeviceStatus enum must be declared in schema.prisma",
    ).not.toBeNull();

    const body = enumMatch![1];
    for (const value of [
      "DISCOVERED",
      "AWAITING_APPROVAL",
      "PROVISIONING",
      "ONLINE",
      "FAILED",
      "DECOMMISSIONED",
    ]) {
      expect(
        new RegExp(`\\b${value}\\b`).test(body),
        `ApDeviceStatus enum must include '${value}'`,
      ).toBe(true);
    }
  });
});

describe("Prisma schema — ApDevice model (WARP-446 AC #3, #5)", () => {
  it("declares the ApDevice model with mac as the primary key (canonical normalized MAC)", () => {
    const modelMatch = schema.match(/model\s+ApDevice\s*\{([\s\S]+?)\}\s*(?=\nenum|\nmodel|$)/);
    expect(modelMatch, "ApDevice model must exist").not.toBeNull();

    const body = modelMatch![1];
    // mac is the primary key — same convention as NetworkDevice from
    // WARP-80. Normalized at every boundary via normalizeMac().
    expect(body).toMatch(/mac\s+String\s+@id/);
    // status uses the enum (no free-form String). CLAUDE.md no-guessing
    // rule explicitly forbids derived state.
    expect(body).toMatch(/status\s+ApDeviceStatus/);
    expect(body).toMatch(/@default\(DISCOVERED\)/);
  });

  it("includes the audit + lifecycle columns the decommission flow needs (AC #5)", () => {
    const modelMatch = schema.match(/model\s+ApDevice\s*\{([\s\S]+?)\}\s*(?=\nenum|\nmodel|$)/);
    const body = modelMatch![1];
    // Approval audit trail — operator (Nextcloud username) + timestamp.
    expect(body).toMatch(/approvedAt\s+DateTime\?/);
    expect(body).toMatch(/approvedBy\s+String\?/);
    // Decommission terminal state — explicit timestamp, not derived.
    expect(body).toMatch(/decommissionedAt\s+DateTime\?/);
    // Failure surface for the dashboard "what went wrong" tile.
    expect(body).toMatch(/failureReason\s+String\?/);
    // Operation-Id resume so dashboard polling survives refresh.
    expect(body).toMatch(/lastOperationId\s+String\?/);
  });

  it("indexes status + lastSeen so the dashboard's discovery + stale-AP queries stay direct", () => {
    const modelMatch = schema.match(/model\s+ApDevice\s*\{([\s\S]+?)\}\s*(?=\nenum|\nmodel|$)/);
    const body = modelMatch![1];
    expect(body).toMatch(/@@index\(\[status\]\)/);
    expect(body).toMatch(/@@index\(\[lastSeen\]\)/);
  });
});

describe("Prisma schema — ApOnboardBackend enum (ADR-024 Phase 1)", () => {
  it("declares the ApOnboardBackend enum with the three backend values", () => {
    const enumMatch = schema.match(/enum\s+ApOnboardBackend\s*\{([^}]+)\}/);
    expect(
      enumMatch,
      "ApOnboardBackend enum must be declared in schema.prisma",
    ).not.toBeNull();

    const body = enumMatch![1];
    for (const value of ["DROPLET_IMAGE", "EASYMESH", "UNIFI"]) {
      expect(
        new RegExp(`\\b${value}\\b`).test(body),
        `ApOnboardBackend enum must include '${value}'`,
      ).toBe(true);
    }
  });

  it("adds backend/backendRef/vendor to ApDevice with an explicit DROPLET_IMAGE default (no state-from-absence)", () => {
    const modelMatch = schema.match(/model\s+ApDevice\s*\{([\s\S]+?)\}\s*(?=\nenum|\nmodel|$)/);
    const body = modelMatch![1];
    // backend is an explicit enum column with a default — NOT derived
    // from a nullable absence (CLAUDE.md no-guessing rule, same as status).
    expect(body).toMatch(/backend\s+ApOnboardBackend\s+@default\(DROPLET_IMAGE\)/);
    // backendRef + vendor are nullable additive columns.
    expect(body).toMatch(/backendRef\s+String\?/);
    expect(body).toMatch(/vendor\s+String\?/);
  });
});

describe("Prisma migration — ADR-024 Phase 1 (ApOnboardBackend)", () => {
  it("ships a migration that creates the enum + adds the columns idempotently", () => {
    const dirs = readdirSync(MIGRATIONS_DIR);
    const ours = dirs.find((d) => d.endsWith("adr_024_ap_onboard_backend"));
    expect(ours, "expected an ADR-024 ap-onboard-backend migration directory").toBeDefined();

    const sql = readFileSync(join(MIGRATIONS_DIR, ours!, "migration.sql"), "utf8");
    // Idempotent enum creation pattern — mirror of WARP-446 / WARP-845.
    expect(sql).toMatch(/CREATE TYPE "ApOnboardBackend"/);
    expect(sql).toMatch(/EXCEPTION/i);
    // Additive columns guarded with IF NOT EXISTS so a second migrate run
    // on a converged DB is a no-op.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "backend"\s+"ApOnboardBackend"/);
    expect(sql).toMatch(/DEFAULT 'DROPLET_IMAGE'/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "backendRef"/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "vendor"/);
  });
});

describe("Prisma migration — WARP-446 (AC #3)", () => {
  it("ships a migration that creates the table + the enum", () => {
    const dirs = readdirSync(MIGRATIONS_DIR);
    const ours = dirs.find((d) => d.endsWith("warp_446_ap_device"));
    expect(ours, "expected a WARP-446 migration directory").toBeDefined();

    const sql = readFileSync(join(MIGRATIONS_DIR, ours!, "migration.sql"), "utf8");
    // Idempotent enum creation pattern — mirror of WARP-171 / WARP-218.
    expect(sql).toMatch(/CREATE TYPE "ApDeviceStatus"/);
    expect(sql).toMatch(/EXCEPTION/i);
    // Idempotent table creation so a second prisma migrate dev run doesn't
    // fail in CI on a converged DB.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "ApDevice"/);
    // Indexes guarded with IF NOT EXISTS for the same reason.
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "ApDevice_status_idx"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "ApDevice_lastSeen_idx"/);
  });
});
