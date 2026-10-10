/**
 * WARP-3703 (ADR-043 TC-1.1 / TC-1.2) — the attach path is per SERVER, and the
 * provider DESCRIPTOR decides what a session is opened with.
 *
 * Until TC-1 `attachAtlassianRemote` was the only attach function, and it read
 * exactly three facts — `email` and `cloudId` from `providerConfig`, `apiToken`
 * from the sealed bundle — whatever server it was attaching, because there was
 * only one. A vendor that presents a single static Bearer token needs one fact
 * from one place, and a vendor with a workspace needs a different two. So the
 * facts are now read from the descriptor's own required `credentialFields`, one
 * home per fact and no fallback between them (ADR-042 §5).
 *
 * `remote-mcp-attach.test.ts`, `remote-mcp-reconciler.test.ts` and
 * `atlassian-provider.test.ts` still drive `attachAtlassianRemote` and are the
 * regression net for "Atlassian is unchanged"; none of them was edited. This
 * file is what they cannot say.
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
  type RemoteMcpConnectionRow,
} from "./remote-mcp-servers.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";

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
const FAKE_API_TOKEN = "FIXTURE-FAKE-TOKEN-000000";
const FAKE_ATLASSIAN_TOKEN = "ATATT-FAKE-000000000000";
const FIXTURE_ID = "fixture-bearer";
const CONNECTION_ID = "conn_fixture_bearer";

const TOOLS: McpToolDescriptor[] = [
  { name: "get_thing", description: "Read one thing", inputSchema: { type: "object" } },
  { name: "list_things", description: "List things", inputSchema: { type: "object" } },
];

/** A bearer-only vendor, as a descriptor: ONE required secret, in the sealed
 *  bundle, and nothing in `providerConfig`. */
function bearerDescriptor(over: Partial<McpProviderDescriptor> = {}): McpProviderDescriptor {
  return {
    id: FIXTURE_ID,
    displayName: "Fixture bearer vendor",
    category: "Fixture",
    track: "mcp",
    mcpServerId: FIXTURE_ID,
    description: "Test-only.",
    setupGuideHref: "/help/connectors/fixture-bearer",
    credentialFields: [
      {
        name: "apiToken",
        label: "Fixture API token",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
      },
    ],
    egressHosts: ["mcp.fixture.invalid"],
    datasets: [],
    ...over,
  };
}

/** A vendor with a non-secret fact AND a secret AND an optional fact, so the
 *  homes can be told apart. The secret's name is `apiKey`, deliberately not
 *  `apiToken`: field names are the descriptor's, not a shared convention. */
const MIXED = bearerDescriptor({
  credentialFields: [
    {
      name: "workspace",
      label: "Workspace",
      type: "string",
      required: true,
      secret: false,
      storage: "providerConfig",
    },
    {
      name: "apiKey",
      label: "API key",
      type: "string",
      required: true,
      secret: true,
      storage: "encrypted",
    },
    {
      name: "note",
      label: "Note",
      type: "string",
      required: false,
      secret: false,
      storage: "providerConfig",
    },
  ],
});

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

function connectedRow(over: Partial<RemoteMcpConnectionRow> = {}): RemoteMcpConnectionRow {
  return {
    id: CONNECTION_ID,
    status: "CONNECTED",
    providerTokensEnc: "dcv1:sealed",
    providerConfig: null,
    ...over,
  };
}

interface HarnessOptions {
  descriptor?: McpProviderDescriptor;
  row?: RemoteMcpConnectionRow | null;
  /** What the ADR-042 seal opens to. A function throws to model a bundle that
   *  fails its tag check. */
  secrets?: Record<string, string> | (() => never);
  allowlist?: string[];
  operatorDomain?: ToolDomain;
}

