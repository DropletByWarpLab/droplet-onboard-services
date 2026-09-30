/**
 * Native SSO handoff (RFC 8252) — schema-level assertions for the columns the
 * native Windows client's SSO leg adds to `SsoLoginState`.
 *
 * The box stays the confidential OIDC client and the IdP-registered redirect
 * URI does not change (ADR-016). A NATIVE row carries the app's own redirect
 * (loopback or `droplet://sso/callback`) and PKCE challenge; the callback
 * parks a one-time handoff code on it (sha256 only) instead of setting
 * browser cookies, and `/sso/oidc/native/token` redeems it once.
 *
 * Which leg a row finishes on is an EXPLICIT enum column (`flowKind`), never
 * derived from `nativeRedirectUri IS NULL` (CLAUDE.md "No guessing, ever"),
 * and a raw-SQL CHECK pins that a NATIVE row always has its redirect and
 * challenge.
 *
 * Same pattern as device-clients.clientdispatch-schema.test.ts: setup.ts mocks
 * `@prisma/client`, so the contract guarded here is the schema text plus the
 * matching additive migration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const schema = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");
const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");
const MIGRATION_SUFFIX = "_sso_native_handoff";

function ssoLoginStateBody(): string {
  const m = schema.match(/model\s+SsoLoginState\s*\{([\s\S]+?)\n\}/);
  expect(m, "SsoLoginState model must exist in schema.prisma").not.toBeNull();
  return m![1]!;
}

function migrationSql(): { dir: string; sql: string } {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.endsWith(MIGRATION_SUFFIX));
  expect(dirs, "exactly one sso_native_handoff migration").toHaveLength(1);
  const dir = dirs[0]!;
  return { dir, sql: readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8") };
}

describe("Prisma schema — SsoLoginState native handoff", () => {
  it("declares the SsoFlowKind enum with exactly BROWSER and NATIVE", () => {
    const m = schema.match(/enum\s+SsoFlowKind\s*\{([\s\S]+?)\}/);
    expect(m, "enum SsoFlowKind must exist").not.toBeNull();
    const values = m![1]!
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter(Boolean);
    expect(values).toEqual(["BROWSER", "NATIVE"]);
  });

  it("carries the flow kind as an explicit enum column defaulting to BROWSER", () => {
    expect(ssoLoginStateBody()).toMatch(/flowKind\s+SsoFlowKind\s+@default\(BROWSER\)/);
  });

  it("adds the native redirect + PKCE challenge and the handoff columns", () => {
    const body = ssoLoginStateBody();
    expect(body).toMatch(/nativeRedirectUri\s+String\?/);
    expect(body).toMatch(/nativeCodeChallenge\s+String\?/);
    // Only the sha256 of the handoff code is stored; unique so redemption is a
    // point lookup and two rows can never share a code.
    expect(body).toMatch(/handoffCodeHash\s+String\?\s+@unique/);
    // The consent value the page carries (ADR-063 S5): hashed, unique, set by the
    // callback and cleared when Continue claims it. No code exists before that.
    expect(body).toMatch(/nativeConsentHash\s+String\?\s+@unique/);
    expect(body).toMatch(/handoffUserId\s+String\?/);
    expect(body).toMatch(/handoffExpiresAt\s+DateTime\?/);
    expect(body).toMatch(/handoffConsumedAt\s+DateTime\?/);
  });

  it("keeps the existing browser-flow columns untouched", () => {
    const body = ssoLoginStateBody();
    expect(body).toMatch(/state\s+String\s+@unique/);
    expect(body).toMatch(/returnTo\s+String\s+@default\("\/"\)/);
    expect(body).toMatch(/consumedAt\s+DateTime\?/);
    expect(body).toMatch(/@@index\(\[expiresAt\]\)/);
  });
});

describe("Prisma migration — sso_native_handoff (additive, idempotent)", () => {
  it("replays after the ADR-013 migration that creates SsoLoginState", () => {
    const { dir } = migrationSql();
    expect(dir > "20260531130000_adr_013_sso_oidc").toBe(true);
  });

  it("creates the enum and adds the columns without rewriting existing rows", () => {
    const { sql } = migrationSql();
    expect(sql).toMatch(/CREATE TYPE "SsoFlowKind" AS ENUM \('BROWSER', 'NATIVE'\)/);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "flowKind" "SsoFlowKind" NOT NULL DEFAULT 'BROWSER'/,
    );
    for (const [col, type] of [
      ["nativeRedirectUri", "TEXT"],
      ["nativeCodeChallenge", "TEXT"],
      ["nativeConsentHash", "TEXT"],
      ["handoffCodeHash", "TEXT"],
      ["handoffUserId", "TEXT"],
      ["handoffExpiresAt", "TIMESTAMP\\(3\\)"],
      ["handoffConsumedAt", "TIMESTAMP\\(3\\)"],
    ] as const) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${col}" ${type}(,|;|\\s)`));
    }
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "SsoLoginState_handoffCodeHash_key"\s+ON "SsoLoginState"\("handoffCodeHash"\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "SsoLoginState_nativeConsentHash_key"\s+ON "SsoLoginState"\("nativeConsentHash"\)/,
    );
    // No UPDATE / DELETE against existing login-state rows.
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE)\b/im);
  });

  it("pins with a CHECK that a NATIVE row always has its redirect and challenge", () => {
    const { sql } = migrationSql();
    expect(sql).toMatch(/"SsoLoginState_native_fields_check"/);
    expect(sql).toMatch(
      /CHECK \(\s*"flowKind" <> 'NATIVE'\s+OR \(\s*"nativeRedirectUri" IS NOT NULL\s+AND "nativeCodeChallenge" IS NOT NULL\s*\)\s*\)/,
    );
    // Wrapped so a re-run is a no-op (sibling-migration discipline).
    expect(sql).toMatch(/WHEN duplicate_object THEN null/);
  });
});
