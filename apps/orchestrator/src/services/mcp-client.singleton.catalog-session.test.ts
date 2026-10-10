/**
 * WARP-2416 - the catalog session follows the sign-in behind it, through the
 * production wiring.
 *
 * Every function exercised is the shipped one: `ensureRemoteMcpAttached` (which records
 * what backs the catalog), `catalogSignInChanged` (the singleton's re-pick), the real
 * refresh tick and the real `disconnectMcpOAuth` calling it through its default
 * dependencies, over the real multiplexer, gate, `McpBridgeClient`, ADR-042 seal and
 * lifecycle registry. The doubles are the bridge (a model), the stdio child, and the
 * database. A source check pins the `index.ts` wiring.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../__tests__/helpers/test-paths.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      MCP_BRIDGE_URL: "http://mcp-bridge.test:9096",
      MCP_BRIDGE_SERVICE_TOKEN: "bridge-token-FAKE-0000000000000000",
    },
  };
});
vi.mock("./mcp-client.service.js", () => ({
  McpClientService: class {
    isStarted = true;
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async listTools() {
      return [{ name: "list_files", description: "local", inputSchema: { type: "object" } }];
    }
    async callTool() {
      return { isError: false, content: [] };
    }
  },
}));
vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";
import type { McpToolDescriptor } from "./mcp-client.port.js";
import {
  catalogSignInChanged,
  detachRemoteMcp,
  ensureRemoteMcpAttached,
  mcpClient,
  tearDownRemoteServer,
} from "./mcp-client.singleton.js";
import { recordCatalog, catalogBackingRow } from "./mcp-oauth/catalog-repick.js";
import { createMcpOAuthRefresher } from "./mcp-oauth/mcp-oauth-refresh.service.js";
import { disconnectMcpOAuth, mcpOAuthDependencies, sealTokens } from "./mcp-oauth/mcp-oauth.service.js";
import { fakeMcpOAuthDb } from "./mcp-oauth/__tests__/fake-db.js";
import { remoteMcpLifecycle } from "./remote-mcp-lifecycle.service.js";
import { registeredRemoteServers, type RemoteServerRegistration } from "./remote-mcp-servers.js";
import { remoteToolClassificationCache, type RemoteToolClassificationRow } from "./remote-tool-classification.service.js";
import { runtimeToolRegistry } from "./runtime-tool-registry.service.js";
import { sealSaasCredentials } from "./saas-credential.service.js";

const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";
const ATLASSIAN = "atlassian";
const CLOUD = "00000000-0000-4000-8000-000000000000";
const OWNER_ROW = "11111111-1111-4111-8111-111111111111";
const WS_ROW = "22222222-2222-4222-8222-222222222222";
const TOOLS: McpToolDescriptor[] = [
  { name: "getJiraIssue", description: "Read one Jira issue", inputSchema: { type: "object" } },
  { name: "getConfluencePage", description: "Read one page", inputSchema: { type: "object" } },
];

const registration = (): RemoteServerRegistration => {
  const found = registeredRemoteServers().find((s) => s.serverId === ATLASSIAN);
  if (!found) throw new Error("the atlassian registration is missing");
  return found;
};

/** A model of the bridge: `open` replaces and seeds a drift baseline, DELETE closes every session of the server. */
function bridgeModel() {
  const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  const baseSessions = new Set<string>();
  const memberSessions = new Set<string>(["a-member-session"]);
  let barrier: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let advertised: McpToolDescriptor[] = TOOLS;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BRIDGE_URL, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Bearer ${BRIDGE_TOKEN}`) return json(401, { error: { code: "UNAUTHORIZED", message: "no" } });
    const health = { serverId: ATLASSIAN, state: "ready", toolCount: TOOLS.length, consecutiveFailures: 0, lastReadyAt: 1, reason: null };
    if (method === "DELETE" && path === `/sessions/${ATLASSIAN}`) {
      baseSessions.clear();
      memberSessions.clear(); // the kill switch: every session of the server
      return json(200, { closed: true });
    }
    if (method === "POST" && path === `/sessions/${ATLASSIAN}/close`) return json(200, { closed: true });
    if (method === "POST" && path === `/sessions/${ATLASSIAN}/open`) {
      if (barrier) await barrier;
      if (body?.connectionId === undefined) baseSessions.add(ATLASSIAN);
      return json(200, { state: health });
    }
    if (path === `/sessions/${ATLASSIAN}/tools`) {
      return json(200, {
        tools: advertised.map((t) => ({
          ...t, definitionHash: Buffer.from(`${t.name}:${t.description}`).toString("hex").padEnd(64, "0").slice(0, 64),
        })),
        state: health,
      });
    }
    if (path === `/sessions/${ATLASSIAN}/state`) return json(200, { state: health });
    return json(404, { error: { code: "NOT_FOUND", message: path } });
  });
  return {
    calls,
    memberSessions,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    opens: () => calls.filter((c) => c.method === "POST" && c.path === `/sessions/${ATLASSIAN}/open`).map((c) => c.body ?? {}),
    deletes: () => calls.filter((c) => c.method === "DELETE"),
    hasBase: () => baseSessions.size > 0,
    /** What the vendor advertises from now on (a listing then updates the client's last-advertised names). */
    advertise: (list: McpToolDescriptor[]) => { advertised = list; },
    hold: () => { barrier = new Promise<void>((r) => { release = r; }); },
    letGo: () => { release?.(); barrier = null; },
  };
}

/** The admin-owned connection row; a sign-in-only box holds no API token. Tests may change it. */
let integrationRow: { id: string; status: string; providerTokensEnc: string | null; providerConfig: unknown };

let bridge: ReturnType<typeof bridgeModel>;
let fdb: ReturnType<typeof fakeMcpOAuthDb>;
let prisma: Parameters<typeof ensureRemoteMcpAttached>[0];

function makePrisma() {
  const record = new Map<string, RemoteToolClassificationRow>();
  const keyOf = (w: { serverId_toolName: { serverId: string; toolName: string } }) => `${w.serverId_toolName.serverId} ${w.serverId_toolName.toolName}`;
  return {
    // A sign-in-only box: the admin saved the site id and no API token.
    integrationConnection: {
      findFirst: vi.fn(async () => ({ ...integrationRow })),
    },
    mcpOAuthConnection: fdb.prisma.mcpOAuthConnection,
    user: fdb.prisma.user,
    remoteToolClassification: {
      findUnique: vi.fn(async (a: { where: Parameters<typeof keyOf>[0] }) => record.get(keyOf(a.where)) ?? null),
      upsert: vi.fn(async (a: { where: Parameters<typeof keyOf>[0]; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const k = keyOf(a.where);
        const existing = record.get(k);
        const row = existing ? { ...existing, ...a.update } : ({ reviewedBy: null, reviewedAt: null, ...a.create } as RemoteToolClassificationRow);
        record.set(k, row as RemoteToolClassificationRow);
        return row;
      }),
      findMany: vi.fn(async () => [...record.values()]),
    },
  };
}

async function seedMember(id: string, memberId: string, token: string): Promise<void> {
  fdb.setUser({ id: memberId, username: memberId, role: "owner" });
  const r = await fdb.seed({
    id, provider: ATLASSIAN, scope: "MEMBER", memberId, state: "CONNECTED", issuer: "https://auth.example/iss",
    tokenEndpointHost: "auth.example", clientId: "c", tokensEnc: "x", tokenExpiresAt: new Date("2100-01-01T00:00:00Z"),
  });
  r.tokensEnc = blobFor(r, token);
}
async function seedWorkspace(id: string, token: string): Promise<void> {
  const r = await fdb.seed({
    id, provider: ATLASSIAN, scope: "WORKSPACE", memberId: null, state: "CONNECTED", issuer: "https://auth.example/iss",
    tokenEndpointHost: "auth.example", clientId: "c", tokensEnc: "x", tokenExpiresAt: new Date("2100-01-01T00:00:00Z"),
    workspaceAckAt: new Date(), workspaceAckBy: "boss",
  });
  r.tokensEnc = blobFor(r, token);
}
const blobFor = (r: { id: string; scope: "MEMBER" | "WORKSPACE"; memberId: string | null }, accessToken: string): string =>
  sealTokens(r, {
    accessToken, refreshToken: "r", expiresAt: "2100-01-01T00:00:00.000Z", scope: "s",
    tokenEndpoint: "https://auth.example/token", resource: "res", mcpUrl: "res",
  });
const reseal = (id: string, token: string): void => {
  const r = fdb.rows.find((x) => x.id === id)!;
  r.tokensEnc = blobFor(r, token);
};

beforeEach(async () => {
  vi.clearAllMocks();
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 7).toString("base64"));
  bridge = bridgeModel();
  vi.stubGlobal("fetch", bridge.fetchImpl);
  fdb = fakeMcpOAuthDb();
  integrationRow = { id: "conn_atlassian_0000000001", status: "CONNECTED", providerTokensEnc: null, providerConfig: { cloudId: CLOUD } };
  prisma = makePrisma() as never;
  for (const id of mcpClient.remoteServerIds()) mcpClient.detachRemote(id);
  runtimeToolRegistry.unregisterServer(ATLASSIAN);
  await detachRemoteMcp(ATLASSIAN);
  for (const reg of remoteMcpLifecycle.list()) remoteMcpLifecycle.unregister(reg.serverId);
  recordCatalog(ATLASSIAN, null);
  remoteToolClassificationCache.seed([]);
  bridge.calls.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

/** The admin's API-token connection died (NEEDS_RECONNECT) but still holds a token sealed with the REAL ADR-042 seal. */
const deadApiConnection = (): void => {
  integrationRow.status = "NEEDS_RECONNECT";
  integrationRow.providerTokensEnc = sealSaasCredentials(integrationRow.id, { apiToken: "ATATT-FAKE-REAL-SEAL-000000" });
  integrationRow.providerConfig = { email: "ops@vendor.example", cloudId: CLOUD };
};

const attach = async () => {
  const [r] = await ensureRemoteMcpAttached(prisma, [registration()]);
  expect(r?.attached).toBe(true);
  bridge.calls.length = 0;
};

describe("a refresh of the backing row re-opens the base session IN PLACE", () => {
  it("opens again with the new token, the lifecycle's vettedTools and catalogOnly; no DELETE; member sessions and the tools stay", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    const [first] = await ensureRemoteMcpAttached(prisma, [registration()]);
    expect(first?.attached).toBe(true);
    expect(bridge.opens()[0]).toMatchObject({ accessToken: "token-1", cloudId: CLOUD, catalogOnly: true });
    expect(catalogBackingRow(ATLASSIAN)).toBe(OWNER_ROW); // recorded by the real attach
    const vetted = [...remoteMcpLifecycle.get(ATLASSIAN)!.vettedTools];
    expect(vetted.sort()).toEqual(["getConfluencePage", "getJiraIssue"]);
    bridge.calls.length = 0;

    reseal(OWNER_ROW, "token-2");
    await catalogSignInChanged(ATLASSIAN, OWNER_ROW, "refreshed");

    const opens = bridge.opens();
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ accessToken: "token-2", cloudId: CLOUD, catalogOnly: true });
    expect([...(opens[0]!.knownTools as string[])].sort()).toEqual(vetted); // lifecycle names, not a listing
    expect(bridge.deletes()).toHaveLength(0);
    expect(bridge.calls.filter((c) => c.path.endsWith("/close"))).toHaveLength(0);
    expect(bridge.memberSessions.has("a-member-session")).toBe(true);
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "attached", reason: null });
    expect(mcpClient.remoteServerIds()).toContain(ATLASSIAN);
    expect(catalogBackingRow(ATLASSIAN)).toBe(OWNER_ROW);
  });

  it("a row that backs nothing is ignored", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    await catalogSignInChanged(ATLASSIAN, "99999999-9999-4999-8999-999999999999", "refreshed");
    expect(bridge.opens()).toHaveLength(0);
  });

  it("does nothing to a catalog_changed server: no open, still catalog_changed", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    remoteMcpLifecycle.record({ serverId: ATLASSIAN, state: "detached", reason: "catalog_changed" });
    reseal(OWNER_ROW, "token-2");
    await catalogSignInChanged(ATLASSIAN, OWNER_ROW, "refreshed");
    expect(bridge.opens()).toHaveLength(0);
    expect(bridge.deletes()).toHaveLength(0);
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "detached", reason: "catalog_changed" });
  });

  it("with the server turned off (DISABLED), nothing re-opens", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    integrationRow.status = "DISABLED";
    reseal(OWNER_ROW, "token-2");
    await catalogSignInChanged(ATLASSIAN, OWNER_ROW, "refreshed");
    expect(bridge.opens()).toHaveLength(0);
  });
});

describe("when the backing sign-in stops working the choice is re-run", () => {
  it("a disconnect landing mid-repick is not dropped: a second run re-picks, and with nothing left detaches exactly once", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    bridge.hold();
    reseal(OWNER_ROW, "token-2");
    const first = catalogSignInChanged(ATLASSIAN, OWNER_ROW, "refreshed");
    await vi.waitFor(() => expect(bridge.opens()).toHaveLength(1)); // parked inside the open

    const row = fdb.rows.find((r) => r.id === OWNER_ROW)!;
    Object.assign(row, { state: "DISCONNECTED", tokensEnc: null }); // the disconnect lands mid-repick
    const second = catalogSignInChanged(ATLASSIAN, OWNER_ROW, "ended");
    bridge.letGo();
    await Promise.all([first, second]);

    expect(bridge.deletes()).toHaveLength(1);
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "detached", reason: "credential_incomplete" });
    expect(mcpClient.remoteServerIds()).not.toContain(ATLASSIAN);
    expect(catalogBackingRow(ATLASSIAN)).toBeUndefined();
  });

  it("the real disconnect hook (default dependencies) re-picks: nothing qualifies, one detach with credential_incomplete", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    const deps = mcpOAuthDependencies({ oauth: { revoke: async () => {} } as never, egress: async () => ({ allowed: true, row: null }) });
    expect(await disconnectMcpOAuth(prisma as never, OWNER_ROW, { id: "u-owner", role: "owner" }, deps)).toBe(true);
    await vi.waitFor(() => expect(bridge.deletes()).toHaveLength(1));
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "detached", reason: "credential_incomplete" });
  });

  it("a deactivated backing owner, skipped by the renewal tick, is re-picked onto the Workspace connection (no catalogOnly)", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    await seedWorkspace(WS_ROW, "ws-token");
    fdb.setUser({ id: "u-owner", username: "u-owner", role: "owner", directoryStatus: "DEACTIVATED" });
    const refresh = vi.fn();
    const refresher = createMcpOAuthRefresher({
      prisma: prisma as never, oauth: { refresh } as never, egress: async () => ({ allowed: true, row: null }),
      catalogChanged: catalogSignInChanged, // exactly what index.ts wires
    });
    await refresher.tick();
    await vi.waitFor(() => expect(bridge.opens()).toHaveLength(1));
    expect(bridge.opens()[0]).toMatchObject({ accessToken: "ws-token", cloudId: CLOUD });
    expect(bridge.opens()[0]).not.toHaveProperty("catalogOnly");
    expect(refresh).not.toHaveBeenCalled(); // the leaver's grant was not renewed
    expect(catalogBackingRow(ATLASSIAN)).toBe(WS_ROW);
    expect(bridge.deletes()).toHaveLength(0);
  });

  it("a deactivated backing owner with no other candidate: exactly one detach, credential_incomplete", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    fdb.setUser({ id: "u-owner", username: "u-owner", role: "owner", deletionStatus: "PENDING" });
    const refresher = createMcpOAuthRefresher({
      prisma: prisma as never, oauth: { refresh: vi.fn() } as never, egress: async () => ({ allowed: true, row: null }),
      catalogChanged: catalogSignInChanged,
    });
    await refresher.tick();
    await vi.waitFor(() => expect(bridge.deletes()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 25));
    expect(bridge.deletes()).toHaveLength(1);
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "detached", reason: "credential_incomplete" });
  });

  it("a backing owner demoted to family is not re-used", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    fdb.setUser({ id: "u-owner", username: "u-owner", role: "family" });
    reseal(OWNER_ROW, "token-2");
    await catalogSignInChanged(ATLASSIAN, OWNER_ROW, "refreshed");
    expect(bridge.opens()).toHaveLength(0); // never re-opened on a regular member's token
    expect(bridge.deletes()).toHaveLength(1);
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "detached", reason: "credential_incomplete" });
  });
});

describe("the re-open never widens what was vetted, never dials after a refusal, and loses to the kill switch", () => {
  it("the open's knownTools is the VETTED list even when the vendor now advertises more", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    const vetted = [...remoteMcpLifecycle.get(ATLASSIAN)!.vettedTools].sort();
    // The vendor adds a tool and a listing happens: the client's last-advertised names now differ from the vetted ones.
    bridge.advertise([...TOOLS, { name: "deleteEverything", description: "new and unreviewed", inputSchema: { type: "object" } }]);
    await mcpClient.listTools();
    expect(bridge.calls.some((c) => c.path === `/sessions/${ATLASSIAN}/tools`)).toBe(true); // the listing really happened
    expect([...remoteMcpLifecycle.get(ATLASSIAN)!.vettedTools].sort()).toEqual(vetted); // the vetted baseline did not move
    bridge.calls.length = 0;

    reseal(OWNER_ROW, "token-2");
    await catalogSignInChanged(ATLASSIAN, OWNER_ROW, "refreshed");

    const known = bridge.opens()[0]!.knownTools as string[];
    expect([...known].sort()).toEqual(vetted);
    expect(known).not.toContain("deleteEverything");
  });

  it("any gate refusal other than 'not now' detaches without reading a credential or opening: a NEEDS_RECONNECT API-token row is not dialled", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    // The API connection died but still holds a REAL sealed token (the real seal, so it would open
    // and be used if anything read it); the only sign-in then ends.
    deadApiConnection();
    Object.assign(fdb.rows.find((r) => r.id === OWNER_ROW)!, { state: "DISCONNECTED", tokensEnc: null });
    await catalogSignInChanged(ATLASSIAN, OWNER_ROW, "ended");

    expect(bridge.opens()).toHaveLength(0);
    expect(bridge.deletes()).toHaveLength(1);
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "detached", reason: "credential_incomplete" });
    expect(mcpClient.remoteServerIds()).not.toContain(ATLASSIAN);
  });

  it("a connected sign-in lets the gate pass, but a NEEDS_RECONNECT API row's real token is still never used", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    // A regular member's sign-in is CONNECTED: the gate passes (a credential exists), but it cannot back the catalog.
    fdb.setUser({ id: "u-fam", username: "u-fam", role: "family" });
    await fdb.seed({
      id: "44444444-4444-4444-8444-444444444444", provider: ATLASSIAN, scope: "MEMBER", memberId: "u-fam", state: "CONNECTED",
      issuer: "https://auth.example/iss", tokenEndpointHost: "auth.example", clientId: "c", tokensEnc: "x",
      tokenExpiresAt: new Date("2100-01-01T00:00:00Z"),
    });
    deadApiConnection();
    Object.assign(fdb.rows.find((r) => r.id === OWNER_ROW)!, { state: "DISCONNECTED", tokensEnc: null });
    await catalogSignInChanged(ATLASSIAN, OWNER_ROW, "ended");

    expect(bridge.opens()).toHaveLength(0); // neither the dead API token nor the family member's token
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "detached", reason: "credential_incomplete" });
  });

  it("a kill switch issued while a re-pick awaits its open WAITS behind it (the lock), then leaves no base session and no 'attached'", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    bridge.hold();
    reseal(OWNER_ROW, "token-2");
    const repick = catalogSignInChanged(ATLASSIAN, OWNER_ROW, "refreshed");
    await vi.waitFor(() => expect(bridge.opens()).toHaveLength(1)); // parked inside the bridge open

    const teardown = tearDownRemoteServer(ATLASSIAN); // an owner or admin turns the server off right now
    await new Promise((r) => setTimeout(r, 25));
    expect(bridge.deletes()).toHaveLength(0); // still queued behind the re-pick: nothing closed yet
    expect(mcpClient.remoteServerIds()).toContain(ATLASSIAN);

    bridge.letGo();
    await Promise.all([repick, teardown]);

    expect(bridge.hasBase()).toBe(false); // the open's session was closed by the teardown that came after it
    expect(bridge.deletes().length).toBeGreaterThanOrEqual(1);
    expect(remoteMcpLifecycle.get(ATLASSIAN)?.state).not.toBe("attached");
    expect(mcpClient.remoteServerIds()).not.toContain(ATLASSIAN);
  });

  it("an attach of the same server queues behind a running re-pick: its bridge open is not made until the re-pick is done", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    await attach();
    bridge.hold();
    reseal(OWNER_ROW, "token-2");
    const repick = catalogSignInChanged(ATLASSIAN, OWNER_ROW, "refreshed");
    await vi.waitFor(() => expect(bridge.opens()).toHaveLength(1));

    const attachAgain = ensureRemoteMcpAttached(prisma, [registration()]).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 25));
    expect(bridge.opens()).toHaveLength(1); // without the lock the attach would already have opened its own session

    bridge.letGo();
    await Promise.all([repick, attachAgain]);
    expect(bridge.opens().length).toBeGreaterThanOrEqual(2); // it ran, after
  });

  it("the kill switch also covers a boot attach that is still in flight", async () => {
    await seedMember(OWNER_ROW, "u-owner", "token-1");
    bridge.hold();
    const boot = ensureRemoteMcpAttached(prisma, [registration()]).catch(() => undefined);
    await vi.waitFor(() => expect(bridge.opens()).toHaveLength(1)); // the attach is parked in its open
    const teardown = tearDownRemoteServer(ATLASSIAN);
    await new Promise((r) => setTimeout(r, 25));
    expect(bridge.deletes()).toHaveLength(0);

    bridge.letGo();
    await Promise.all([boot, teardown]);

    expect(bridge.hasBase()).toBe(false); // what the attach opened was closed right after
    expect(remoteMcpLifecycle.get(ATLASSIAN)?.state).not.toBe("attached");
    expect(mcpClient.remoteServerIds()).not.toContain(ATLASSIAN);
  });
});

describe("wiring", () => {
  it("index.ts hands the refresh job the singleton's catalog hook", () => {
    const src = readFileSync(join(REPO_ROOT, "apps", "orchestrator", "src", "index.ts"), "utf-8");
    expect(src).toMatch(/mountMcpOAuthRefresh\([\s\S]*?catalogChanged:\s*catalogSignInChanged/);
  });
});
