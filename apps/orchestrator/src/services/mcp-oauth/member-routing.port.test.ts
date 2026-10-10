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
import { catalogOAuthFields, catalogOnlyFor } from "../remote-mcp-servers.js";
import { fakeMcpOAuthDb } from "./__tests__/fake-db.js";
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
  const memberId = over.memberId !== undefined ? over.memberId : over.scope === "MEMBER" ? "user-1" : null;
  // Far future by default: the catalog path reads the real clock, the port tests inject NOW.
  const expiry = over.tokenExpiresAt ?? new Date("2100-01-01T00:00:00Z");
  const base = { provider: SERVER, memberId, state: "CONNECTED", siteId: CLOUD as string | null, ...over, tokenExpiresAt: expiry };
  return { ...base, tokensEnc: sealTokens({ id: base.id, scope: base.scope, memberId }, {
    accessToken: `access-${base.id}`, refreshToken: "r", expiresAt: expiry.toISOString(), scope: "s",
    tokenEndpoint: "https://auth.example/token", resource: "res", mcpUrl: "res",
  }) };
}

function setup(o: {
  member?: OAuthRowLite | null; workspace?: OAuthRowLite | null; baseCredential?: "member" | "workspace";
  integration?: { status?: string } | null; user?: { id: string; directoryStatus?: string; deletionStatus?: string } | null;
} = {}) {
  const callToolFor = vi.fn(async (_id: string, _n: string, _a: Record<string, unknown>) => ok);
  const open = vi.fn(async (_i: Record<string, unknown>) => ({}) as never);
  const baseCall = vi.fn(async (_n: string, _a: Record<string, unknown>) => ok);
  const client = { open, callToolFor, lastAdvertisedToolNames: () => [] as readonly string[], closeEpoch: 0 };
  const rows = { member: o.member ?? null, workspace: o.workspace ?? null };
  const prisma = {
    user: {
      findFirst: vi.fn(async () =>
        o.user === undefined ? { id: "user-1", directoryStatus: "ACTIVE", deletionStatus: "NONE" } : o.user),
    },
    mcpOAuthConnection: {
      findFirst: vi.fn(async (a: { where: { scope: string } }) => (a.where.scope === "MEMBER" ? rows.member : rows.workspace)),
      findUnique: vi.fn(async (a: { where: { id: string } }) => [rows.member, rows.workspace].find((r) => r?.id === a.where.id) ?? null),
    },
    integrationConnection: {
      findFirst: vi.fn(async () => (o.integration === undefined ? { status: "CONNECTED" } : o.integration)),
    },
  };
  const port = createMemberRoutingPort({
    serverId: SERVER, client, prisma, now: () => NOW,
    base: { isStarted: true, listTools: async () => [], callTool: baseCall },
    baseCredential: o.baseCredential ?? "workspace",
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

describe("credential precedence: member, then Workspace, else sign in", () => {
  const member = () => row({ id: MEMBER_ID, scope: "MEMBER" });
  const workspace = () => row({ id: WS_ID, scope: "WORKSPACE" });

  it("uses the asking member's own sign-in, opened with their token and the forced site id", async () => {
    const s = setup({ member: member(), workspace: workspace() });
    await s.as(() => s.gated.callTool("atlassian__getJiraIssue", { k: 1 }));
    expect(s.open).toHaveBeenCalledWith(expect.objectContaining({ accessToken: `access-${MEMBER_ID}`, cloudId: CLOUD, connectionId: MEMBER_ID }));
    expect(s.callToolFor).toHaveBeenCalledWith(MEMBER_ID, "atlassian__getJiraIssue", { k: 1 });
    expect(s.baseCall).not.toHaveBeenCalled();
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "allowed", credential: "member" }));
  });

  it("falls to the Workspace connection when the member has no row", async () => {
    const s = setup({ workspace: workspace() });
    await s.as(() => s.gated.callTool("t", {}));
    expect(s.callToolFor).toHaveBeenCalledWith(WS_ID, "t", {});
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ credential: "workspace" }));
  });

  it("with no sign-in at all asks them to sign in, audits refused_policy, and dials nothing (no shared-token rung)", async () => {
    const s = setup();
    const out = await s.as(() => s.gated.callTool("t", {}));
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain("REMOTE_SIGN_IN_REQUIRED");
    expect(JSON.stringify(out)).toContain("You haven't signed in to Atlassian yet. Open Connectors › Atlassian and choose Connect, then ask again.");
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refused_policy", reason: "REMOTE_SIGN_IN_REQUIRED" }));
    expect(s.open).not.toHaveBeenCalled();
    expect(s.callToolFor).not.toHaveBeenCalled();
    expect(s.baseCall).not.toHaveBeenCalled();
  });

  it("a member whose sign-in needs renewing is told so, never silently served as another identity", async () => {
    const s = setup({ member: { ...member(), state: "NEEDS_RECONNECT" }, workspace: workspace() });
    const out = await s.as(() => s.gated.callTool("t", {}));
    expect(JSON.stringify(out)).toContain("REMOTE_SIGN_IN_EXPIRED");
    expect(JSON.stringify(out)).toContain("Your Atlassian sign-in has expired. Open Connectors › Atlassian and choose Connect again, then ask again.");
    expect(s.callToolFor).not.toHaveBeenCalled();
    expect(s.baseCall).not.toHaveBeenCalled();
  });

  it("an owner-backed base session never answers another member's call: no sign-in means REMOTE_SIGN_IN_REQUIRED", async () => {
    const s = setup({ baseCredential: "member" }); // the catalog session runs on an owner's token
    const out = await s.as(() => s.gated.callTool("t", {}));
    expect(JSON.stringify(out)).toContain("REMOTE_SIGN_IN_REQUIRED");
    expect(s.baseCall).not.toHaveBeenCalled();
    expect(s.callToolFor).not.toHaveBeenCalled();
  });

  it("resolves the same way for a durable run (agentRunId alongside the username)", async () => {
    const s = setup({ member: member() });
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
      member: row({ id: MEMBER_ID, scope: "MEMBER" }),
      integration: { status: "DISABLED" },
    });
    const out = await s.as(() => s.gated.callTool("t", {}));
    expect(JSON.stringify(out)).toContain("REMOTE_CONNECTION_DISABLED");
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refused_policy", reason: "REMOTE_CONNECTION_DISABLED" }));
    expect(s.open).not.toHaveBeenCalled();
    expect(s.callToolFor).not.toHaveBeenCalled();
    expect(s.baseCall).not.toHaveBeenCalled();
    expect(s.prisma.mcpOAuthConnection.findFirst).not.toHaveBeenCalled();
  });

  it("a non-DISABLED connection status does not block a member's own sign-in", async () => {
    const s = setup({
      member: row({ id: MEMBER_ID, scope: "MEMBER" }),
      integration: { status: "NEEDS_RECONNECT" },
    });
    await s.as(() => s.gated.callTool("t", {}));
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "allowed", credential: "member" }));
  });
});

