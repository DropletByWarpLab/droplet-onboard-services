/**
 * WARP-1474: schema + migration assertions for the dashboard-QR overlay
 * enroll tables.
 *
 * Vitest mocks `@prisma/client` (see ./setup.ts) so we can't drive a real DB.
 * The contract this guards is the migration SQL itself: two staging tables with
 * EXPLICIT CHECK-enum `state` columns (rule 10 — no state derived from a NULL),
 * a unique `tokenHash`, VpnPeer provenance columns, and idempotent DDL so a
 * re-run on a populated box is a no-op.
 *
 * Mirrors the vpn-peer-unique-ip.schema.test.ts pattern (glob the migrations
 * dir for the named folder, assert its SQL payload).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");

function migrationSql(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((d) =>
    d.includes("warp_1474_overlay_qr_enroll"),
  );
  expect(dir, "must ship a `warp_1474_overlay_qr_enroll` migration").toBeTruthy();
  return readFileSync(join(MIGRATIONS_DIR, dir!, "migration.sql"), "utf8");
}

describe("WARP-1474 overlay QR-enroll migration", () => {
  const sql = migrationSql();

  it("creates OverlayLinkToken with a unique tokenHash + CHECK-enum state", () => {
    expect(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"OverlayLinkToken"/i.test(sql)).toBe(true);
    expect(
      /CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+"OverlayLinkToken"\s*\(\s*"tokenHash"\s*\)/i.test(sql),
      "tokenHash must be unique",
    ).toBe(true);
    expect(
      /"OverlayLinkToken_state_check"[\s\S]*?CHECK[\s\S]*?'available'[\s\S]*?'consumed'[\s\S]*?'expired'/i.test(sql),
      "state must be CHECK-pinned to available|consumed|expired",
    ).toBe(true);
  });

  it("creates PendingOverlayEnrollment with a CHECK-enum state", () => {
    expect(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"PendingOverlayEnrollment"/i.test(sql)).toBe(true);
    expect(
      /"PendingOverlayEnrollment_state_check"[\s\S]*?CHECK[\s\S]*?'pending'[\s\S]*?'approved'[\s\S]*?'denied'[\s\S]*?'expired'/i.test(sql),
      "state must be CHECK-pinned to pending|approved|denied|expired",
    ).toBe(true);
  });

  // SEND-BACK #2 — the atomic-approve claim flips pending→approving before the
  // HQ vouch, so the CHECK enum MUST admit 'approving' or the UPDATE 500s on a
  // real box.
  it("admits the 'approving' intermediate claim state (atomic approve)", () => {
    expect(
      /"PendingOverlayEnrollment_state_check"[\s\S]*?CHECK[\s\S]*?'approving'/i.test(sql),
      "state CHECK must include 'approving' for the atomic-approve claim",
    ).toBe(true);
    // Idempotent + re-run-safe: DROP IF EXISTS before ADD so a box that applied
    // the pre-send-back constraint converges to the widened enum on re-run.
    expect(
      /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"PendingOverlayEnrollment_state_check"/i.test(sql),
    ).toBe(true);
  });

  it("adds the VpnPeer provenance columns", () => {
    for (const col of [
      "linkTokenEnrolledBy",
      "linkTokenId",
      "linkTokenLabel",
      "enrolledAt",
    ]) {
      expect(
        new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${col}"`, "i").test(sql),
        `VpnPeer must gain a nullable "${col}" column`,
      ).toBe(true);
    }
  });

  it("is idempotent (IF NOT EXISTS DDL + DO/EXCEPTION guarded CHECK adds)", () => {
    // Every CREATE TABLE / INDEX guards on IF NOT EXISTS.
    expect(/CREATE\s+TABLE\s+"OverlayLinkToken"/i.test(sql)).toBe(false);
    expect(/CREATE\s+TABLE\s+"PendingOverlayEnrollment"/i.test(sql)).toBe(false);
    // CHECK constraint adds are wrapped so a second run doesn't error.
    expect(/EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+null/i.test(sql)).toBe(true);
  });

  it("uses a 14-digit timestamp ordered after its predecessor", () => {
    const stamps = [
      ...new Set(
        readdirSync(MIGRATIONS_DIR)
          .filter((d) => /^\d{14}_/.test(d))
          .map((d) => d.slice(0, 14)),
      ),
    ].sort();
    const dir = readdirSync(MIGRATIONS_DIR).find((d) =>
      d.includes("warp_1474_overlay_qr_enroll"),
    )!;
    const stamp = dir.slice(0, 14);
    const idx = stamps.indexOf(stamp);
    expect(idx).toBeGreaterThan(-1);
    if (idx > 0) expect(stamp > stamps[idx - 1]).toBe(true);
  });
});
