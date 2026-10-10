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
 * Credential fixtures are obviously fake (`FAKE-ACCESS-…`), and the only credential
 * is a CONNECTED sign-in (WARP-3961; see `__fixtures__/signed-in-db.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpBridgeClient } from "./mcp-bridge.client.js";
import { remoteToolReviewHash } from "./remote-tool-classification.service.js";
import { McpToolMultiplexer, type RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import {
  ATLASSIAN_REMOTE_SERVER_ID,
  attachAtlassianRemote,
  detachRemoteServer,
} from "./remote-mcp-servers.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";
import { FAKE_ACCESS, SITE_ID, signedInDb, type SignInSeed } from "./__fixtures__/signed-in-db.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";

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
function fixtureBridge(getTools: () => unknown[] = () => WIRE_TOOLS) {
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
    if (path.endsWith("/tools")) return json(200, { tools: getTools(), state: READY_STATE });
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

/**
 * A prisma double over fake sign-ins (WARP-3961: a CONNECTED sign-in is the only
 * credential). `integration` can CHANGE between calls — the only way to test that
 * the gate is re-read per call rather than captured at attach.
 */
async function prismaWith(opts: { signIns?: SignInSeed[]; integration?: { status: string } | null } = {}) {
  const w = await signedInDb(opts.signIns ?? [{ scope: "WORKSPACE" }], opts.integration ?? null);
  return { state: w.state, prisma: w.prisma };
}

/** Allow every Atlassian read through, so the catalog-visibility assertions are
 *  about the ATTACH and not about the (separately tested) v1 read list. */
const allowAll: RemoteCallPolicy = () => ({ kind: "allow" });

async function harness(
  over: { allowlist?: string[]; signIns?: SignInSeed[]; integration?: { status: string } | null; tools?: () => unknown[] } = {},
) {
  const bridge = fixtureBridge(over.tools);
  const mux = new McpToolMultiplexer(localPort(), {
    isServerAllowed: (id) => (over.allowlist ?? []).includes(id),
    remoteCallPolicy: allowAll,
  });
  const registry = new RuntimeToolRegistry();
  const db = await prismaWith({
    ...(over.signIns ? { signIns: over.signIns } : {}),
    ...(over.integration !== undefined ? { integration: over.integration } : {}),
  });
  const prisma = db.prisma;
  // WARP-2426 — the classification recorder, spied: the attach is the ONE
  // import path into the record, and the test below says which names cross it.
  const recordClassifications = vi.fn(async () => undefined);
  return {
    bridge,
    mux,
    registry,
    prisma,
    state: db.state,
    recordClassifications,
    attach: (extra: Partial<Parameters<typeof attachAtlassianRemote>[0]> = {}) =>
      attachAtlassianRemote({
        mux,
        prisma,
        registry,
        recordClassifications,
        createClient: () =>
          new McpBridgeClient({
            baseUrl: BRIDGE_URL,
            serviceToken: BRIDGE_TOKEN,
            serverId: ATLASSIAN_REMOTE_SERVER_ID,
            fetchImpl: bridge.fetchImpl,
          }),
        ...extra,
      }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a box with no sign-in is the default (WARP-2418 / WARP-2627 / WARP-3960 / WARP-3961)", () => {
  it("attaches nothing, advertises nothing remote, and NEVER dials the bridge", async () => {
    // No env, no owner switch (WARP-3960): the only thing between this box and an
    // attach is a CONNECTED sign-in, and there is none.
    const h = await harness({ allowlist: ["atlassian"], signIns: [] });

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });

    // The assertion that matters: zero calls, not "no tools came back".
    expect(h.bridge.calls).toHaveLength(0);
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();

    const tools = await h.mux.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_files"]);
    expect(tools.some((t) => t.name.startsWith("atlassian__"))).toBe(false);
    expect(h.mux.remoteServerIds()).toEqual([]);
  });
});

describe("a CONNECTED sign-in (no env, no channel row, no connection row)", () => {
  it("attaches and advertises the namespaced Atlassian tools", async () => {
    const h = await harness({ allowlist: ["atlassian"] });

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

  it("records every advertised tool in the classification record, by WIRE name, on the attach (WARP-2426)", async () => {
    const h = await harness({ allowlist: ["atlassian"] });
    const result = await h.attach();
    expect(result.attached).toBe(true);
    // MUTATION: drop the record step from attachAtlassianRemote and this goes
    // red — the tools would be advertised with no row, and refused at dispatch
    // as unclassified forever, with nothing for an operator to demote.
    expect(h.recordClassifications).toHaveBeenCalledTimes(1);
    const [serverId, tools] = h.recordClassifications.mock.calls[0] as unknown as [
      string,
      Array<{ name: string }>,
    ];
    expect(serverId).toBe("atlassian");
    expect(tools.map((t) => t.name)).toEqual(["getJiraIssue", "getConfluencePage"]);
  });

  it("does not record anything when the attach is refused", async () => {
    const h = await harness({ allowlist: ["atlassian"], signIns: [] });
    await h.attach();
    expect(h.recordClassifications).not.toHaveBeenCalled();
  });

  it("sends the bearer and the sign-in's pinned site to the bridge and NOTHING else", async () => {
    const h = await harness({ allowlist: ["atlassian"] });
    await h.attach();
    const open = h.bridge.calls.find((c) => c.path.endsWith("/open"));
    // The site is the sign-in row's own `siteId`. MUTATION: read it from anywhere
    // else (an IntegrationConnection, the model) and this goes red.
    expect(open?.body).toEqual({ accessToken: FAKE_ACCESS, cloudId: SITE_ID });
  });

  it("routes a remote dispatch through the bridge, not through a local socket", async () => {
    const h = await harness({ allowlist: ["atlassian"] });
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
    const h = await harness({ allowlist: ["atlassian"] });
    await h.attach();
    const before = await h.mux.callTool("atlassian__getJiraIssue", {});
    expect(before.isError).toBe(false);

    h.state.integration = { status: "DISABLED" };

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

describe("the sign-in is read from its EXPLICIT state column", () => {
  it("refuses a sign-in that is not CONNECTED, without dialling", async () => {
    const h = await harness({ allowlist: ["atlassian"], signIns: [{ scope: "WORKSPACE", state: "NEEDS_RECONNECT" }] });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.calls).toHaveLength(0);
    expect((await h.mux.listTools()).some((t) => t.name.startsWith("atlassian__"))).toBe(false);
  });

  it("refuses a DISABLED connection (the per-server off) whatever sign-ins exist, without dialling", async () => {
    const h = await harness({ allowlist: ["atlassian"], integration: { status: "DISABLED" } });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.calls).toHaveLength(0);
  });

  it("refuses when there is no sign-in at all", async () => {
    const h = await harness({ allowlist: ["atlassian"], signIns: [] });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.calls).toHaveLength(0);
  });

  it("a CONNECTED sign-in with no pinned site is not a credential: credential_incomplete, no value leaked, no dial", async () => {
    // A row that predates WARP-3961. MUTATION: open it with a made-up or typed site → red.
    const h = await harness({ allowlist: ["atlassian"], signIns: [{ scope: "WORKSPACE", siteId: null }] });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(result.attached === false && result.message).not.toContain(FAKE_ACCESS);
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
      prisma: (await prismaWith()).prisma,
      registry: new RuntimeToolRegistry(),
      createClient: () =>
        new McpBridgeClient({
          baseUrl: BRIDGE_URL,
          serviceToken: "",
          serverId: ATLASSIAN_REMOTE_SERVER_ID,
          fetchImpl: bridge.fetchImpl,
        }),
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
    const h = await harness({ allowlist: ["atlassian"] });
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
    const h = await harness({ allowlist: [] });
    const result = await detachRemoteServer({
      mux: h.mux,
      serverId: ATLASSIAN_REMOTE_SERVER_ID,
      registry: h.registry,
    });
    expect(result).toEqual({ serverId: "atlassian", detached: false, sessionClosed: false });
    expect(h.bridge.calls).toHaveLength(0);
  });

  it("still detaches in-process when the bridge cannot be reached", async () => {
    const h = await harness({ allowlist: ["atlassian"] });
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

describe("WARP-3918 — tool definitions are pinned by the bridge's hash of the wire object", () => {
  const H1 = "a".repeat(64);
  const H2 = "b".repeat(64);
  const wire = (hash: string) => () => [
    { name: "getJiraIssue", description: "Read one Jira issue", inputSchema: { type: "object" }, definitionHash: hash },
    { name: "getConfluencePage", description: "Read one page", inputSchema: { type: "object" }, definitionHash: "c".repeat(64) },
  ];

  it("hands the recorder each tool's definition hash by WIRE name", async () => {
    const h = await harness({ allowlist: ["atlassian"], tools: wire(H1) });
    await h.attach();
    const [, tools] = h.recordClassifications.mock.calls[0] as unknown as [string, Array<{ name: string; definitionHash?: string }>];
    expect(tools.map((t) => [t.name, t.definitionHash])).toEqual([
      ["getJiraIssue", H1],
      ["getConfluencePage", "c".repeat(64)],
    ]);
  });

  it("a definition that changes mid-session is re-recorded on the next listing, the cache refreshed, THEN the owners told", async () => {
    // MUTATION: drop the onListed hook → the changed tool stays callable until
    // the next re-attach and nobody is told → red.
    let hash = H1;
    const h = await harness({ allowlist: ["atlassian"], tools: () => wire(hash)() });
    const order: string[] = [];
    const record = vi.fn(async (_id: string, _tools: unknown[]) =>
      hash === H2 ? { changes: [{ toolName: "getJiraIssue", descriptionChanged: false }] } : { changes: [] },
    );
    const refreshClassifications = vi.fn(async () => void order.push("refresh"));
    const notifyOwners = vi.fn(async (_t: string, _b: string) => void order.push("notify"));
    await h.attach({ recordClassifications: record, refreshClassifications, notifyOwners });
    expect(record).toHaveBeenCalledTimes(1);
    expect(notifyOwners).not.toHaveBeenCalled();

    // Nothing moved: another listing records nothing.
    await h.mux.listTools();
    expect(record).toHaveBeenCalledTimes(1);

    hash = H2;
    await h.mux.listTools();
    expect(record).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["refresh", "notify"]);
    const [title, body] = notifyOwners.mock.calls[0] as [string, string];
    expect(title).toMatch(/switched off/);
    expect(body).toContain("getJiraIssue");
    expect(body).toContain("arguments or hints");
    expect(body).not.toContain("Read one Jira issue");
  });

  it("publishes the live hashes BEFORE any database write, so a recorder that throws cannot leave a changed tool callable", async () => {
    // MUTATION: publish after the record step → a throwing recorder skips it → red.
    let hash = H1;
    const h = await harness({ allowlist: ["atlassian"], tools: () => wire(hash)() });
    const published: Array<Map<string, string>> = [];
    const setLiveDefinitions = vi.fn((_id: string, m: ReadonlyMap<string, string>) => void published.push(new Map(m)));
    const record = vi.fn(async (_id: string, _tools: unknown[]) => {
      throw new Error("db down");
    });
    const result = await h.attach({ recordClassifications: record, setLiveDefinitions });
    expect(result.attached).toBe(true);
    expect(published[0]?.get("getJiraIssue")).toBe(remoteToolReviewHash("Read one Jira issue", H1));
    hash = H2;
    await h.mux.listTools();
    expect(published[published.length - 1]?.get("getJiraIssue")).toBe(remoteToolReviewHash("Read one Jira issue", H2));
    // The failed write is retried on the next listing.
    expect(record.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a tool with no hash on the listing is absent from the published live hashes", async () => {
    const h = await harness({ allowlist: ["atlassian"] });
    const setLiveDefinitions = vi.fn();
    await h.attach({ setLiveDefinitions });
    expect(setLiveDefinitions).toHaveBeenCalledWith("atlassian", new Map());
  });
});