describe("the site is pinned to the sign-in, never chosen by the caller (WARP-3961)", () => {
  it("opens the session with the row's own siteId even when the call's arguments name another site", async () => {
    const s = setup({ member: row({ id: MEMBER_ID, scope: "MEMBER", siteId: "pinned-site" }) });
    await s.as(() => s.port.callToolAttributed("t", { cloudId: "other" }));
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.open.mock.calls[0]![0]).toMatchObject({ cloudId: "pinned-site", connectionId: MEMBER_ID });
    expect(JSON.stringify(s.open.mock.calls)).not.toContain("other");
  });

  it("uses the Workspace row's own site, not the member's or an admin-typed one", async () => {
    const s = setup({ workspace: row({ id: WS_ID, scope: "WORKSPACE", siteId: "ws-site" }) });
    await s.as(() => s.port.callToolAttributed("t", {}));
    expect(s.open.mock.calls[0]![0]).toMatchObject({ cloudId: "ws-site", connectionId: WS_ID });
  });

  it("a CONNECTED row with no site id is refused as sign-in-expired and nothing is opened or called", async () => {
    const s = setup({ member: row({ id: MEMBER_ID, scope: "MEMBER", siteId: null }), workspace: row({ id: WS_ID, scope: "WORKSPACE" }) });
    expect(await s.as(() => s.port.callToolAttributed("t", {}))).toMatchObject({ refusal: "REMOTE_SIGN_IN_EXPIRED" });
    expect(s.open).not.toHaveBeenCalled();
    expect(s.callToolFor).not.toHaveBeenCalled();
    expect(s.baseCall).not.toHaveBeenCalled();
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
  const gatePrisma = (o: { row: { id: string; status: string; providerTokensEnc: string | null } | null; signedIn: number | Error | "absent" }): RemoteMcpGatePrisma => ({
    integrationConnection: { findFirst: async () => o.row },
    ...(o.signedIn === "absent" ? {} : {
      mcpOAuthConnection: { count: vi.fn(async () => { if (o.signedIn instanceof Error) throw o.signedIn; return o.signedIn as number; }) },
    }),
  });
  const apiRow = (status: string, tokens: string | null = "dcv1:x") => ({ id: "c1", status, providerTokensEnc: tokens });

  it("passes on a CONNECTED sign-in alone (no API-token row at all)", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: null, signedIn: 1 }), SERVER)).toEqual({ allowed: true });
  });

  it("refuses a DISABLED connection whatever sign-ins exist", async () => {
    const d = await remoteMcpGate(gatePrisma({ row: apiRow("DISABLED"), signedIn: 3 }), SERVER);
    expect(d).toMatchObject({ allowed: false, reason: "connection_disabled" });
  });

  it("a connection row that is not DISABLED yields to a member's sign-in", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: apiRow("NEEDS_RECONNECT"), signedIn: 1 }), SERVER)).toEqual({ allowed: true });
  });

  it("a CONNECTED API-token row is no credential any more: with no sign-in the gate refuses no_credential", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: apiRow("CONNECTED"), signedIn: 0 }), SERVER)).toMatchObject({
      allowed: false, reason: "no_credential", message: `Nobody has signed in to ${SERVER} yet. Open Connectors and choose Connect.`,
    });
  });

  it("refuses no_credential when no sign-in exists, or the model is absent", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: null, signedIn: 0 }), SERVER)).toMatchObject({ reason: "no_credential" });
    expect(await remoteMcpGate(gatePrisma({ row: apiRow("NEEDS_RECONNECT"), signedIn: 0 }), SERVER)).toMatchObject({ reason: "no_credential" });
    expect(await remoteMcpGate(gatePrisma({ row: null, signedIn: "absent" }), SERVER)).toMatchObject({ reason: "no_credential" });
  });

  it("fails closed when the sign-in read fails", async () => {
    expect(await remoteMcpGate(gatePrisma({ row: null, signedIn: new Error("db") }), SERVER)).toMatchObject({ allowed: false, reason: "gate_unavailable" });
  });
});

