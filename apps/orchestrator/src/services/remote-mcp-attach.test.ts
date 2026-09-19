/**
 * WARP-2627 — the end-to-end attach path, through the REAL objects.
 *
 * Everything below the injected `fetch` is shipped code: the real
 * `McpBridgeClient`, the real gate, the real `McpToolMultiplexer`, the real
 * `syncRemoteCatalog`. The only double is the bridge itself — a fixture served
 * by an injected `fetchImpl`, never a globally patched `fetch` — so a refusal
 * that is supposed to happen BEFORE the network can be asserted as zero calls
 * rather than inferred from a missing result.
 *
 * Credential fixtures are obviously fake (`ATATT-FAKE-000000000000`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpBridgeClient } from "./mcp-bridge.client.js";
import { McpToolMultiplexer, type RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import {
  ATLASSIAN_REMOTE_SERVER_ID,
  attachAtlassianRemote,
  detachRemoteServer,
  type RemoteMcpConnectionRow,
} from "./remote-mcp-servers.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";
const FAKE_API_TOKEN = "ATATT-FAKE-000000000000";
const CONNECTION_ID = "conn_atlassian_fixture";

const READY_STATE = {
  serverId: ATLASSIAN_REMOTE_SERVER_ID,
  state: "ready",
  toolCount: 2,
  consecutiveFailures: 0,
  lastReadyAt: 1,
  reason: null,
};

const WIRE_TOOLS: McpToolDescriptor[] = [
  { name: "getJiraIssue", description: "Read one Jira issue", inputSchema: { type: "object" } },
  { name: "getConfluencePage", description: "Read one page", inputSchema: { type: "object" } },
];

/** A local port with one tool, so the union catalog is never empty and a
 *  "no remote tools" assertion is about the remote half specifically. */
function localPort(): McpClientPort {
  return {
    isStarted: true,
    listTools: async () => [
      { name: "list_files", description: "local", inputSchema: { type: "object" } },
    ],
    callTool: async () => ({ content: [], isError: false }),
  };
}

