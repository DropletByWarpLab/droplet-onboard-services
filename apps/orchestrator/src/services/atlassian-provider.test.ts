/**
 * WARP-2650 / WARP-3961 — the `atlassian` provider descriptor, and the sign-in
 * that is its only credential.
 *
 * WARP-3961 removed the API-token form: the descriptor declares NO credential
 * fields and no expiry policy, and the site (`cloudId`) is read from the sign-in
 * and stored on the `McpOAuthConnection` row (`siteId`). This file proves the
 * descriptor's shape, then the join: a CONNECTED sign-in row produced the way
 * the product stores it reaches the real gate, the real `McpBridgeClient` and the
 * real multiplexer, with the stored site forced onto the session.
 *
 * ## Fixtures
 *
 * Tokens are obviously fake, the site id is an all-zero UUID and every host is
 * RFC 2606 reserved. The bridge is a fixture served by an INJECTED fetch, never
 * a globally patched one, so "refused before the network" is asserted as zero
 * calls rather than inferred from a missing result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildableProviderIds,
  cloudProviderIds,
  credentialExpiryVerdict,
  mcpProviderIds,
  providerDescriptor,
  setupGuideHrefFor,
  type ProviderDescriptor,
} from "@droplet/shared-types";

import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";
import { isCloudErpProvider, isKnownErpProvider } from "./erp-provider.js";
import { McpBridgeClient } from "./mcp-bridge.client.js";
import { McpToolMultiplexer, type RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import { sealTokens } from "./mcp-oauth/mcp-oauth.service.js";
import {
  ATLASSIAN_REMOTE_SERVER_ID,
  attachAtlassianRemote,
} from "./remote-mcp-servers.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";
import {
  buildCredentialView,
  requireDescriptor,
  statusAfterCredentialUpdate,
  type SaasConnectionRow,
} from "./saas-credential.service.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const FAKE_ACCESS = "FAKE-ACCESS-TOKEN-0000";
const FAKE_CLOUD_ID = "00000000-0000-4000-8000-000000000000";
const WS_ROW_ID = "22222222-2222-2222-2222-222222222222";
const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";

beforeEach(() => {
  vi.clearAllMocks();
  __setColumnCryptoKeyForTest(TEST_KEY);
});

function atlassian(): ProviderDescriptor {
  const d = providerDescriptor("atlassian");
  expect(d, "the atlassian descriptor is not registered").toBeDefined();
  return d!;
}

// ===========================================================================
// The descriptor's shape — what an `mcp` track is and, more usefully, is not
// ===========================================================================

describe("the atlassian descriptor is an mcp track, not a cloud one", () => {
  it("is registered, and every derived list places it correctly", () => {
    expect(atlassian().track).toBe("mcp");
    expect(mcpProviderIds()).toContain("atlassian");
    // The exclusions that keep an MCP row out of machinery it has no business in.
    expect(buildableProviderIds()).not.toContain("atlassian");
    expect(isKnownErpProvider("atlassian")).toBe(false);
    expect(cloudProviderIds()).not.toContain("atlassian");
    expect(isCloudErpProvider("atlassian")).toBe(false);
  });

  it("serves no dataset, so `cloud_query_dataset` can never resolve to it", () => {
    expect(atlassian().datasets).toEqual([]);
  });

  it("declares no LAN provisioning, no rate limit and no poll floor", () => {
    const d = atlassian();
    expect(d.lanProvisioning).toBeUndefined();
    expect(d.rateLimit).toBeUndefined();
    expect(d.pollIntervalFloorMs).toBeUndefined();
  });

  it("puts no card on the Integrations hub", () => {
    expect(atlassian().catalog).toBeUndefined();
  });

  it("carries the setup guide the customer cannot connect without", () => {
    expect(setupGuideHrefFor(atlassian())).toBe("/help/connectors/atlassian");
  });

  it("registers the ONE host the integration dials, and only that one", () => {
    // `auth.atlassian.com` is dialled by the bridge's OAuth hops and registered in
    // the egress registry; the descriptor's own list stays the MCP host.
    expect(atlassian().egressHosts).toEqual(["mcp.atlassian.com"]);
  });
});

// ===========================================================================
// WARP-3961 — sign-in only
// ===========================================================================

describe("the sign-in is the only credential path", () => {
  it("declares NO credential fields and no variants — there is no form", () => {
    expect(atlassian().credentialFields).toEqual([]);
    expect(atlassian().credentialVariants).toBeUndefined();
  });

  it("declares no expiry policy: a sign-in renews itself or says NEEDS_RECONNECT", () => {
    expect(atlassian().credentialExpiry).toBeUndefined();
    // And so no verdict is ever computed for it.
    expect(credentialExpiryVerdict(atlassian(), undefined, new Date())).toBeUndefined();
  });

  it("asks for a sign-in that pins the site, over the OAuth endpoint", () => {
    const d = atlassian();
    if (d.track !== "mcp") throw new Error("not an mcp descriptor");
    expect(d.signIn).toMatchObject({
      kind: "oauth",
      pinsSite: true,
      mcpUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
    });
  });

  it("builds a credential view with no fields and no stored secret", () => {
    const row: SaasConnectionRow = {
      id: "conn_atlassian_0000000001",
      provider: "atlassian",
      status: "NOT_CONFIGURED",
      providerTokensEnc: null,
      apiCredentialsEnc: null,
      providerConfig: null,
    };
    const view = buildCredentialView(atlassian(), row, new Date("2026-09-02T00:00:00Z"));
    expect(view.fields).toEqual([]);
    expect(view.credentialExpiry).toBeNull();
    expect(view.setupGuideHref).toBe("/help/connectors/atlassian");
    expect(view.signIn).toEqual({ kind: "oauth" });
  });

  it("keeps the mcp track's status rule: a paste lands on CONNECTED, a cleared one on NOT_CONFIGURED", () => {
    // Generic track behaviour, still keyed on the TRACK; only a descriptor with
    // credential fields can reach it through the credentials route.
    expect(statusAfterCredentialUpdate(atlassian(), "NOT_CONFIGURED", true)).toBe("CONNECTED");
    expect(statusAfterCredentialUpdate(atlassian(), "DISABLED", true)).toBe("CONNECTED");
    expect(statusAfterCredentialUpdate(atlassian(), "DISABLED", false)).toBe("NOT_CONFIGURED");
    // The cloud rule is untouched.
    expect(statusAfterCredentialUpdate(requireDescriptor("stripe"), "NOT_CONFIGURED", true)).toBe(
      "PROVISIONING",
    );
  });
});

// ===========================================================================
// End to end: sign-in row → gate → bridge → multiplexer
// ===========================================================================

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
  { name: "searchConfluenceUsingCql", description: "Search", inputSchema: { type: "object" } },
];

function localPort(): McpClientPort {
  return {
    isStarted: true,
    listTools: async () => [
      { name: "list_files", description: "local", inputSchema: { type: "object" } },
    ],
    callTool: async () => ({ content: [], isError: false }),
  };
}

/** The fixture bridge, behind an INJECTED fetch. Records every call and body. */
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
    if (path.endsWith("/tools")) return json(200, { tools: WIRE_TOOLS, state: READY_STATE });
    return json(404, { error: { code: "NOT_FOUND", message: path } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const allowAllReads: RemoteCallPolicy = () => ({ kind: "allow" });

/** A Workspace sign-in row, sealed the way the product stores it. */
function workspaceRow(over: Record<string, unknown> = {}) {
  return {
    id: WS_ROW_ID,
    provider: "atlassian",
    scope: "WORKSPACE" as const,
    memberId: null,
    state: "CONNECTED",
    tokenExpiresAt: new Date("2100-01-01T00:00:00Z"),
    siteId: FAKE_CLOUD_ID,
    tokensEnc: sealTokens(
      { id: WS_ROW_ID, scope: "WORKSPACE", memberId: null },
      {
        accessToken: FAKE_ACCESS,
        refreshToken: "r",
        expiresAt: "2100-01-01T00:00:00.000Z",
        scope: "s",
        tokenEndpoint: "https://auth.example/token",
        resource: "res",
        mcpUrl: "res",
      },
    ),
    ...over,
  };
}

/** The whole stack, from the persisted rows down to the injected fetch. Only
 *  the bridge and the local stdio child are doubles. */
function stack(
  oauthRow: ReturnType<typeof workspaceRow> | null,
  integration: { id: string; status: string; providerTokensEnc: string | null } | null = null,
) {
  const bridge = fixtureBridge();
  const mux = new McpToolMultiplexer(localPort(), {
    isServerAllowed: (id) => id === "atlassian",
    remoteCallPolicy: allowAllReads,
  });
  const prisma = {
    integrationConnection: { findFirst: vi.fn(async () => integration) },
    mcpOAuthConnection: {
      count: vi.fn(async () => (oauthRow && oauthRow.state === "CONNECTED" ? 1 : 0)),
      findFirst: vi.fn(async (a: { where: { scope: string } }) =>
        oauthRow && a.where.scope === oauthRow.scope ? oauthRow : null),
      findUnique: vi.fn(async () => oauthRow),
    },
  };
  return {
    bridge,
    mux,
    prisma,
    attach: () =>
      attachAtlassianRemote({
        mux,
        prisma,
        registry: new RuntimeToolRegistry(),
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

describe("end to end — a stored sign-in reaches the vendor's tools on its pinned site", () => {
  it("attaches and advertises atlassian__*, opening the session with the sign-in's token and stored site", async () => {
    const h = stack(workspaceRow());

    const result = await h.attach();
    expect(result).toMatchObject({ attached: true, serverId: "atlassian" });

    const tools = await h.mux.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_files",
      "atlassian__getJiraIssue",
      "atlassian__searchConfluenceUsingCql",
    ]);

    // The site is the row's own `siteId`, read from the token at sign-in: nothing
    // typed, and nothing from the model.
    const open = h.bridge.calls.find((c) => c.path.endsWith("/open"));
    expect(open?.body).toEqual({ accessToken: FAKE_ACCESS, cloudId: FAKE_CLOUD_ID });
  });

  it("refuses with ZERO bridge calls when nobody has signed in", async () => {
    const h = stack(null);

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
    expect(h.bridge.calls).toHaveLength(0);

    const tools = await h.mux.listTools();
    expect(tools.some((t) => t.name.startsWith("atlassian__"))).toBe(false);
  });

  it("refuses with ZERO bridge calls while the sign-in is not CONNECTED", async () => {
    const h = stack(workspaceRow({ state: "NEEDS_RECONNECT" }));

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses with ZERO bridge calls when an owner or admin turned the connection off", async () => {
    const h = stack(workspaceRow(), { id: "conn_x", status: "DISABLED", providerTokensEnc: null });

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
  });

  it("will not open a session for a sign-in with no pinned site — it predates the site being read from the token", async () => {
    const h = stack(workspaceRow({ siteId: null }));

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a token sealed for a DIFFERENT row — the AAD binding holds", async () => {
    const other = workspaceRow();
    const row = workspaceRow({
      tokensEnc: sealTokens(
        { id: "99999999-9999-9999-9999-999999999999", scope: "WORKSPACE", memberId: null },
        {
          accessToken: FAKE_ACCESS,
          refreshToken: "r",
          expiresAt: "2100-01-01T00:00:00.000Z",
          scope: "s",
          tokenEndpoint: "https://auth.example/token",
          resource: "res",
          mcpUrl: "res",
        },
      ),
    });
    expect(other.tokensEnc).not.toBe(row.tokensEnc);
    const h = stack(row);

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
  });
});