describe("catalog credential: only a Workspace connection, or a current owner/admin", () => {
  type AttachDeps = Parameters<typeof catalogOAuthFields>[0];
  /** Evaluates the role join the real query asks Postgres for. */
  function catalogDeps(members: { id: string; role: string }[], rows: OAuthRowLite[]) {
    const where: unknown[] = [];
    const table = {
      count: async () => rows.length,
      findUnique: async () => null,
      findFirst: vi.fn(async (a: { where: Record<string, any> }) => {
        where.push(a.where);
        const w = a.where;
        const roles: string[] | undefined = w.member?.is?.role?.in;
        return rows.find((r) => r.scope === w.scope && r.state === w.state &&
          (w.scope !== "MEMBER" || (roles?.includes(members.find((m) => m.id === r.memberId)?.role ?? "") ?? false))) ?? null;
      }),
    };
    return { deps: { serverId: SERVER, prisma: { mcpOAuthConnection: table } } as unknown as AttachDeps, where };
  }
  const memberRow = (id: string, memberId: string) => row({ id, scope: "MEMBER", memberId });
  const ownerRow = () => memberRow(MEMBER_ID, "owner-1");

  it("a member-only box (one family sign-in) offers no catalog credential", async () => {
    const { deps } = catalogDeps([{ id: "fam-1", role: "family" }], [memberRow(MEMBER_ID, "fam-1")]);
    expect(await catalogOAuthFields(deps)).toBeNull();
  });

  it("the site is the chosen row's own siteId, and a row with no site id is skipped (cannot be pinned)", async () => {
    const own = row({ id: WS_ID, scope: "WORKSPACE", siteId: "workspace-site" });
    expect(await catalogOAuthFields(catalogDeps([], [own]).deps)).toMatchObject({ fields: { cloudId: "workspace-site" } });
    const unpinned = row({ id: WS_ID, scope: "WORKSPACE", siteId: null });
    expect(await catalogOAuthFields(catalogDeps([], [unpinned]).deps)).toBeNull();
  });

  it("an owner's sign-in backs the catalog, audited as credential member", async () => {
    const { deps } = catalogDeps([{ id: "owner-1", role: "owner" }], [ownerRow()]);
    const got = await catalogOAuthFields(deps);
    expect(got).toMatchObject({ kind: "member", fields: { accessToken: `access-${MEMBER_ID}`, cloudId: CLOUD } });
    // and the listing audit names it
    const audit = vi.fn();
    const up = { isStarted: true, listTools: async () => [], callTool: async () => ok, catalogCredential: got!.kind, callToolAttributed: async () => ({ outcome: ok, credential: got!.kind }) };
    await createGatedRemoteMcpPort({ serverId: SERVER, upstream: up, gate: async () => ({ allowed: true }), audit }).listTools();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ op: "list_tools", credential: "member" }));
  });

  it("after the owner is demoted to family, a fresh attach refuses", async () => {
    const rows = [ownerRow()];
    expect(await catalogOAuthFields(catalogDeps([{ id: "owner-1", role: "admin" }], rows).deps)).not.toBeNull();
    expect(await catalogOAuthFields(catalogDeps([{ id: "owner-1", role: "family" }], rows).deps)).toBeNull();
  });

  it("the query joins the role, active directory status and no pending deletion", async () => {
    const { deps, where } = catalogDeps([{ id: "owner-1", role: "owner" }], [ownerRow()]);
    await catalogOAuthFields(deps);
    expect(where[1]).toMatchObject({ member: { is: { role: { in: ["owner", "admin"] }, directoryStatus: "ACTIVE", deletionStatus: "NONE" } } });
  });

  it("prefers the Workspace connection over an owner's personal sign-in", async () => {
    const ws = row({ id: WS_ID, scope: "WORKSPACE" });
    const { deps } = catalogDeps([{ id: "owner-1", role: "owner" }], [ownerRow(), ws]);
    expect(await catalogOAuthFields(deps)).toMatchObject({ kind: "workspace" });
  });
});