/** The fixture bridge. Every call it serves is recorded. */
function fixtureBridge() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BRIDGE_URL, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/open")) return json(200, { state: READY_STATE });
    // WARP-2659 — the close. The bridge answers a session it holds with 200.
    if (init?.method === "DELETE") return json(200, { closed: true });
    if (path.endsWith("/tools")) return json(200, { tools: WIRE_TOOLS, state: READY_STATE });
    if (path.endsWith("/call")) {
      return json(200, {
        result: { content: [{ type: "text", text: "{}" }], isError: false },
        state: READY_STATE,
      });
    }
    return json(404, { error: { code: "NOT_FOUND", message: path } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const connectedRow: RemoteMcpConnectionRow = {
  id: CONNECTION_ID,
  status: "CONNECTED",
  providerTokensEnc: "dcv1:sealed",
  providerConfig: { email: "ops@vendor.example", cloudId: "00000000-0000-4000-8000-000000000000" },
};

/**
 * A prisma double whose row can CHANGE between calls — which is the only way
 * to test that the gate is re-read per call rather than captured at attach.
 */
function prismaWith(row: RemoteMcpConnectionRow | null) {
  const state = { row };
  return {
    state,
    integrationConnection: { findFirst: vi.fn(async () => state.row) },
  };
}

/** Allow every Atlassian read through, so the catalog-visibility assertions are
 *  about the ATTACH and not about the (separately tested) v1 read list. */
const allowAll: RemoteCallPolicy = () => ({ kind: "allow" });

function harness(over: { allowlist?: string[]; row?: RemoteMcpConnectionRow | null } = {}) {
  const bridge = fixtureBridge();
  const mux = new McpToolMultiplexer(localPort(), {
    isServerAllowed: (id) => (over.allowlist ?? []).includes(id),
    remoteCallPolicy: allowAll,
  });
  const registry = new RuntimeToolRegistry();
  const prisma = prismaWith(over.row === undefined ? connectedRow : over.row);
  return {
    bridge,
    mux,
    registry,
    prisma,
    attach: () =>
      attachAtlassianRemote({
        mux,
        prisma,
        allowlist: new Set(over.allowlist ?? []),
        registry,
        createClient: () =>
          new McpBridgeClient({
            baseUrl: BRIDGE_URL,
            serviceToken: BRIDGE_TOKEN,
            serverId: ATLASSIAN_REMOTE_SERVER_ID,
            fetchImpl: bridge.fetchImpl,
          }),
        openCredentials: () => ({ apiToken: FAKE_API_TOKEN }),
      }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the empty allowlist is the shipping default (WARP-2418 / WARP-2627)", () => {
  it("attaches nothing, advertises nothing remote, and NEVER dials the bridge", async () => {
    const h = harness({ allowlist: [] });

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "not_allowlisted" });

    // The assertion that matters: zero calls, not "no tools came back".
    expect(h.bridge.calls).toHaveLength(0);
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
    // The gate refuses before the row is even read.
    expect(h.prisma.integrationConnection.findFirst).not.toHaveBeenCalled();

    const tools = await h.mux.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_files"]);
    expect(tools.some((t) => t.name.startsWith("atlassian__"))).toBe(false);
    expect(h.mux.remoteServerIds()).toEqual([]);
  });
});

describe("allowlisted + a CONNECTED row with a credential", () => {
  it("attaches and advertises the namespaced Atlassian tools", async () => {
    const h = harness({ allowlist: ["atlassian"] });

    const result = await h.attach();
    expect(result.attached).toBe(true);

    const tools = await h.mux.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_files",
      "atlassian__getJiraIssue",
      "atlassian__getConfluencePage",
    ]);

    // The catalog reached tool selection with the OPERATOR's domain, not one a
    // vendor declared for itself.
    expect(result.attached && result.sync.registered.map((t) => t.name)).toEqual([
      "atlassian__getJiraIssue",
      "atlassian__getConfluencePage",
    ]);
    expect(result.attached && result.sync.registered.every((t) => t.domain === "pm")).toBe(true);
    expect(
      result.attached && result.sync.registered.every((t) => t.domainSource === "operator"),
    ).toBe(true);
  });

  it("sends the credential to the bridge and NOTHING else", async () => {
    const h = harness({ allowlist: ["atlassian"] });
    await h.attach();
    const open = h.bridge.calls.find((c) => c.path.endsWith("/open"));
    expect(open?.body).toEqual({
      email: "ops@vendor.example",
      apiToken: FAKE_API_TOKEN,
      cloudId: "00000000-0000-4000-8000-000000000000",
    });
  });

  it("routes a remote dispatch through the bridge, not through a local socket", async () => {
    const h = harness({ allowlist: ["atlassian"] });
    await h.attach();
    const out = await h.mux.callTool("atlassian__getJiraIssue", { issueKey: "WARP-1" });
    expect(out.isError).toBe(false);
    const call = h.bridge.calls.find((c) => c.path.endsWith("/call"));
    expect(call?.body).toEqual({ name: "getJiraIssue", args: { issueKey: "WARP-1" } });
  });

  it("re-reads the gate on EVERY call — disconnecting mid-session stops the next one", async () => {
    // The reason the port takes a gate FUNCTION rather than a decision. An
    // operator who disconnects the account has to stop reaching the vendor on
    // the next call, not on the next reboot — and a session already attached is
    // exactly the case where a captured decision would keep working.
    const h = harness({ allowlist: ["atlassian"] });
    await h.attach();
    const before = await h.mux.callTool("atlassian__getJiraIssue", {});
    expect(before.isError).toBe(false);

    h.prisma.state.row = { ...connectedRow, status: "DISABLED" };

    const callsBefore = h.bridge.calls.filter((c) => c.path.endsWith("/call")).length;
    const after = await h.mux.callTool("atlassian__getJiraIssue", {});
    expect(after.isError).toBe(true);
    expect(JSON.parse(after.content[0]!.text!)).toMatchObject({
      error: "REMOTE_MCP_GATE_REFUSED",
    });
    // And it did not dial: the refusal is a refusal, not a failed call.
    expect(h.bridge.calls.filter((c) => c.path.endsWith("/call"))).toHaveLength(callsBefore);
  });
});

describe("the connection row is read as two EXPLICIT columns", () => {
  it("refuses a row that is not CONNECTED, without dialling", async () => {
    const h = harness({
      allowlist: ["atlassian"],
      row: { ...connectedRow, status: "NEEDS_RECONNECT" },
    });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.calls).toHaveLength(0);
    expect((await h.mux.listTools()).some((t) => t.name.startsWith("atlassian__"))).toBe(false);
  });

  it("refuses a CONNECTED row whose credential was purged, without dialling", async () => {
    const h = harness({
      allowlist: ["atlassian"],
      row: { ...connectedRow, providerTokensEnc: null },
    });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.calls).toHaveLength(0);
  });

  it("refuses when there is no row at all", async () => {
    const h = harness({ allowlist: ["atlassian"], row: null });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.calls).toHaveLength(0);
  });

  it("names the MISSING field when providerConfig is incomplete, and leaks no value", async () => {
    const h = harness({
      allowlist: ["atlassian"],
      row: { ...connectedRow, providerConfig: { email: "ops@vendor.example" } },
    });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(result.attached === false && result.message).toContain("cloudId");
    expect(result.attached === false && result.message).not.toContain(FAKE_API_TOKEN);
    expect(h.bridge.calls).toHaveLength(0);
  });
});

