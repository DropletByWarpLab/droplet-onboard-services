/**
 * ADR-013 — built-in argon2id directory schema regression.
 *
 * Runs against the schema.prisma file text (no DB) to lock the additive
 * greenfield change that makes the local directory the auth source of
 * truth:
 *
 *   - `User.passwordHash String?` — the argon2id PHC string. Nullable
 *     because service-only principals and pre-first-login invitees may
 *     not have one yet; the login route fails closed when it's null.
 *   - `User.email` becomes UNIQUE — email is the stable login key
 *     (Aurora login labels the field "Work email"). Still nullable
 *     (locally-minted rows without an email predate this), but no two
 *     rows may share a non-null email.
 *
 * The migration that backs this must stay additive + idempotent — same
 * posture as the WARP-455 / WARP-485 migrations — because the box is
 * greenfield (wiped + reflashed) and re-running the migration on a
 * converged DB must be a no-op.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, SCHEMA_PATH } from "./helpers/test-paths.js";

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

function userBlock(): string {
  const block = readSchema().match(/model User \{[\s\S]*?\n\}/);
  expect(block).not.toBeNull();
  return block![0];
}

describe("ADR-013 schema: argon2id directory", () => {
  it("User has a nullable passwordHash String column", () => {
    expect(userBlock()).toMatch(/passwordHash\s+String\?/);
  });

  it("User email uniqueness lives on the blind index (WARP-233: email is ciphertext at rest)", () => {
    // ADR-013 made email the stable login key via @unique. WARP-233 encrypts
    // email at rest (GCM ciphertext is non-deterministic, so it cannot carry
    // uniqueness) and moves BOTH the equality lookup and the uniqueness
    // guarantee to emailLookupHash. email itself must stay WITHOUT @unique.
    expect(userBlock()).toMatch(/emailLookupHash\s+String\?\s+@unique/);
    expect(userBlock()).not.toMatch(/email\s+String\?\s+@unique/);
  });

  it("preserves the local User.id UUID as the canonical key (WARP-485)", () => {
    // ADR-013 explicitly keeps the existing UUID PK — JWTs/Redis key on
    // it. Guard against an accidental swap to email-as-PK.
    expect(userBlock()).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)/);
  });

  it("ships an additive, idempotent migration for passwordHash + email-unique", () => {
    // Find the ADR-013 migration by its canonical directory name.
    const dirs = readdirSync(MIGRATIONS_DIR).filter((d) =>
      d.includes("adr_013"),
    );
    expect(dirs.length).toBeGreaterThanOrEqual(1);
    const sql = readFileSync(
      path.join(MIGRATIONS_DIR, dirs[0]!, "migration.sql"),
      "utf-8",
    );
    // Additive column — must use IF NOT EXISTS so a re-run is a no-op.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "passwordHash"/);
    // Unique index on email — must use IF NOT EXISTS for the same reason.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key"/,
    );
    // Greenfield: no data backfill / no UPDATE statements that would
    // touch existing rows' credentials.
    expect(sql).not.toMatch(/UPDATE\s+"User"/i);
  });
});
