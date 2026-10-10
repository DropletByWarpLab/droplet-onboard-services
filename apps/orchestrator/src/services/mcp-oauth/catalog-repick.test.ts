/**
 * WARP-2416 - the catalog session follows the sign-in behind it: re-opened with the
 * new token when that row refreshes, re-picked (or the server detached) when it
 * stops working, never riding a regular member's token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { catalogOAuthFields, catalogOnlyFor } from "../remote-mcp-servers.js";
import { sealTokens } from "./mcp-oauth.service.js";
import { catalogBackingRow, createCatalogRepicker, setCatalogBacking } from "./catalog-repick.js";
import type { OAuthRowLite } from "./member-routing.port.js";

vi.mock("../activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null), getActivitySigner: () => null }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }) }));

const S = "atlassian";
const CLOUD = "00000000-0000-0000-0000-00000000c10d";
const OWNER_ROW = "11111111-1111-1111-1111-111111111111";
const WS_ROW = "22222222-2222-2222-2222-222222222222";
const MEMBER_ROW = "33333333-3333-3333-3333-333333333333";
const siteRow = { id: "c1", status: "CONNECTED", providerTokensEnc: null, providerConfig: { cloudId: CLOUD } };

function row(id: string, scope: "MEMBER" | "WORKSPACE", memberId: string | null, token: string, state = "CONNECTED"): OAuthRowLite {
  return {
    id, provider: S, scope, memberId, state, tokenExpiresAt: new Date("2100-01-01T00:00:00Z"),
    tokensEnc: sealTokens({ id, scope, memberId }, {
      accessToken: token, refreshToken: "r", expiresAt: "2100-01-01T00:00:00.000Z", scope: "s",
      tokenEndpoint: "https://auth.example/token", resource: "res", mcpUrl: "res",
    }),
  };
}

beforeEach(() => {
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
  setCatalogBacking(S, null);
});

describe("createCatalogRepicker", () => {
  it("ignores a row that does not back the catalog, re-attaches for the one that does", async () => {
    const reattach = vi.fn(async (_s: string) => {});
    const changed = createCatalogRepicker({ backingRow: catalogBackingRow, reattach });
    setCatalogBacking(S, OWNER_ROW);
    await changed(S, MEMBER_ROW); // an unrelated member's refresh
    expect(reattach).not.toHaveBeenCalled();
    await changed(S, OWNER_ROW);
    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it("does nothing when an API token (no sign-in row) backs the catalog", async () => {
    const reattach = vi.fn(async (_s: string) => {});
    await createCatalogRepicker({ backingRow: catalogBackingRow, reattach })(S, OWNER_ROW);
    expect(reattach).not.toHaveBeenCalled();
  });

  it("is single-flight per server, and runs again once the first has finished", async () => {
    let release!: () => void;
    const reattach = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const changed = createCatalogRepicker({ backingRow: catalogBackingRow, reattach });
    setCatalogBacking(S, OWNER_ROW);
    const a = changed(S, OWNER_ROW);
    const b = changed(S, OWNER_ROW);
    expect(reattach).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([a, b]);
    const c = changed(S, OWNER_ROW);
    expect(reattach).toHaveBeenCalledTimes(2);
    release();
    await c;
  });

  it("a failed re-attach is contained, not thrown into the refresh", async () => {
    const changed = createCatalogRepicker({ backingRow: catalogBackingRow, reattach: async () => { throw new Error("x"); } });
    setCatalogBacking(S, OWNER_ROW);
    await expect(changed(S, OWNER_ROW)).resolves.toBeUndefined();
  });
});

describe("what the re-attach opens, with the real catalog-credential choice", () => {
  /** Mirrors attachRemoteServer's choice and open body: catalogOAuthFields, then catalogOnlyFor. */
  function world(rows: OAuthRowLite[], roles: Record<string, string>) {
    const opens: Record<string, unknown>[] = [];
    const detached: string[] = [];
    const table = {
      count: async () => rows.length,
      findUnique: async () => null,
      findFirst: async (a: { where: Record<string, any> }) => {
        const w = a.where;
        const allowed: string[] | undefined = w.member?.is?.role?.in;
        return rows.find((r) => r.scope === w.scope && r.state === w.state &&
          (w.scope !== "MEMBER" || (allowed?.includes(roles[r.memberId ?? ""] ?? "") ?? false))) ?? null;
      },
    };
    const deps = { serverId: S, prisma: { mcpOAuthConnection: table } } as unknown as Parameters<typeof catalogOAuthFields>[0];
    const attach = async (): Promise<void> => {
      const got = await catalogOAuthFields(deps, siteRow);
      if (!got) {
        setCatalogBacking(S, null);
        detached.push("credential_incomplete");
        return;
      }
      opens.push({ ...got.fields, ...catalogOnlyFor(got.kind) });
      setCatalogBacking(S, got.rowId);
    };
    const changed = createCatalogRepicker({ backingRow: catalogBackingRow, reattach: attach });
    return { rows, opens, detached, attach, changed };
  }

  it("a refresh of the backing owner row re-opens with the NEW token and catalogOnly", async () => {
    const w = world([row(OWNER_ROW, "MEMBER", "owner-1", "access-old")], { "owner-1": "owner" });
    await w.attach();
    expect(w.opens[0]).toMatchObject({ accessToken: "access-old", cloudId: CLOUD, catalogOnly: true });
    w.rows[0] = row(OWNER_ROW, "MEMBER", "owner-1", "access-new"); // the refresh replaced the blob
    await w.changed(S, OWNER_ROW);
    expect(w.opens).toHaveLength(2);
    expect(w.opens[1]).toMatchObject({ accessToken: "access-new", cloudId: CLOUD, catalogOnly: true });
  });

  it("a refresh of an unrelated member row does not touch the base session", async () => {
    const w = world([row(OWNER_ROW, "MEMBER", "owner-1", "a"), row(MEMBER_ROW, "MEMBER", "fam-1", "b")], { "owner-1": "owner", "fam-1": "family" });
    await w.attach();
    await w.changed(S, MEMBER_ROW);
    expect(w.opens).toHaveLength(1);
  });

  it("the backing row stops working with no other candidate: the server detaches with credential_incomplete", async () => {
    const w = world([row(OWNER_ROW, "MEMBER", "owner-1", "a")], { "owner-1": "owner" });
    await w.attach();
    w.rows[0] = row(OWNER_ROW, "MEMBER", "owner-1", "a", "NEEDS_RECONNECT");
    await w.changed(S, OWNER_ROW);
    expect(w.detached).toEqual(["credential_incomplete"]);
    expect(catalogBackingRow(S)).toBeUndefined();
    expect(w.opens).toHaveLength(1);
  });

  it("with a Workspace connection present it re-attaches on that token, with no catalogOnly", async () => {
    const w = world([row(OWNER_ROW, "MEMBER", "owner-1", "a"), row(WS_ROW, "WORKSPACE", null, "ws-token")], { "owner-1": "owner" });
    // initial pick already prefers the Workspace connection; make the owner the backing one
    setCatalogBacking(S, OWNER_ROW);
    w.rows[0] = row(OWNER_ROW, "MEMBER", "owner-1", "a", "ERROR");
    await w.changed(S, OWNER_ROW);
    expect(w.opens).toHaveLength(1);
    expect(w.opens[0]).toMatchObject({ accessToken: "ws-token", cloudId: CLOUD });
    expect(w.opens[0]).not.toHaveProperty("catalogOnly");
    expect(catalogBackingRow(S)).toBe(WS_ROW);
  });

  it("a backing owner who was demoted to family is not re-used, and a regular member never takes over", async () => {
    const w = world([row(OWNER_ROW, "MEMBER", "owner-1", "a"), row(MEMBER_ROW, "MEMBER", "fam-1", "b")], { "owner-1": "owner", "fam-1": "family" });
    await w.attach();
    expect(w.opens[0]).toMatchObject({ accessToken: "a" });
    const roles = { "owner-1": "family", "fam-1": "family" };
    const w2 = world([row(OWNER_ROW, "MEMBER", "owner-1", "a-refreshed"), row(MEMBER_ROW, "MEMBER", "fam-1", "b")], roles);
    setCatalogBacking(S, OWNER_ROW);
    await w2.changed(S, OWNER_ROW); // the owner's row refreshed, but they are a family member now
    expect(w2.opens).toHaveLength(0);
    expect(w2.detached).toEqual(["credential_incomplete"]);
  });
});
