/**
 * WARP-3703 (ADR-043 TC-1.1 / TC-1.2) — the attach path is per SERVER, and the
 * provider DESCRIPTOR decides what a session is opened with.
 *
 * Until TC-1 `attachAtlassianRemote` was the only attach function. It is now
 * `attachRemoteServer` for ANY registered mcp descriptor.
 *
 * WARP-3961: the credential-field reader (email / apiToken / providerConfig /
 * sealed bundle) is gone. The only credential is a CONNECTED sign-in
 * (`McpOAuthConnection`), opened as `{ accessToken, cloudId: row.siteId }`, so
 * what this file proves is: the attach is keyed on the server id it was given,
 * the catalog is namespaced and classified under that id, and nothing secret
 * leaks into a message, a lifecycle audit or a log line.
 *
 * `remote-mcp-attach.test.ts`, `remote-mcp-reconciler.test.ts` drive
 * `attachAtlassianRemote` and are the regression net for Atlassian itself.
 *
 * Everything below the injected `fetch` is shipped code: the real
 * `McpBridgeClient`, the real gate, the real `McpToolMultiplexer`, the real
 * `syncRemoteCatalog`. The bridge is a fixture, and the vendors are TEST-ONLY
 * descriptors built in this file and passed in by hand — neither is, or may ever
 * be, in the production provider registry or the allowlist. Credential fixtures
 * are obviously fake and every host is RFC 2606 reserved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  providerDescriptor,
  type McpProviderDescriptor,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import type { ToolDomain } from "@droplet/tools-core";

import { McpBridgeClient } from "./mcp-bridge.client.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import { McpToolMultiplexer, type RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import { RemoteMcpLifecycleRegistry } from "./remote-mcp-lifecycle.service.js";
import {
  ATLASSIAN_REMOTE_SERVER_ID,
  REMOTE_SERVER_DOMAINS,
  attachAtlassianRemote,
  attachRemoteServer,
  registeredRemoteServers,
  remoteServerDomain,
} from "./remote-mcp-servers.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";
import { FAKE_ACCESS, SITE_ID, signedInDb, type SignInSeed } from "./__fixtures__/signed-in-db.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

interface LoggedLine {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}
/** `registeredRemoteServers` reports a server it refuses to register by LOGGING
 *  it, so the log line is the assertion surface. */
const logged = vi.hoisted(() => [] as LoggedLine[]);
vi.mock("../lib/logger.js", () => {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  const stub = {
    warn: push("warn"),
    debug: push("debug"),
    info: push("info"),
    error: push("error"),
    trace: push("trace"),
    fatal: push("fatal"),
    silent: () => {},
    child: () => stub,
  };
  return { createLogger: () => stub };
});

const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";
const FIXTURE_ID = "fixture-bearer";

const TOOLS: McpToolDescriptor[] = [
  { name: "get_thing", description: "Read one thing", inputSchema: { type: "object" } },
  { name: "list_things", description: "List things", inputSchema: { type: "object" } },
];

/** A sign-in-only vendor, as a descriptor: no credential fields (WARP-3961). */
function bearerDescriptor(over: Partial<McpProviderDescriptor> = {}): McpProviderDescriptor {
  return {
    id: FIXTURE_ID,
    displayName: "Fixture sign-in vendor",
    category: "Fixture",
    track: "mcp",
    mcpServerId: FIXTURE_ID,
    description: "Test-only.",
    setupGuideHref: "/help/connectors/fixture-bearer",
    credentialFields: [],
    signIn: { kind: "oauth", pinsSite: true, mcpUrl: "https://mcp.fixture.invalid/mcp", scopes: ["read"] },
    egressHosts: ["mcp.fixture.invalid"],
    datasets: [],
    ...over,
  };
}

function localPort(): McpClientPort {
  return {
    isStarted: true,
    listTools: async () => [
      { name: "list_files", description: "local", inputSchema: { type: "object" } },
    ],
    callTool: async () => ({ content: [], isError: false }),
  };
}

/** The fixture bridge. Every call it serves is recorded, and the body of every
 *  `open` — which is the thing this file is about. */