function harness(over: HarnessOptions = {}) {
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
  const row = over.row === undefined ? connectedRow() : over.row;
  const prisma = { offLanAllowlistChannel: { findUnique: async () => ({ enabled: true }) }, integrationConnection: { findFirst: vi.fn(async (_args: unknown) => row) } };
  const recordClassifications = vi.fn(async () => undefined);
  const openCredentials = vi.fn((): Record<string, string> => {
    const secrets = over.secrets ?? { apiToken: FAKE_API_TOKEN };
    if (typeof secrets === "function") return secrets();
    return secrets;
  });
  const audit = vi.fn();
  return {
    bridge,
    mux,
    registry,
    lifecycle,
    prisma,
    recordClassifications,
    openCredentials,
    audit,
    attach: () =>
      attachRemoteServer({
        mux,
        prisma,
        allowlist,
        registry,
        lifecycle,
        auditLifecycle: audit,
        recordClassifications,
        openCredentials,
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

describe("attachRemoteServer opens a bearer-only vendor from its one sealed field (TC-1.2)", () => {
  it("attaches, and sends the bridge exactly the descriptor's required field", async () => {
    const h = harness();
    const result = await h.attach();
    expect(result.attached).toBe(true);
    // The wire carries the descriptor's field and NOTHING else: no email, no
    // site, and none of Atlassian's names.
    expect(h.openBody()).toEqual({ apiToken: FAKE_API_TOKEN });
    expect(h.bridge.calls.find((c) => c.path.endsWith("/open"))?.path).toBe(
      `/sessions/${FIXTURE_ID}/open`,
    );
  });

  it("namespaces the catalog under ITS id and hands tool selection the domain it was GIVEN", async () => {
    const h = harness({ operatorDomain: "cloud" });
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
    const h = harness();
    await h.attach();
    expect(h.recordClassifications).toHaveBeenCalledTimes(1);
    const [serverId, tools] = h.recordClassifications.mock.calls[0] as unknown as [
      string,
      Array<{ name: string }>,
    ];
    expect(serverId).toBe(FIXTURE_ID);
    expect(tools.map((t) => t.name)).toEqual(["get_thing", "list_things"]);
  });

  it("keys the gate and the row read on the server id it was given, not on a constant", async () => {
    const h = harness();
    await h.attach();
    const calls = h.prisma.integrationConnection.findFirst.mock.calls as unknown as [
      { where: { provider: string } },
    ][];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every(([args]) => args.where.provider === FIXTURE_ID)).toBe(true);
  });

  it("records its terminal state under ITS id in the lifecycle registry", async () => {
    const h = harness();
    await h.attach();
    expect(h.lifecycle.get(FIXTURE_ID)).toMatchObject({ state: "attached", reason: null });
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toBeUndefined();
  });

  it("is not attached, reads no row and dials nothing when the id is not allowlisted", async () => {
    const h = harness({ allowlist: [] });
    const result = await h.attach();
    expect(result).toMatchObject({
      attached: false,
      serverId: FIXTURE_ID,
      reason: "not_allowlisted",
    });
    expect(h.prisma.integrationConnection.findFirst).not.toHaveBeenCalled();
    expect(h.bridge.calls).toHaveLength(0);
    expect(h.lifecycle.list()).toEqual([]);
  });
});

describe("the descriptor decides where each fact is read from — one home, no fallback (TC-1.2)", () => {
  const MIXED_ROW = connectedRow({ providerConfig: { workspace: "w-1", note: "not an input" } });

  it("reads a non-secret fact from providerConfig and a secret from the sealed bundle", async () => {
    const h = harness({ descriptor: MIXED, row: MIXED_ROW, secrets: { apiKey: "KEY-FAKE-1" } });
    expect((await h.attach()).attached).toBe(true);
    expect(h.openBody()).toEqual({ workspace: "w-1", apiKey: "KEY-FAKE-1" });
  });

  it("never forwards an OPTIONAL field — it is a fact about the credential, not an input to the session", async () => {
    const h = harness({ descriptor: MIXED, row: MIXED_ROW, secrets: { apiKey: "KEY-FAKE-1" } });
    await h.attach();
    expect(h.openBody()).not.toHaveProperty("note");
  });

  it("does NOT read a secret out of providerConfig, so a credential cannot work from the unencrypted column", async () => {
    const h = harness({
      descriptor: MIXED,
      row: connectedRow({ providerConfig: { workspace: "w-1", apiKey: "KEY-FAKE-IN-CONFIG" } }),
      secrets: {},
    });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(result.attached === false && result.message).toBe(
      `The ${FIXTURE_ID} connection is missing: apiKey.`,
    );
    expect(h.bridge.calls).toHaveLength(0);
  });

  it("does NOT read a non-secret fact out of the sealed bundle", async () => {
    const h = harness({
      descriptor: MIXED,
      row: connectedRow({ providerConfig: {} }),
      secrets: { apiKey: "KEY-FAKE-1", workspace: "w-IN-BUNDLE" },
    });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(result.attached === false && result.message).toBe(
      `The ${FIXTURE_ID} connection is missing: workspace.`,
    );
  });

  it("trims a non-secret fact, uses a secret verbatim, and counts a blank fact as missing", async () => {
    const trimmed = harness({
      descriptor: MIXED,
      row: connectedRow({ providerConfig: { workspace: "  w-1  " } }),
      secrets: { apiKey: " KEY-FAKE-WITH-SPACES " },
    });
    await trimmed.attach();
    expect(trimmed.openBody()).toEqual({ workspace: "w-1", apiKey: " KEY-FAKE-WITH-SPACES " });

    const blank = harness({
      descriptor: MIXED,
      row: connectedRow({ providerConfig: { workspace: "   " } }),
      secrets: { apiKey: "KEY-FAKE-1" },
    });
    const result = await blank.attach();
    expect(result.attached === false && result.message).toContain("workspace");
  });

  it("names every missing field, facts first and then secrets — and never a value", async () => {
    const h = harness({ descriptor: MIXED, row: connectedRow({ providerConfig: {} }), secrets: {} });
    const result = await h.attach();
    expect(result.attached === false && result.message).toBe(
      `The ${FIXTURE_ID} connection is missing: workspace, apiKey.`,
    );
  });

  it("reports an unopenable sealed bundle as the missing SECRET field, never as an empty credential", async () => {
    const h = harness({
      descriptor: MIXED,
      row: MIXED_ROW,
      secrets: () => {
        throw new Error("Unsupported state or unable to authenticate data");
      },
    });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(result.attached === false && result.message).toBe(
      `The ${FIXTURE_ID} connection is missing: apiKey (sealed credential could not be opened).`,
    );
    // The seal's own error text — which names a cipher, not a secret, but is
    // not ours to forward — does not leak either.
    expect(result.attached === false && result.message).not.toContain("authenticate");
    expect(h.bridge.calls).toHaveLength(0);
  });

  it("counts a required field stored where the attach path cannot read it as MISSING, by name", async () => {
    const odd = bearerDescriptor({
      credentialFields: [
        {
          name: "apiToken",
          label: "Fixture API token",
          type: "string",
          required: true,
          secret: true,
          storage: "encrypted",
        },
        {
          name: "host",
          label: "Host",
          type: "string",
          required: true,
          secret: false,
          storage: "column",
        },
      ],
    });
    const h = harness({ descriptor: odd });
    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(result.attached === false && result.message).toBe(
      `The ${FIXTURE_ID} connection is missing: host.`,
    );
  });
});

describe("attachAtlassianRemote is the same function with Atlassian's registration (TC-1.2)", () => {
  const ATLASSIAN_ROW = connectedRow({
    id: "conn_atlassian_fixture",
    providerConfig: { email: "ops@vendor.example", cloudId: "00000000-0000-4000-8000-000000000000" },
  });

  function atlassianHarness(over: { row?: RemoteMcpConnectionRow; secrets?: Record<string, string> } = {}) {
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
          prisma: { offLanAllowlistChannel: { findUnique: async () => ({ enabled: true }) }, integrationConnection: { findFirst: async () => over.row ?? ATLASSIAN_ROW } },
          allowlist,
          registry,
          recordClassifications: async () => undefined,
          lifecycle: new RemoteMcpLifecycleRegistry(() => 1_000_000),
          auditLifecycle: () => undefined,
          openCredentials: () => over.secrets ?? { apiToken: FAKE_ATLASSIAN_TOKEN },
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

  it("attaches under 'atlassian', in the 'pm' domain, with the three fields it has always sent", async () => {
    const h = atlassianHarness();
    const result = await h.attach();
    expect(result.attached).toBe(true);
    expect(result.attached && result.serverId).toBe("atlassian");
    expect(result.attached && result.sync.registered.every((t) => t.domain === "pm")).toBe(true);
    expect(h.bridge.calls.find((c) => c.path.endsWith("/open"))).toMatchObject({
      path: "/sessions/atlassian/open",
      body: {
        email: "ops@vendor.example",
        apiToken: FAKE_ATLASSIAN_TOKEN,
        cloudId: "00000000-0000-4000-8000-000000000000",
      },
    });
  });

  it("does not send its optional expiry date to the bridge", async () => {
    const h = atlassianHarness({
      row: connectedRow({
        id: "conn_atlassian_fixture",
        providerConfig: {
          email: "ops@vendor.example",
          cloudId: "00000000-0000-4000-8000-000000000000",
          tokenExpiresAt: "2027-06-01",
        },
      }),
    });
    await h.attach();
    expect(Object.keys(h.bridge.calls.find((c) => c.path.endsWith("/open"))?.body as object).sort()).toEqual(
      ["apiToken", "cloudId", "email"],
    );
  });

  it("names a half-filled row's missing fields in the order it always has: email, cloudId, apiToken", async () => {
    const h = atlassianHarness({ row: connectedRow({ providerConfig: {} }), secrets: {} });
    const result = await h.attach();
    expect(result.attached === false && result.message).toBe(
      "The atlassian connection is missing: email, cloudId, apiToken.",
    );
  });

  it("keeps the unopenable-bundle wording it has always had", async () => {
    const bridge = fixtureBridge(ATLASSIAN_REMOTE_SERVER_ID);
    const allowlist = new Set([ATLASSIAN_REMOTE_SERVER_ID]);
    const result = await attachAtlassianRemote({
      mux: new McpToolMultiplexer(localPort(), { isServerAllowed: () => true, remoteCallPolicy: allowAll }),
      prisma: { offLanAllowlistChannel: { findUnique: async () => ({ enabled: true }) }, integrationConnection: { findFirst: async () => ATLASSIAN_ROW } },
      allowlist,
      registry: new RuntimeToolRegistry(),
      lifecycle: new RemoteMcpLifecycleRegistry(() => 1_000_000),
      auditLifecycle: () => undefined,
      openCredentials: () => {
        throw new Error("tag mismatch");
      },
      createClient: () =>
        new McpBridgeClient({
          baseUrl: BRIDGE_URL,
          serviceToken: BRIDGE_TOKEN,
          serverId: ATLASSIAN_REMOTE_SERVER_ID,
          fetchImpl: bridge.fetchImpl,
        }),
    });
    expect(result.attached === false && result.message).toBe(
      "The atlassian connection is missing: apiToken (sealed credential could not be opened).",
    );
    expect(bridge.calls).toHaveLength(0);
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
