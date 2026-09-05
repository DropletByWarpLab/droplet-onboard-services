/**
 * WARP-455 — GuestExpiry schema regression.
 *
 * Guests are time-boxed: every guest User has at most one GuestExpiry
 * row carrying an expiresAt timestamp and an explicit status enum. The
 * nightly cron walks GuestExpiry rows and flips ACTIVE → EXPIRED when
 * `expiresAt < now()`, then denylists the user's JWT and emits an
 * ActivityRow.
 *
 * Per the no-guessing rule (CLAUDE.md), status MUST be an explicit
 * Prisma enum. Deriving "is this guest expired" from `expiresAt < now()`
 * at read time would (a) duplicate the derivation rule across every
 * reader and (b) leak the cron's tick cadence into UX (a guest is only
 * "expired" once the cron has actually denylisted their session).
 *
 * Status values:
 *   - ACTIVE   — the guest's session is live; the cron has not flipped
 *                them yet.
 *   - EXPIRED  — the cron has run AFTER expiresAt and denylisted the
 *                guest's JWT. Terminal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SCHEMA_PATH } from "./helpers/test-paths.js";

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

describe("WARP-455 schema: GuestExpiry", () => {
  it("declares a GuestExpiryStatus enum with exactly ACTIVE and EXPIRED", () => {
    const schema = readSchema();
    const block = schema.match(/enum GuestExpiryStatus \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\bACTIVE\b/);
    expect(block![0]).toMatch(/\bEXPIRED\b/);
  });

  it("declares a GuestExpiry model", () => {
    expect(readSchema()).toMatch(/^model GuestExpiry \{/m);
  });

  it("GuestExpiry.status is the GuestExpiryStatus enum defaulting to ACTIVE", () => {
    const schema = readSchema();
    const block = schema.match(/model GuestExpiry \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/status\s+GuestExpiryStatus\s+@default\(ACTIVE\)/);
    expect(block![0]).not.toMatch(/\bstatus\s+String\b/);
  });

  it("GuestExpiry.userId is unique (one expiry row per guest user)", () => {
    const schema = readSchema();
    const block = schema.match(/model GuestExpiry \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/userId\s+String\s+@unique/);
  });

  it("GuestExpiry has an index on expiresAt for the nightly sweep", () => {
    // The cron query is `WHERE status = ACTIVE AND expiresAt < now()`.
    // An index on expiresAt keeps that scan cheap as the table grows.
    const schema = readSchema();
    const block = schema.match(/model GuestExpiry \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/@@index\(\[expiresAt\]\)/);
  });

  it("User.guestExpiry reverse relation is declared", () => {
    const schema = readSchema();
    const userBlock = schema.match(/model User \{[\s\S]*?\n\}/);
    expect(userBlock).not.toBeNull();
    expect(userBlock![0]).toMatch(/guestExpiry\s+GuestExpiry\?/);
  });
});