function fixtureBridge(serverId: string) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const ready = {
    serverId,
    state: "ready",
    toolCount: TOOLS.length,
    consecutiveFailures: 0,
    lastReadyAt: 1,
    reason: null,
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BRIDGE_URL, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/open")) return json(200, { state: ready });
    if (path.endsWith("/state")) return json(200, { state: ready });
    if (init?.method === "DELETE") return json(200, { closed: true });
    if (path.endsWith("/tools")) return json(200, { tools: TOOLS, state: ready });
    if (path.endsWith("/call")) {
      return json(200, {
        result: { content: [{ type: "text", text: "{}" }], isError: false },
        state: ready,
      });
    }
    return json(404, { error: { code: "NOT_FOUND", message: path } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const allowAll: RemoteCallPolicy = () => ({ kind: "allow" });

interface HarnessOptions {
  descriptor?: McpProviderDescriptor;
  /** The fake sign-ins for the fixture server. Default: one CONNECTED Workspace sign-in. `[]` = nobody signed in. */
  signIns?: SignInSeed[];
  integration?: { status: string } | null;
  allowlist?: string[];
  operatorDomain?: ToolDomain;
}

async function harness(over: HarnessOptions = {}) {
  const descriptor = over.descriptor ?? bearerDescriptor();
  const serverId = descriptor.mcpServerId;
  const bridge = fixtureBridge(serverId);
  const allowlist = new Set(over.allowlist ?? [serverId]);
  const mux = new McpToolMultiplexer(localPort(), {
    isServerAllowed: (id) => allowlist.has(id),
    remoteCallPolicy: allowAll,
  });
  const registry = new RuntimeToolRegistry();
  const lifecycle = new RemoteMcpLifecycleRegistry(() => 1_000_000);
  const world = await signedInDb(over.signIns ?? [{ scope: "WORKSPACE" }], over.integration ?? null, serverId);
  const integrationFindFirst = vi.spyOn(world.prisma.integrationConnection, "findFirst");
  const signInFindFirst = vi.spyOn(world.prisma.mcpOAuthConnection, "findFirst");
  const signInCount = vi.spyOn(world.prisma.mcpOAuthConnection, "count");
  const prisma = world.prisma;
  const recordClassifications = vi.fn(async () => undefined);
  const audit = vi.fn();
  return {
    bridge,
    mux,
    registry,
    lifecycle,
    prisma,
    spies: { integrationFindFirst, signInFindFirst, signInCount },
    recordClassifications,
    audit,
    attach: () =>
      attachRemoteServer({
        mux,
        prisma,
        registry,
        lifecycle,
        auditLifecycle: audit,
        recordClassifications,
        createClient: () =>
          new McpBridgeClient({
            baseUrl: BRIDGE_URL,
            serviceToken: BRIDGE_TOKEN,
            serverId,
            fetchImpl: bridge.fetchImpl,
          }),
        serverId,
        operatorDomain: over.operatorDomain ?? "cloud",
        descriptor,
      }),
    openBody: () => bridge.calls.find((c) => c.path.endsWith("/open"))?.body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  logged.length = 0;
});

describe("attachRemoteServer opens any registered vendor from its CONNECTED sign-in (TC-1.2 / WARP-3961)", () => {
  it("attaches, and sends the bridge exactly the bearer and the sign-in's pinned site", async () => {
    const h = await harness();
    const result = await h.attach();
    expect(result.attached).toBe(true);
    // The wire carries the bearer and the row's own site and NOTHING else.
    expect(h.openBody()).toEqual({ accessToken: FAKE_ACCESS, cloudId: SITE_ID });
    expect(h.bridge.calls.find((c) => c.path.endsWith("/open"))?.path).toBe(
      `/sessions/${FIXTURE_ID}/open`,
    );
  });

  it("namespaces the catalog under ITS id and hands tool selection the domain it was GIVEN", async () => {
    const h = await harness({ operatorDomain: "cloud" });
    const result = await h.attach();
    expect((await h.mux.listTools()).map((t) => t.name)).toEqual([
      "list_files",
      `${FIXTURE_ID}__get_thing`,
      `${FIXTURE_ID}__list_things`,
    ]);
    expect(result.attached && result.sync.registered.map((t) => t.name)).toEqual([
      `${FIXTURE_ID}__get_thing`,
      `${FIXTURE_ID}__list_things`,
    ]);
    // OPERATOR-sourced, which is the only source a role grant honours.
    expect(result.attached && result.sync.registered.every((t) => t.domain === "cloud")).toBe(true);
    expect(
      result.attached && result.sync.registered.every((t) => t.domainSource === "operator"),
    ).toBe(true);
  });

  it("records every advertised tool in the classification record, by WIRE name, under ITS id", async () => {
    const h = await harness();
    await h.attach();
    expect(h.recordClassifications).toHaveBeenCalledTimes(1);
    const [serverId, tools] = h.recordClassifications.mock.calls[0] as unknown as [
      string,
      Array<{ name: string }>,
    ];
    expect(serverId).toBe(FIXTURE_ID);
    expect(tools.map((t) => t.name)).toEqual(["get_thing", "list_things"]);
  });

  it("keys the gate and the sign-in reads on the server id it was given, not on a constant", async () => {
    const h = await harness();
    await h.attach();
    const providers = [
      ...h.spies.integrationFindFirst.mock.calls.map(([a]) => (a as { where: { provider: string } }).where.provider),
      ...h.spies.signInFindFirst.mock.calls.map(([a]) => (a as { where: { provider: string } }).where.provider),
      ...h.spies.signInCount.mock.calls.map(([a]) => (a as { where: { provider: string } }).where.provider),
    ];
    expect(providers.length).toBeGreaterThanOrEqual(3);
    expect(providers.every((p) => p === FIXTURE_ID)).toBe(true);
  });

  it("records its terminal state under ITS id in the lifecycle registry", async () => {
    const h = await harness();
    await h.attach();
    expect(h.lifecycle.get(FIXTURE_ID)).toMatchObject({ state: "attached", reason: null });
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toBeUndefined();
  });

  it("is not attached and dials nothing when nobody has signed in (no env, no switch: the gate is a CONNECTED sign-in)", async () => {
    const h = await harness({ signIns: [] });
    const result = await h.attach();
    expect(result).toMatchObject({
      attached: false,
      serverId: FIXTURE_ID,
      reason: "gate_refused",
    });
    expect(h.bridge.calls).toHaveLength(0);
    // Registered detached, so the reconciler attaches it when a connection appears.
    expect(h.lifecycle.get(FIXTURE_ID)).toMatchObject({ state: "detached", reason: "gate_refused" });
  });
});

describe("which sign-in backs the catalog session, and what never leaks (WARP-3961)", () => {
  it("a CONNECTED sign-in with no pinned site is skipped: credential_incomplete, names the remedy, dials nothing", async () => {
    const h = await harness({ signIns: [{ scope: "WORKSPACE", siteId: null }] });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(result.attached === false && result.message).toBe(
      `An owner or admin must sign in to ${FIXTURE_ID} (or add a Workspace connection) before its tools can be listed.`,
    );
    expect(h.bridge.calls).toHaveLength(0);
    expect(h.lifecycle.get(FIXTURE_ID)).toMatchObject({ state: "detached", reason: "credential_incomplete" });
  });

  it("a member's sign-in backs the catalog only while that member is an owner/admin, and the base session is catalog-only", async () => {
    const admin = await harness({ signIns: [{ scope: "MEMBER", memberId: "adm-1", role: "admin" }] });
    expect((await admin.attach()).attached).toBe(true);
    expect(admin.openBody()).toEqual({ accessToken: FAKE_ACCESS, cloudId: SITE_ID, catalogOnly: true });

    const family = await harness({ signIns: [{ scope: "MEMBER", memberId: "fam-1", role: "family" }] });
    const result = await family.attach();
    // The gate passes (a sign-in is CONNECTED) but no regular member's sign-in backs the shared catalog.
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(family.bridge.calls).toHaveLength(0);
  });

  it("never lets the bearer reach a message, a lifecycle audit row or a log line (rule 19)", async () => {
    const ok = await harness();
    await ok.attach();
    const refused = await harness({ signIns: [{ scope: "WORKSPACE", siteId: null }] });
    const result = await refused.attach();
    const everything = JSON.stringify([
      ok.audit.mock.calls,
      refused.audit.mock.calls,
      logged,
      result.attached === false ? result.message : "",
    ]);
    expect(everything).not.toContain(FAKE_ACCESS);
  });
});

describe("attachAtlassianRemote is the same function with Atlassian's registration (TC-1.2)", () => {
  async function atlassianHarness(over: { signIns?: SignInSeed[] } = {}) {
    const world = await signedInDb(over.signIns ?? [{ scope: "WORKSPACE" }]);
    const bridge = fixtureBridge(ATLASSIAN_REMOTE_SERVER_ID);
    const allowlist = new Set([ATLASSIAN_REMOTE_SERVER_ID]);
    const mux = new McpToolMultiplexer(localPort(), {
      isServerAllowed: (id) => allowlist.has(id),
      remoteCallPolicy: allowAll,
    });
    const registry = new RuntimeToolRegistry();
    return {
      bridge,
      registry,
      attach: () =>
        attachAtlassianRemote({
          mux,
          prisma: world.prisma,
          registry,
          recordClassifications: async () => undefined,
          lifecycle: new RemoteMcpLifecycleRegistry(() => 1_000_000),
          auditLifecycle: () => undefined,
          createClient: () =>
            new McpBridgeClient({
              baseUrl: BRIDGE_URL,
              serviceToken: BRIDGE_TOKEN,
              serverId: ATLASSIAN_REMOTE_SERVER_ID,
              fetchImpl: bridge.fetchImpl,
            }),
        }),
    };
  }

  it("attaches under 'atlassian', in the 'pm' domain, with the bearer and the sign-in's site", async () => {
    const h = await atlassianHarness();
    const result = await h.attach();
    expect(result.attached).toBe(true);
    expect(result.attached && result.serverId).toBe("atlassian");
    expect(result.attached && result.sync.registered.every((t) => t.domain === "pm")).toBe(true);
    expect(h.bridge.calls.find((c) => c.path.endsWith("/open"))).toMatchObject({
      path: "/sessions/atlassian/open",
      body: { accessToken: FAKE_ACCESS, cloudId: SITE_ID },
    });
  });

  it("sends nothing but the bearer and the site to the bridge", async () => {
    const h = await atlassianHarness();
    await h.attach();
    expect(Object.keys(h.bridge.calls.find((c) => c.path.endsWith("/open"))?.body as object).sort()).toEqual(
      ["accessToken", "cloudId"],
    );
  });

  it("with no sign-in it is refused by the gate and never dials", async () => {
    const h = await atlassianHarness({ signIns: [] });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.calls).toHaveLength(0);
  });
});

describe("the operator-domain map and the registrations built from it (TC-1.2)", () => {
  const atlassian = (): McpProviderDescriptor => {
    const d = providerDescriptor("atlassian");
    if (d?.track !== "mcp") throw new Error("the atlassian descriptor is not an mcp track");
    return d;
  };

  it("names Atlassian's domain 'pm', and is frozen — it decides what a role grant can reach", () => {
    expect(REMOTE_SERVER_DOMAINS).toEqual({ atlassian: "pm" });
    expect(Object.isFrozen(REMOTE_SERVER_DOMAINS)).toBe(true);
  });

  it("is an OWN-property read: a legal server id such as 'constructor' is not a server", () => {
    expect(remoteServerDomain("atlassian")).toBe("pm");
    expect(remoteServerDomain("constructor")).toBeUndefined();
    expect(remoteServerDomain("unknown-vendor")).toBeUndefined();
  });

  it("registers exactly the mcp descriptors that have a domain, each paired with it", () => {
    const registrations = registeredRemoteServers();
    expect(registrations.map((r) => r.serverId)).toEqual(["atlassian"]);
    expect(registrations[0]).toEqual({
      serverId: "atlassian",
      operatorDomain: "pm",
      descriptor: atlassian(),
    });
  });

  it("registers by the descriptor's mcpServerId, and ignores every track that is not mcp", () => {
    const cloud = { ...atlassian(), track: "cloud", id: "some-cloud" } as unknown as ProviderDescriptor;
    const registrations = registeredRemoteServers([cloud, atlassian()]);
    expect(registrations.map((r) => r.serverId)).toEqual(["atlassian"]);
  });

  it("refuses to register a server with no operator domain — it would attach with a guessed one — and says so at error", () => {
    const registrations = registeredRemoteServers([atlassian(), bearerDescriptor()]);
    expect(registrations.map((r) => r.serverId)).toEqual(["atlassian"]);
    expect(logged.filter((l) => l.level === "error")).toEqual([
      expect.objectContaining({
        obj: { serverId: FIXTURE_ID },
        msg: "remote_mcp_server_has_no_operator_domain",
      }),
    ]);
  });

  it("takes the domain from the map it is given, so a vendor's entry is all a data PR adds", () => {
    const registrations = registeredRemoteServers(
      [atlassian(), bearerDescriptor()],
      (id) => (id === FIXTURE_ID ? "cloud" : remoteServerDomain(id)),
    );
    expect(registrations.map((r) => [r.serverId, r.operatorDomain])).toEqual([
      ["atlassian", "pm"],
      [FIXTURE_ID, "cloud"],
    ]);
  });
});
