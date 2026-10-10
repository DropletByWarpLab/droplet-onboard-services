/**
 * WARP-3961 test fixture: a fake database holding MCP sign-ins (McpOAuthConnection)
 * plus a switchable IntegrationConnection row (only its status matters now: DISABLED
 * is the owner's per-server off). Tokens are sealed with the real `sealTokens`, so the
 * code under test opens them exactly as production does. Credentials are obviously fake.
 */
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { sealTokens } from "../mcp-oauth/mcp-oauth.service.js";
import { fakeMcpOAuthDb } from "../mcp-oauth/__tests__/fake-db.js";

export const FAKE_ACCESS = "FAKE-ACCESS-000000000000";
export const SITE_ID = "00000000-0000-4000-8000-000000000000";
export const WS_ROW_ID = "22222222-2222-4222-8222-222222222222";
export const OWNER_ROW_ID = "11111111-1111-4111-8111-111111111111";

export interface SignInSeed {
  id?: string;
  scope: "WORKSPACE" | "MEMBER";
  /** MEMBER only: the member's user id (a user with `role` is registered for it). */
  memberId?: string;
  role?: string;
  state?: string;
  /** `null` = a row that predates WARP-3961 (no pinned site). */
  siteId?: string | null;
  access?: string;
}

/** `integration`: the admin-owned row. `undefined`/`null` = none; `{status:"DISABLED"}` = the per-server off. */
export async function signedInDb(
  seeds: SignInSeed[] = [],
  integration: { status: string } | null = null,
  provider = "atlassian",
) {
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
  const db = fakeMcpOAuthDb();
  const state = { integration };
  const addSignIn = async (s: SignInSeed): Promise<string> => {
    const id = s.id ?? (s.scope === "WORKSPACE" ? WS_ROW_ID : OWNER_ROW_ID);
    const memberId = s.scope === "MEMBER" ? (s.memberId ?? "owner-1") : null;
    if (memberId) db.setUser({ id: memberId, role: s.role ?? "owner" });
    const rowState = s.state ?? "CONNECTED";
    const expiry = new Date("2100-01-01T00:00:00Z");
    await db.seed({
      id, provider, scope: s.scope, memberId, state: rowState,
      issuer: "https://auth.example/iss", tokenEndpointHost: "auth.example", clientId: "c",
      workspaceAckAt: s.scope === "WORKSPACE" ? new Date() : null,
      workspaceAckBy: s.scope === "WORKSPACE" ? "boss" : null,
      connectedAt: new Date("2026-10-01T00:00:00Z"),
      tokenExpiresAt: expiry,
      siteId: s.siteId === undefined ? SITE_ID : s.siteId,
      tokensEnc:
        rowState === "DISCONNECTED"
          ? null
          : sealTokens({ id, scope: s.scope, memberId }, {
              accessToken: s.access ?? FAKE_ACCESS, refreshToken: "r", expiresAt: expiry.toISOString(), scope: "s",
              tokenEndpoint: "https://auth.example/token", resource: "res", mcpUrl: "res",
            }),
    });
    return id;
  };
  for (const s of seeds) await addSignIn(s);
  /** What the attach/reopen deps take: the sign-in table and the integration row, no `user`
   *  (so the base session is the upstream, not the per-member routing port). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    mcpOAuthConnection: db.prisma.mcpOAuthConnection,
    integrationConnection: {
      findFirst: async () => (state.integration ? { id: "conn_atlassian_fixture", providerTokensEnc: null, ...state.integration } : null),
    },
  };
  return { db, prisma, state, addSignIn };
}