describe("the bearer is fail-closed at the orchestrator end too", () => {
  it("never dials when MCP_BRIDGE_SERVICE_TOKEN is unset", async () => {
    const bridge = fixtureBridge();
    const mux = new McpToolMultiplexer(localPort(), {
      isServerAllowed: () => true,
      remoteCallPolicy: allowAll,
    });
    const result = await attachAtlassianRemote({
      mux,
      prisma: prismaWith(connectedRow),
      allowlist: new Set(["atlassian"]),
      registry: new RuntimeToolRegistry(),
      createClient: () =>
        new McpBridgeClient({
          baseUrl: BRIDGE_URL,
          serviceToken: "",
          serverId: ATLASSIAN_REMOTE_SERVER_ID,
          fetchImpl: bridge.fetchImpl,
        }),
      openCredentials: () => ({ apiToken: FAKE_API_TOKEN }),
    });
    expect(result).toMatchObject({ attached: false, reason: "bridge_unavailable" });
    expect(bridge.fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * WARP-2659 — the disconnect half.
 *
 * `disconnect()`'s purge reaches the row; it cannot reach the three things an
 * attach leaves in this process and on the bridge. These pin that a detach
 * reaches all three, and that it is safe to call when there is nothing to
 * reach.
 */
describe("detach — the disconnect path (WARP-2659)", () => {
  it("closes the bridge session, drops the multiplexer entry and unregisters the runtime tools", async () => {
    const h = harness({ allowlist: ["atlassian"] });
    const attached = await h.attach();
    if (!attached.attached) throw new Error("fixture did not attach");
    expect(h.registry.list().map((t) => t.name)).toEqual([
      "atlassian__getJiraIssue",
      "atlassian__getConfluencePage",
    ]);

    const result = await detachRemoteServer({
      mux: h.mux,
      serverId: ATLASSIAN_REMOTE_SERVER_ID,
      client: attached.client,
      registry: h.registry,
    });
    expect(result).toEqual({ serverId: "atlassian", detached: true, sessionClosed: true });

    // The bridge was TOLD, not merely forgotten — the session held the token.
    // Mutation: drop the `client.close()` call → red.
    expect(
      h.bridge.calls.some((c) => c.method === "DELETE" && c.path === "/sessions/atlassian"),
    ).toBe(true);
    expect(attached.client.isStarted).toBe(false);
    // Mutation: drop `mux.detachRemote` → red on the next two.
    expect(h.mux.remoteServerIds()).toEqual([]);
    expect((await h.mux.listTools()).map((t) => t.name)).toEqual(["list_files"]);
    // Mutation: drop `unregisterRemoteServer` → red.
    expect(h.registry.list()).toEqual([]);
  });

  it("is idempotent — a server that was never attached detaches nothing and dials nothing", async () => {
    const h = harness({ allowlist: [] });
    const result = await detachRemoteServer({
      mux: h.mux,
      serverId: ATLASSIAN_REMOTE_SERVER_ID,
      registry: h.registry,
    });
    expect(result).toEqual({ serverId: "atlassian", detached: false, sessionClosed: false });
    expect(h.bridge.calls).toHaveLength(0);
  });

  it("still detaches in-process when the bridge cannot be reached", async () => {
    const h = harness({ allowlist: ["atlassian"] });
    const attached = await h.attach();
    if (!attached.attached) throw new Error("fixture did not attach");
    const unreachable = new McpBridgeClient({
      baseUrl: BRIDGE_URL,
      serviceToken: BRIDGE_TOKEN,
      serverId: ATLASSIAN_REMOTE_SERVER_ID,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    const result = await detachRemoteServer({
      mux: h.mux,
      serverId: ATLASSIAN_REMOTE_SERVER_ID,
      client: unreachable,
      registry: h.registry,
    });
    // Told, and refused — which is not a reason to keep advertising the tools.
    expect(result).toEqual({ serverId: "atlassian", detached: true, sessionClosed: true });
    expect(h.mux.remoteServerIds()).toEqual([]);
    expect(h.registry.list()).toEqual([]);
  });
});
