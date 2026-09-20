/**
 * Onboarding SSO (Google / Entra OIDC) — schema regression. Refs ADR-013.
 *
 * Runs against the schema.prisma file text (no DB) to lock the additive
 * change that backs external-IdP sign-in. Two new models:
 *
 *   - `SsoIdentity` — links an external IdP identity (provider + `sub`) to
 *     a LOCAL `User.id`. `@@unique([provider, subject])` so one IdP
 *     identity maps to exactly one local user (an auth ambiguity
 *     otherwise). `userId` is a FK to `User` — the linking preserves the
 *     existing `User.id` UUID (no email-as-PK swap), consistent with
 *     ADR-013 / WARP-485.
 *   - `SsoLoginState` — server-side, single-use, time-bound `state` +
 *     `nonce` + PKCE verifier persisted between /authorize and /callback.
 *     `consumedAt` marks single-use (same shape as UserInvite.acceptedAt,
 *     the established single-use idiom in this codebase); `expiresAt`
 *     time-bounds it. CSRF (`state`) and replay (`nonce`) defence both
 *     live here so the cookie only has to carry an opaque handle.
 *
 * Per the ticket AC, per-provider CONFIG (issuer / clientId / clientSecret
 * / redirect) comes from env (config.ts `DROPLET_SSO_*`), NOT a DB model —
 * so there is deliberately no `SsoConnection` table (the scaffold sketched
 * one; the AC overrides it with "reuse existing config/env").
 *
 * The migration that backs this must stay additive + idempotent — same
 * posture as the ADR-013 / WARP-613 migrations — because the box is
 * greenfield (wiped + reflashed) and re-running on a converged DB must be
 * a no-op.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, SCHEMA_PATH } from "./helpers/test-paths.js";

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

function modelBlock(name: string): string {
  const block = readSchema().match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
  expect(block, `model ${name} should exist in schema.prisma`).not.toBeNull();
  return block![0];
}

describe("SSO OIDC schema: SsoIdentity", () => {
  it("links provider + subject to a local User.id (FK), preserving the UUID", () => {
    const block = modelBlock("SsoIdentity");
    expect(block).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)/);
    expect(block).toMatch(/userId\s+String/);
    expect(block).toMatch(/provider\s+String/);
    expect(block).toMatch(/subject\s+String/);
    // Relation back to User so the link is referential, not free-floating.
    expect(block).toMatch(/user\s+User\s+@relation/);
  });

  it("is unique on (provider, subject) — one IdP identity → one local user", () => {
    expect(modelBlock("SsoIdentity")).toMatch(/@@unique\(\[provider,\s*subject\]\)/);
  });

  it("User gains the back-relation to SsoIdentity", () => {
    expect(modelBlock("User")).toMatch(/ssoIdentities\s+SsoIdentity\[\]/);
  });

  it("does NOT introduce an email-as-PK swap on User (UUID preserved)", () => {
    expect(modelBlock("User")).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)/);
  });
});

describe("SSO OIDC schema: SsoLoginState (single-use, time-bound CSRF/nonce)", () => {
  it("persists state, nonce, and the PKCE code verifier server-side", () => {
    const block = modelBlock("SsoLoginState");
    expect(block).toMatch(/state\s+String\s+@unique/);
    expect(block).toMatch(/nonce\s+String/);
    expect(block).toMatch(/codeVerifier\s+String/);
    expect(block).toMatch(/provider\s+String/);
  });

  it("is single-use (consumedAt) and time-bound (expiresAt)", () => {
    const block = modelBlock("SsoLoginState");
    expect(block).toMatch(/consumedAt\s+DateTime\?/);
    expect(block).toMatch(/expiresAt\s+DateTime/);
  });

  it("does NOT persist any IdP secret or token on the login-state row", () => {
    const block = modelBlock("SsoLoginState");
    expect(block).not.toMatch(/clientSecret/i);
    expect(block).not.toMatch(/accessToken/i);
    expect(block).not.toMatch(/idToken/i);
  });
});

describe("SSO OIDC schema: config stays in env, not the DB", () => {
  it("does NOT add an SsoConnection table (per-provider config is env-only)", () => {
    expect(readSchema()).not.toMatch(/model\s+SsoConnection\s*\{/);
  });
});

describe("SSO OIDC schema: additive, idempotent migration", () => {
  function migrationSql(): string {
    const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.includes("sso_oidc"));
    expect(dirs.length, "an *_sso_oidc migration directory should exist").toBeGreaterThanOrEqual(1);
    return readFileSync(path.join(MIGRATIONS_DIR, dirs[0]!, "migration.sql"), "utf-8");
  }

  it("creates both tables with IF NOT EXISTS so a re-run is a no-op", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "SsoIdentity"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "SsoLoginState"/);
  });

  it("creates the unique indexes with IF NOT EXISTS", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "SsoIdentity_provider_subject_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "SsoLoginState_state_key"/);
  });

  it("does not backfill or mutate existing User rows", () => {
    expect(migrationSql()).not.toMatch(/UPDATE\s+"User"/i);
  });
});
