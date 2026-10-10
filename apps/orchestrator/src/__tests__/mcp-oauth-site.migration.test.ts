/**
 * WARP-3961 - the site-from-token migration.
 *
 * Vitest mocks @prisma/client, so (like remote-mcp-always-on.migration.test.ts) this pins the
 * migration SQL and evaluates its predicates, transcribed, over the rows that matter:
 *  - a legacy CONNECTED API-token row is retired (NOT_CONFIGURED, sealed bundle cleared);
 *  - the owner's per-server off (DISABLED) is left exactly as it is;
 *  - a sign-in made before this change keeps working by inheriting the typed site id.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR } from "./helpers/test-paths.js";

const SQL = readFileSync(join(MIGRATIONS_DIR, "20261010140000_warp_3961_mcp_oauth_site", "migration.sql"), "utf8");

interface Conn { status: string; providerTokensEnc: string | null; providerConfig: Record<string, unknown> | null }

/** The retire UPDATE, transcribed. */
function retired(c: Conn | null): Conn | null {
  if (!c) return c;
  if (c.status === "CONNECTED" && c.providerTokensEnc !== null) {
    return { status: "NOT_CONFIGURED", providerTokensEnc: null, providerConfig: null };
  }
  return c;
}

/** The siteId carry-over UPDATE, transcribed: only a CONNECTED sign-in with no site yet. */
function carriedSite(m: { state: string; siteId: string | null }, c: Conn | null): string | null {
  const typed = typeof c?.providerConfig?.cloudId === "string" ? (c.providerConfig.cloudId as string).trim() : "";
  return m.siteId === null && m.state === "CONNECTED" && typed !== "" ? typed : m.siteId;
}

describe("the SQL", () => {
  it("adds the four site columns to McpOAuthConnection", () => {
    for (const col of ["siteId", "siteUrl", "siteName"]) {
      expect(SQL).toContain(`ALTER TABLE "McpOAuthConnection" ADD COLUMN "${col}" TEXT;`);
    }
    expect(SQL).toContain('ALTER TABLE "McpOAuthConnection" ADD COLUMN "sites" JSONB;');
  });

  it("retires only a CONNECTED atlassian row that holds a sealed credential, clearing the sealed bundle", () => {
    expect(SQL).toMatch(/UPDATE "IntegrationConnection"\s+SET "status" = 'NOT_CONFIGURED', "providerTokensEnc" = NULL/);
    expect(SQL).toContain(`"provider" = 'atlassian'`);
    expect(SQL).toContain(`"status" = 'CONNECTED'`);
    expect(SQL).toContain('"providerTokensEnc" IS NOT NULL');
  });

  it("reads the typed site id BEFORE the retire clears providerConfig", () => {
    expect(SQL.indexOf(`providerConfig"->>'cloudId'`)).toBeGreaterThan(-1);
    expect(SQL.indexOf(`providerConfig"->>'cloudId'`)).toBeLessThan(SQL.indexOf(`SET "status" = 'NOT_CONFIGURED'`));
  });
});

describe("the legacy API-token row", () => {
  const sealed: Conn = { status: "CONNECTED", providerTokensEnc: "dcv1:x", providerConfig: { cloudId: "site-1", email: "a@b.example" } };

  it("CONNECTED with a sealed token -> NOT_CONFIGURED and cleared", () => {
    expect(retired(sealed)).toEqual({ status: "NOT_CONFIGURED", providerTokensEnc: null, providerConfig: null });
  });

  it("the owner's DISABLED off is untouched, credentials and all", () => {
    const off: Conn = { ...sealed, status: "DISABLED" };
    expect(retired(off)).toEqual(off);
  });

  it("a row with no sealed credential, or no row, is untouched", () => {
    const bare: Conn = { status: "CONNECTED", providerTokensEnc: null, providerConfig: null };
    expect(retired(bare)).toEqual(bare);
    expect(retired(null)).toBeNull();
  });
});

describe("the sign-in carry-over", () => {
  const conn: Conn = { status: "CONNECTED", providerTokensEnc: "dcv1:x", providerConfig: { cloudId: " site-1 " } };

  it("a CONNECTED sign-in with no site inherits the typed id (trimmed)", () => {
    expect(carriedSite({ state: "CONNECTED", siteId: null }, conn)).toBe("site-1");
  });

  it("never overwrites a site the token already gave, and never revives a dead sign-in", () => {
    expect(carriedSite({ state: "CONNECTED", siteId: "from-token" }, conn)).toBe("from-token");
    expect(carriedSite({ state: "NEEDS_RECONNECT", siteId: null }, conn)).toBeNull();
    expect(carriedSite({ state: "CONNECTED", siteId: null }, { ...conn, providerConfig: null })).toBeNull();
  });
});
