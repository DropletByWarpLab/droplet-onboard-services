/**
 * WARP-3960 security review - the always-on migration must not silently give egress
 * back to an owner who deliberately switched remote MCP off.
 *
 * Vitest mocks @prisma/client, so (like pm-time.schema.test.ts) this pins the migration
 * SQL and evaluates its predicate, transcribed, over the three states that matter:
 * an explicit owner "off", the seeded default "off", and no row at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, REPO_ROOT } from "./helpers/test-paths.js";

const SQL = readFileSync(join(MIGRATIONS_DIR, "20261010130000_warp_3960_remote_mcp_always_on", "migration.sql"), "utf8");

/** The migration's EXISTS predicate over the `remote_mcp` row, transcribed. */
const explicitOff = (row: { enabled: boolean; lastChangedBy: string | null } | null): boolean =>
  row !== null && row.enabled === false && row.lastChangedBy !== null;

/** What the migration does to atlassian's IntegrationConnection, transcribed. */
function atlassianAfter(
  channel: { enabled: boolean; lastChangedBy: string | null } | null,
  conn: { status: string; providerTokensEnc: string | null } | null,
): { status: string; providerTokensEnc: string | null } | null {
  if (!explicitOff(channel)) return conn;
  if (conn === null) return { status: "DISABLED", providerTokensEnc: null };
  return { ...conn, status: "DISABLED" }; // status only: credentials are kept
}

describe("the SQL ships the carry-over, before the upsert that erases the evidence", () => {
  it("disables atlassian only for an explicit owner off, touching status only", () => {
    expect(SQL).toMatch(/UPDATE "IntegrationConnection"\s+SET "status" = 'DISABLED', "updatedAt" = now\(\)/);
    expect(SQL).toContain(`"provider" = 'atlassian'`);
    expect(SQL).toContain('"enabled" = false');
    expect(SQL).toContain('"lastChangedBy" IS NOT NULL');
    expect(SQL).not.toMatch(/providerTokensEnc|apiCredentialsEnc|providerConfig/);
  });

  it("creates a DISABLED row when the owner switched off before anyone connected", () => {
    expect(SQL).toMatch(/INSERT INTO "IntegrationConnection"[\s\S]*'DISABLED'[\s\S]*NOT EXISTS \(SELECT 1 FROM "IntegrationConnection" WHERE "provider" = 'atlassian'\)/);
  });

  it("runs before the upsert that forces the label on", () => {
    expect(SQL.indexOf('UPDATE "IntegrationConnection"')).toBeGreaterThan(-1);
    expect(SQL.indexOf('UPDATE "IntegrationConnection"')).toBeLessThan(SQL.indexOf('INSERT INTO "OffLanAllowlistChannel"'));
    expect(SQL).toContain(`ON CONFLICT ("key") DO UPDATE SET "enabled" = true`);
  });
});

describe("the three states", () => {
  const conn = { status: "CONNECTED", providerTokensEnc: "dcv1:x" };

  it("explicit owner off -> atlassian DISABLED, credentials kept; no connection row -> a DISABLED row", () => {
    expect(atlassianAfter({ enabled: false, lastChangedBy: "owner" }, conn)).toEqual({ status: "DISABLED", providerTokensEnc: "dcv1:x" });
    expect(atlassianAfter({ enabled: false, lastChangedBy: "owner" }, null)).toEqual({ status: "DISABLED", providerTokensEnc: null });
  });

  it("seeded off (no actor) -> untouched", () => {
    expect(atlassianAfter({ enabled: false, lastChangedBy: null }, conn)).toEqual(conn);
    expect(atlassianAfter({ enabled: false, lastChangedBy: null }, null)).toBeNull();
  });

  it("owner left it on, or no channel row -> untouched", () => {
    expect(atlassianAfter({ enabled: true, lastChangedBy: "owner" }, conn)).toEqual(conn);
    expect(atlassianAfter(null, conn)).toEqual(conn);
    expect(atlassianAfter(null, null)).toBeNull();
  });
});

describe("every disable/disconnect path detaches the live session immediately", () => {
  it("app.ts hands both Disconnect routers tearDownRemoteServer (abort in-flight, detach on the per-server lock)", () => {
    const src = readFileSync(join(REPO_ROOT, "apps", "orchestrator", "src", "app.ts"), "utf8");
    expect(src.match(/detach: \(serverId\) => tearDownRemoteServer\(serverId\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/detach: \(serverId\) => detachRemoteMcp/);
  });
});