describe("catalog-only base sessions and the kill switch", () => {
  it("opens the base session catalog-only exactly when a personal sign-in backs it", () => {
    expect(catalogOnlyFor("member")).toEqual({ catalogOnly: true });
    expect(catalogOnlyFor("workspace")).toEqual({});
  });

  it("a 409 from a switched-off bridge on open is not retried", async () => {
    const s = setup({ member: row({ id: MEMBER_ID, scope: "MEMBER" }) });
    s.open.mockRejectedValueOnce(new McpBridgeError("REMOTE_MCP_GATE_REFUSED", "off", 409));
    await expect(s.as(() => s.port.callToolAttributed("t", {}))).rejects.toMatchObject({ code: "REMOTE_MCP_GATE_REFUSED" });
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.callToolFor).not.toHaveBeenCalled();
  });
});

describe("identity binding, against a database that honours `where`", () => {
  const ALICE_ROW = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const BOB_ROW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const WS = "cccccccc-cccc-cccc-cccc-cccccccccccc";

  async function world(o: { bobState?: string; workspace?: boolean } = {}) {
    const db = fakeMcpOAuthDb();
    db.setUser({ id: "u-alice", username: "alice" });
    db.setUser({ id: "u-bob", username: "bob" });
    const seed = async (id: string, scope: "MEMBER" | "WORKSPACE", memberId: string | null, state = "CONNECTED", siteId: string | null = CLOUD) => {
      const r = row({ id, scope, memberId, state, siteId });
      await db.seed({
        ...r, issuer: "https://auth.example/iss", tokenEndpointHost: "auth.example", clientId: "c",
        workspaceAckAt: scope === "WORKSPACE" ? NOW : null, workspaceAckBy: scope === "WORKSPACE" ? "boss" : null,
      });
    };
    await seed(ALICE_ROW, "MEMBER", "u-alice", "CONNECTED", "site-alice");
    await seed(BOB_ROW, "MEMBER", "u-bob", o.bobState ?? "CONNECTED", "site-bob");
    if (o.workspace) await seed(WS, "WORKSPACE", null);
    const callToolFor = vi.fn(async (_id: string, _n: string, _a: Record<string, unknown>) => ok);
    const open = vi.fn(async (_i: Record<string, unknown>) => ({}) as never);
    const baseCall = vi.fn(async (_n: string, _a: Record<string, unknown>) => ok);
    const port = createMemberRoutingPort({
      serverId: SERVER, now: () => NOW,
      client: { open, callToolFor, lastAdvertisedToolNames: () => [], closeEpoch: 0 },
      base: { isStarted: true, listTools: async () => [], callTool: baseCall },
      baseCredential: "workspace",
      prisma: {
        user: db.prisma.user as never,
        mcpOAuthConnection: db.prisma.mcpOAuthConnection as never,
        integrationConnection: { findFirst: async () => ({ status: "CONNECTED" }) },
      },
    });
    const as = <T,>(username: string, fn: () => Promise<T>) => withRemoteCallAttribution({ userId: username }, fn);
    return { db, port, as, callToolFor, open, baseCall };
  }

  it("alice's call uses alice's sign-in and bob's call uses bob's", async () => {
    const w = await world();
    await w.as("alice", () => w.port.callToolAttributed("t", {}));
    await w.as("bob", () => w.port.callToolAttributed("t", {}));
    expect(w.callToolFor.mock.calls.map((c) => c[0])).toEqual([ALICE_ROW, BOB_ROW]);
    expect(w.open.mock.calls.map((c) => c[0].connectionId)).toEqual([ALICE_ROW, BOB_ROW]);
    expect(w.open.mock.calls[0][0].accessToken).toBe(`access-${ALICE_ROW}`);
  });

  it("two members on different sites each open their session on their OWN site", async () => {
    const w = await world();
    await w.as("alice", () => w.port.callToolAttributed("t", {}));
    await w.as("bob", () => w.port.callToolAttributed("t", {}));
    expect(w.open.mock.calls.map((c) => [c[0].connectionId, c[0].cloudId])).toEqual([
      [ALICE_ROW, "site-alice"],
      [BOB_ROW, "site-bob"],
    ]);
  });

  it("an unknown username falls through to the Workspace connection, never to someone's row", async () => {
    const w = await world({ workspace: true });
    const r = await w.as("mallory", () => w.port.callToolAttributed("t", {}));
    expect("credential" in r && r.credential).toBe("workspace");
    expect(w.callToolFor.mock.calls.map((c) => c[0])).toEqual([WS]);
  });

  it("a deactivated member is refused, with zero bridge calls, and never falls through to the Workspace or API token", async () => {
    const w = await world({ workspace: true });
    w.db.setUser({ id: "u-bob", username: "bob", directoryStatus: "DEACTIVATED" });
    const r = await w.as("bob", () => w.port.callToolAttributed("t", {}));
    expect(r).toMatchObject({ refusal: "REMOTE_SIGN_IN_REQUIRED" });
    expect(w.open).not.toHaveBeenCalled();
    expect(w.callToolFor).not.toHaveBeenCalled();
    expect(w.baseCall).not.toHaveBeenCalled();
    // a user being deleted is a leaver too
    w.db.setUser({ id: "u-bob", username: "bob", deletionStatus: "PENDING" });
    expect(await w.as("bob", () => w.port.callToolAttributed("t", {}))).toMatchObject({ refusal: "REMOTE_SIGN_IN_REQUIRED" });
    expect(w.callToolFor).not.toHaveBeenCalled();
  });

  it.each(["PENDING_CONSENT", "ERROR", "NEEDS_RECONNECT"])(
    "a member row in %s answers sign-in-expired and never falls through to another identity",
    async (state) => {
      const w = await world({ bobState: state, workspace: true });
      const r = await w.as("bob", () => w.port.callToolAttributed("t", {}));
      expect(r).toMatchObject({ refusal: "REMOTE_SIGN_IN_EXPIRED" });
      expect(w.callToolFor).not.toHaveBeenCalled();
      expect(w.baseCall).not.toHaveBeenCalled();
    },
  );

  it("a DISCONNECTED member row means 'never signed in': it falls through to the Workspace", async () => {
    const w = await world({ bobState: "DISCONNECTED", workspace: true });
    await w.as("bob", () => w.port.callToolAttributed("t", {}));
    expect(w.callToolFor.mock.calls.map((c) => c[0])).toEqual([WS]);
  });
});
