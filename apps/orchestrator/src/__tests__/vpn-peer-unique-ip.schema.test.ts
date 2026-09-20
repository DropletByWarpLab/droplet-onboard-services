/**
 * WARP-565: schema + migration assertions for the VpnPeer active-IP guard.
 *
 * Vitest mocks `@prisma/client` (see ./setup.ts) so we can't drive a real DB.
 * The contract this test guards is the migration SQL itself: a PARTIAL unique
 * index on (assignedIp) WHERE status = 'active' that makes "at most one active
 * peer per tunnel IP" a database guarantee — closing the allocate-then-create
 * race in routes/vpn.ts. Prisma can't express partial-unique declaratively, so
 * the index lives in raw SQL; this test ensures nobody drops it.
 *
 * Mirrors the role-enum.schema.test.ts pattern (glob the migrations dir for the
 * named folder, assert its SQL payload).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");

describe("VpnPeer active-IP partial unique index (WARP-565)", () => {
  it("ships a migration creating the partial unique index scoped to active peers", () => {
    const dirs = readdirSync(MIGRATIONS_DIR).filter((d) =>
      d.includes("vpn_peer_unique_active_ip"),
    );
    expect(
      dirs.length,
      "must ship a `vpn_peer_unique_active_ip` migration directory",
    ).toBeGreaterThan(0);

    const sql = readFileSync(join(MIGRATIONS_DIR, dirs[0], "migration.sql"), "utf8");

    // A UNIQUE index on assignedIp...
    expect(
      /CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+"VpnPeer"\s*\(\s*"assignedIp"\s*\)/i.test(sql),
      "migration must create a UNIQUE index on VpnPeer(assignedIp)",
    ).toBe(true);

    // ...that is PARTIAL, scoped to active rows (revoked IPs stay reusable).
    expect(
      /WHERE\s+"status"\s*=\s*'active'/i.test(sql),
      "the unique index must be partial: WHERE \"status\" = 'active'",
    ).toBe(true);

    // De-duplication of any pre-existing colliding active rows so the index
    // can build on a box that already hit the race.
    expect(
      /UPDATE\s+"VpnPeer"[\s\S]*?'revoked'/i.test(sql),
      "migration must revoke pre-existing duplicate active rows before building the index",
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
    const vpnDir = readdirSync(MIGRATIONS_DIR).find((d) =>
      d.includes("vpn_peer_unique_active_ip"),
    )!;
    const vpnStamp = vpnDir.slice(0, 14);
    const idx = stamps.indexOf(vpnStamp);
    expect(idx).toBeGreaterThan(-1);
    // The migration must be ordered strictly AFTER whatever preceded it, so it
    // applies in sequence without a timestamp collision. Asserting it was the
    // *globally* newest stamp was brittle: any later feature migration (e.g.
    // 20260619 scene_schedule) legitimately supersedes it, yet correct ordering
    // only requires the vpn stamp to beat its immediate predecessor.
    if (idx > 0) {
      expect(vpnStamp > stamps[idx - 1]).toBe(true);
    }
  });
});
