/**
 * WARP-2409 - whose sign-in a remote MCP call runs under, and the gate rule that
 * lets a server be dialled on sign-ins alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { McpBridgeError } from "../mcp-bridge.client.js";
import { withRemoteCallAttribution } from "../remote-call-attribution.js";
import { createGatedRemoteMcpPort, remoteMcpGate, type RemoteMcpGatePrisma } from "../remote-mcp-gateway.service.js";
import { registerMcpOAuthRefresher } from "./mcp-oauth-refresher.js";
import { sealTokens } from "./mcp-oauth.service.js";
import { createMemberRoutingPort, type OAuthRowLite } from "./member-routing.port.js";

vi.mock("../activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null), getActivitySigner: () => null }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
}));

const SERVER = "atlassian";
const NOW = new Date("2026-10-09T12:00:00Z");
const CLOUD = "00000000-0000-0000-0000-00000000c10d";
const MEMBER_ID = "11111111-1111-1111-1111-111111111111";
const WS_ID = "22222222-2222-2222-2222-222222222222";
const ok = { content: [{ type: "text" as const, text: "{}" }], isError: false };

function row(over: Partial<OAuthRowLite> & { id: string; scope: "MEMBER" | "WORKSPACE" }): OAuthRowLite {
  const memberId = over.scope === "MEMBER" ? "user-1" : null;
  const base = { provider: SERVER, memberId, state: "CONNECTED", tokenExpiresAt: new Date(NOW.getTime() + 3600_000), ...over };
  return { ...base, tokensEnc: sealTokens({ id: base.id, scope: base.scope, memberId }, {
    accessToken: `access-${base.id}`, refreshToken: "r", expiresAt: base.tokenExpiresAt.toISOString(), scope: "s",
    tokenEndpoint: "https://auth.example/token", resource: "res", mcpUrl: "res",
  }) };
}

function setup(o: {
  member?: OAuthRowLite | null; workspace?: OAuthRowLite | null; apiToken?: boolean;
  integration?: { status?: string; providerConfig: unknown } | null; user?: { id: string } | null;
} = {}) {
  const callToolFor = vi.fn(async (_id: string, _n: string, _a: Record<string, unknown>) => ok);
  const open = vi.fn(async (_i: Record<string, unknown>) => ({}) as never);
  const baseCall = vi.fn(async (_n: string, _a: Record<string, unknown>) => ok);
  const client = { open, callToolFor, lastAdvertisedToolNames: () => [] as readonly string[], closeEpoch: 0 };
  const rows = { member: o.member ?? null, workspace: o.workspace ?? null };
  const prisma = {
    user: { findFirst: vi.fn(async () => (o.user === undefined ? { id: "user-1" } : o.user)) },
    mcpOAuthConnection: {
      findFirst: vi.fn(async (a: { where: { scope: string } }) => (a.where.scope === "MEMBER" ? rows.member : rows.workspace)),
      findUnique: vi.fn(async (a: { where: { id: string } }) => [rows.member, rows.workspace].find((r) => r?.id === a.where.id) ?? null),
    },
    integrationConnection: {
      findFirst: vi.fn(async () => (o.integration === undefined ? { status: "CONNECTED", providerConfig: { cloudId: CLOUD } } : o.integration)),
    },
  };
  const port = createMemberRoutingPort({
    serverId: SERVER, client, prisma, now: () => NOW,
    base: { isStarted: true, listTools: async () => [], callTool: baseCall },
    baseCredential: o.apiToken ? "api-token" : "workspace",
  });
  const audit = vi.fn();
  const gated = createGatedRemoteMcpPort({ serverId: SERVER, upstream: port, gate: async () => ({ allowed: true }), audit });
  const as = <T,>(fn: () => Promise<T>) => withRemoteCallAttribution({ userId: "alice" }, fn);
  return { port, gated, audit, callToolFor, open, baseCall, prisma, client, as };
}

beforeEach(() => {
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
  registerMcpOAuthRefresher(null);
});

describe("credential precedence: member, then Workspace, then API token, else sign in", () => {
  const member = () => row({ id: MEMBER_ID, scope: "MEMBER" });
  const workspace = () => row({ id: WS_ID, scope: "WORKSPACE" });

  it("uses the asking member's own sign-in, opened with their token and the forced site id", async () => {
    const s = setup({ member: member(), workspace: workspace(), apiToken: true });
    await s.as(() => s.gated.callTool("atlassian__getJiraIssue", { k: 1 }));
    expect(s.open).toHaveBeenCalledWith(expect.objectContaining({ accessToken: `access-${MEMBER_ID}`, cloudId: CLOUD, connectionId: MEMBER_ID }));
    expect(s.callToolFor).toHaveBeenCalledWith(MEMBER_ID, "atlassian__getJiraIssue", { k: 1 });
    expect(s.baseCall).not.toHaveBeenCalled();
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "allowed", credential: "member" }));
  });

  it("falls to the Workspace connection when the member has no row", async () => {
    const s = setup({ workspace: workspace(), apiToken: true });
    await s.as(() => s.gated.callTool("t", {}));
    expect(s.callToolFor).toHaveBeenCalledWith(WS_ID, "t", {});
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ credential: "workspace" }));
  });

  it("falls to the shared API token last, on the base session", async () => {
    const s = setup({ apiToken: true });
    await s.as(() => s.gated.callTool("t", {}));
    expect(s.baseCall).toHaveBeenCalledWith("t", {});
    expect(s.callToolFor).not.toHaveBeenCalled();
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ credential: "api-token" }));
  });

  it("with no row and no API token asks them to sign in, audits refused_policy, and dials nothing", async () => {
    const s = setup({ apiToken: false });
    const out = await s.as(() => s.gated.callTool("t", {}));
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain("REMOTE_SIGN_IN_REQUIRED");
    expect(JSON.stringify(out)).toContain("Sign in with Atlassian");
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refused_policy", reason: "REMOTE_SIGN_IN_REQUIRED" }));
    expect(s.open).not.toHaveBeenCalled();
    expect(s.callToolFor).not.toHaveBeenCalled();
    expect(s.baseCall).not.toHaveBeenCalled();
  });

  it("a member whose sign-in needs renewing is told so, never silently served as another identity", async () => {
    const s = setup({ member: { ...member(), state: "NEEDS_RECONNECT" }, workspace: workspace(), apiToken: true });
    const out = await s.as(() => s.gated.callTool("t", {}));
    expect(JSON.stringify(out)).toContain("REMOTE_SIGN_IN_EXPIRED");
    expect(s.callToolFor).not.toHaveBeenCalled();
    expect(s.baseCall).not.toHaveBeenCalled();
  });

  it("resolves the same way for a durable run (agentRunId alongside the username)", async () => {
    const s = setup({ member: member(), apiToken: true });
    await withRemoteCallAttribution({ userId: "alice", agentRunId: "run-1" }, () => s.gated.callTool("t", {}));
    expect(s.callToolFor).toHaveBeenCalledWith(MEMBER_ID, "t", {});
  });

  it("a call with no attributed member skips the member rung", async () => {
    const s = setup({ member: member(), workspace: workspace() });
    await s.gated.callTool("t", {});
    expect(s.prisma.user.findFirst).not.toHaveBeenCalled();
    expect(s.callToolFor).toHaveBeenCalledWith(WS_ID, "t", {});
  });
});

describe("an admin's off switch beats every sign-in, at call time too", () => {
  it("refuses a DISABLED connection before choosing any credential, and never calls the bridge", async () => {
    const s = setup({
      member: row({ id: MEMBER_ID, scope: "MEMBER" }), apiToken: true,
      integration: { status: "DISABLED", providerConfig: { cloudId: CLOUD } },
    });
    const out = await s.as(() => s.gated.callTool("t", {}));
    expect(JSON.stringify(out)).toContain("REMOTE_CONNECTION_DISABLED");
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refused_policy", reason: "REMOTE_CONNECTION_DISABLED" }));
    expect(s.open).not.toHaveBeenCalled();
    expect(s.callToolFor).not.toHaveBeenCalled();
    expect(s.baseCall).not.toHaveBeenCalled();
    expect(s.prisma.mcpOAuthConnection.findFirst).not.toHaveBeenCalled();
  });

  it("a NEEDS_RECONNECT API-token row does not block a member's own sign-in", async () => {
    const s = setup({
      member: row({ id: MEMBER_ID, scope: "MEMBER" }),
      integration: { status: "NEEDS_RECONNECT", providerConfig: { cloudId: CLOUD } },
    });
    await s.as(() => s.gated.callTool("t", {}));
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "allowed", credential: "member" }));
  });
});

describe("sessions", () => {
  it("opens a member's session once, and re-opens when their token was renewed", async () => {
    const s = setup({ member: row({ id: MEMBER_ID, scope: "MEMBER" }) });
    await s.as(() => s.port.callToolAttributed("t", {}));
    await s.as(() => s.port.callToolAttributed("t", {}));
    expect(s.open).toHaveBeenCalledTimes(1);
  });

  it("re-opens and retries once when the bridge no longer holds the session", async () => {
    const s = setup({ member: row({ id: MEMBER_ID, scope: "MEMBER" }) });
    s.callToolFor.mockRejectedValueOnce(new McpBridgeError("NO_SESSION", "gone", 409));
    const r = await s.as(() => s.port.callToolAttributed("t", {}));
    expect("credential" in r && r.credential).toBe("member");
    expect(s.open).toHaveBeenCalledTimes(2);
    expect(s.callToolFor).toHaveBeenCalledTimes(2);
  });

  it("drops its session cache when the base session is closed (turning the channel off)", async () => {
    const s = setup({ member: row({ id: MEMBER_ID, scope: "MEMBER" }) });
    await s.as(() => s.port.callToolAttributed("t", {}));
    s.client.closeEpoch = 1;
    await s.as(() => s.port.callToolAttributed("t", {}));
    expect(s.open).toHaveBeenCalledTimes(2);
  });

  it("renews a token that expires within 60 s before the call, and opens with the new one", async () => {
    const expiring = row({ id: MEMBER_ID, scope: "MEMBER", tokenExpiresAt: new Date(NOW.getTime() + 30_000) });
    const s = setup({ member: expiring });
    const renewed = row({ id: MEMBER_ID, scope: "MEMBER" });
    const refreshNow = vi.fn(async () => {
      (s.prisma.mcpOAuthConnection.findFirst as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(async () => renewed);
      (s.prisma.mcpOAuthConnection.findUnique as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(async () => renewed);
      return "refreshed" as const;
    });
    registerMcpOAuthRefresher({ refreshNow });
    await s.as(() => s.port.callToolAttributed("t", {}));
    expect(refreshNow).toHaveBeenCalledWith(MEMBER_ID);
    expect(s.open).toHaveBeenCalledTimes(1);
  });

  it("answers sign-in-expired when renewal says the sign-in is dead, or the token is already expired with no refresher", async () => {
    const dead = setup({ member: row({ id: MEMBER_ID, scope: "MEMBER", tokenExpiresAt: new Date(NOW.getTime() + 10_000) }) });
    registerMcpOAuthRefresher({ refreshNow: async () => "needs_reconnect" });
    expect(await dead.as(() => dead.port.callToolAttributed("t", {}))).toMatchObject({ refusal: "REMOTE_SIGN_IN_EXPIRED" });
    registerMcpOAuthRefresher(null);
    const past = setup({ member: row({ id: MEMBER_ID, scope: "MEMBER", tokenExpiresAt: new Date(NOW.getTime() - 1000) }) });
    expect(await past.as(() => past.port.callToolAttributed("t", {}))).toMatchObject({ refusal: "REMOTE_SIGN_IN_EXPIRED" });
    expect(past.open).not.toHaveBeenCalled();
  });
});

describe("remoteMcpGate with sign-ins", () => {
  const allow = new Set([SERVER]);
  const gatePrisma = (o: { row: { id: string; status: string; providerTokensEnc: string | null } | null; signedIn: number | Error | "absent" }): RemoteMcpGatePrisma => ({
    offLanAllowlistChannel: { findUnique: async () => ({ enabled: true }) },
    integrationConnection: { findFirst: async () => o.row },
    ...(o.signedIn === "absent" ? {} : {
      mcpOAuthConnection: { count: vi.fn(async () => { if (o.signedIn instanceof Error) throw o.signedIn; return o.signedIn as number; }) },
    }),
  });
  const apiRow = (status: string, tokens: string | null = "dcv1:x") => ({ id: "c1", status, providerTokensEnc: tokens });

  it("passes on a CONNECTED sign-in alone (no API-token row at all)", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: null, signedIn: 1 }), SERVER, allow)).toEqual({ allowed: true });
  });

  it("refuses a DISABLED connection whatever sign-ins exist", async () => {
    const d = await remoteMcpGate(gatePrisma({ row: apiRow("DISABLED"), signedIn: 3 }), SERVER, allow);
    expect(d).toMatchObject({ allowed: false, reason: "connection_disabled" });
  });

  it("lets a NEEDS_RECONNECT API-token row yield to a member's sign-in", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: apiRow("NEEDS_RECONNECT"), signedIn: 1 }), SERVER, allow)).toEqual({ allowed: true });
  });

  it("still refuses with the old reasons when no sign-in exists, or the model is absent", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: null, signedIn: 0 }), SERVER, allow)).toMatchObject({ reason: "no_connection_row" });
    expect(await remoteMcpGate(gatePrisma({ row: apiRow("NEEDS_RECONNECT"), signedIn: 0 }), SERVER, allow)).toMatchObject({ reason: "connection_not_connected" });
    expect(await remoteMcpGate(gatePrisma({ row: null, signedIn: "absent" }), SERVER, allow)).toMatchObject({ reason: "no_connection_row" });
  });

  it("fails closed when the sign-in read fails", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: null, signedIn: new Error("db") }), SERVER, allow)).toMatchObject({ allowed: false, reason: "gate_unavailable" });
  });
});
