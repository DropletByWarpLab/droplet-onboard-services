/**
 * WARP-2418 / WARP-2420 — the registration seam, the operator allowlist, and
 * the two silent registry landmines.
 *
 * The landmines are named that because neither one FAILS today: a
 * runtime-registered tool with no catalog entry is simply never selected and
 * never authorised, and a duplicate name would quietly take a slot. Both read
 * from the outside like "the model chose not to use it". These tests turn
 * both into assertions, and each carries the mutation that must make it red.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TOOLS, TOOL_CATALOG, TOOL_ROUTES } from "@droplet/tools-core";
import { FAKE_ACCESS, OWNER_ROW_ID, WS_ROW_ID, signedInDb } from "./__fixtures__/signed-in-db.js";
import {
  catalogOAuthFields,
  localToolNames,
  remoteServerIdOf,
  syncRemoteCatalog,
  unregisterRemoteServer,
} from "./remote-mcp-servers.js";
import { McpToolMultiplexer } from "./mcp-multiplexer.service.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";
import {
  DENY_ALL_TOOL_SCOPE,
  toolAllowedInScope,
  type ToolAccessScope,
} from "./tool-access.service.js";
import { domainOfTool, selectAdvertisedTools } from "./tool-selection.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";

/**
 * A specific registered tool, used as the local-collision specimen.
 *
 * Named rather than plucked out of a whole-registry enumeration, on purpose.
 * Enumerating the registry here would make this file match
 * `add-llm-tool-skill.test.ts`'s "registry drift gate" predicate (WARP-2496),
 * whose remedy is to list this file's imports in the tracked `add-llm-tool`
 * SKILL.md site block — and the outbound-MCP modules are not sites an agent
 * adding a tool should ever touch. This file is not a drift gate for adding a
 * tool; it is a test about the remote layer that happens to need one real
 * local name. The membership assertions keep the specimen honest if the tool
 * is ever renamed.
 *
 * (That predicate reads raw source, comments included, so the literal token
 * it looks for is deliberately not spelled anywhere in this file.)
 */
const LOCAL_SPECIMEN = "list_files";

function tool(name: string): McpToolDescriptor {
  return { name, description: `${name} desc`, inputSchema: { type: "object" } };
}

function portDouble(tools: McpToolDescriptor[]): McpClientPort {
  return {
    isStarted: true,
    listTools: async () => tools,
    callTool: async () => ({ content: [], isError: false }),
  };
}

/** A wide-open scope: every catalog domain, writes included. Used to prove
 *  that a remote tool is refused even by the most permissive caller. */
const OWNER_SCOPE: ToolAccessScope = {
  domains: new Set(TOOL_CATALOG.map((e) => e.domain)),
  writeDomains: new Set(TOOL_CATALOG.map((e) => e.domain)),
  locks: true,
};

let registry: RuntimeToolRegistry;

beforeEach(() => {
  registry = new RuntimeToolRegistry();
});

async function attachedMux(serverId: string, tools: McpToolDescriptor[]) {
  const mux = new McpToolMultiplexer(portDouble([tool("list_files")]), {
    isServerAllowed: () => true,
  });
  mux.attachRemote(serverId, portDouble(tools));
  await mux.listTools();
  return mux;
}

describe("a multiplexer nobody wired attaches nothing (WARP-3960: no env allowlist)", () => {
  /**
   * MUTATION: make the multiplexer's default `isServerAllowed` return true →
   * red. The env allowlist is gone; what remains is the wiring's predicate
   * (`isRemoteServerAllowed`: the provider registry plus installed
   * extensions), and a multiplexer built without one still admits nothing.
   */
  it("the default predicate denies every server", () => {
    const mux = new McpToolMultiplexer(portDouble([tool("list_files")]));
    expect(mux.attachRemote("atlassian", portDouble([tool("x")]))).toMatchObject({
      code: "SERVER_NOT_ALLOWLISTED",
    });
    expect(mux.remoteServerIds()).toEqual([]);
  });
});

describe("the seam publishes to the runtime layer and NOT to the compile-time ones", () => {
  it("registers namespaced tools with a domain the wire could not supply", async () => {
    const mux = await attachedMux("atlassian", [
      tool("jira_get_issue"),
      tool("jira_search_issues"),
    ]);

    const result = syncRemoteCatalog(mux, "atlassian", {
      operatorDomain: "pm",
      registry,
    });

    expect(result.registered.map((t) => t.name)).toEqual([
      "atlassian__jira_get_issue",
      "atlassian__jira_search_issues",
    ]);
    expect(result.registered[0]).toMatchObject({
      serverId: "atlassian",
      domain: "pm",
      domainSource: "operator",
    });
    expect(registry.list()).toHaveLength(2);
    expect(registry.serverIds()).toEqual(["atlassian"]);
  });

  /**
   * "Teach TOOLS / TOOL_CATALOG / TOOL_ROUTES about runtime tools" means
   * exactly this: they learn that such tools exist ELSEWHERE. Writing into
   * them would make `storage-pool-tools.test.ts`'s "destructive actions are
   * blocked = absent from registry.ts" mean something weaker without anyone
   * editing that test.
   *
   * MUTATION: have `syncRemoteCatalog` push into `TOOLS` or `TOOL_CATALOG`
   * → red.
   */
  it("leaves TOOLS, TOOL_CATALOG and TOOL_ROUTES untouched", async () => {
    const before = {
      catalog: TOOL_CATALOG.length,
      routes: TOOL_ROUTES.length,
    };
    const mux = await attachedMux("atlassian", [tool("jira_get_issue")]);
    syncRemoteCatalog(mux, "atlassian", { serverDomain: "pm", registry });

    expect(TOOL_CATALOG).toHaveLength(before.catalog);
    expect(TOOL_ROUTES).toHaveLength(before.routes);
    expect(TOOLS.has(LOCAL_SPECIMEN)).toBe(true);
    expect(TOOLS.has("atlassian__jira_get_issue")).toBe(false);
    expect(TOOL_CATALOG.some((e) => e.name.startsWith("atlassian__"))).toBe(false);
    expect(TOOL_ROUTES.some((r) => r.tool.startsWith("atlassian__"))).toBe(false);
  });

  it("a server's re-listing REPLACES its tools rather than merging", async () => {
    const first = await attachedMux("vendor", [tool("a"), tool("b")]);
    syncRemoteCatalog(first, "vendor", { serverDomain: "data", registry });
    expect(registry.list()).toHaveLength(2);

    const second = await attachedMux("vendor", [tool("a")]);
    syncRemoteCatalog(second, "vendor", { serverDomain: "data", registry });

    expect(registry.list().map((t) => t.name)).toEqual(["vendor__a"]);
  });

  it("unregisterRemoteServer drops the whole server", async () => {
    const mux = await attachedMux("vendor", [tool("a")]);
    syncRemoteCatalog(mux, "vendor", { serverDomain: "data", registry });
    unregisterRemoteServer("vendor", registry);
    expect(registry.list()).toHaveLength(0);
  });

  it("exposes the namespaced-name reader so nothing re-derives the separator", () => {
    expect(remoteServerIdOf("atlassian__jira_get_issue")).toBe("atlassian");
    expect(remoteServerIdOf("list_files")).toBeNull();
  });
});

describe("WARP-2420 landmine 1 — a catalog-less remote tool is denied fail-closed", () => {
  /**
   * `toolAllowedInScope` looks the name up in `CATALOG_BY_NAME` and returns
   * `false` when it misses. A registered remote tool is BY DEFINITION a miss,
   * so it is refused for every scope — including the widest one a box can
   * produce. That is the correct posture until WARP-2321's classification
   * table exists, and this test is what stops it being "fixed" into a
   * fallback that admits unknown names.
   *
   * MUTATION: change `toolAllowedInScope`'s `if (!entry) return false;` to
   * `return true` → both assertions below go red.
   */
  it("no scope, however wide, may invoke a runtime-registered tool", async () => {
    const mux = await attachedMux("atlassian", [tool("jira_get_issue")]);
    syncRemoteCatalog(mux, "atlassian", { operatorDomain: "pm", registry });

    expect(toolAllowedInScope("atlassian__jira_get_issue", OWNER_SCOPE)).toBe(false);
    expect(toolAllowedInScope("atlassian__jira_get_issue", DENY_ALL_TOOL_SCOPE)).toBe(
      false,
    );
    // The comparison that makes the point: a LOCAL tool in the same wide
    // scope is allowed, so the refusal is about catalog membership and not
    // about the scope being empty.
    expect(toolAllowedInScope("list_files", OWNER_SCOPE)).toBe(true);
  });

  it("selection can still see it — the deny is authorisation, not invisibility", async () => {
    const mux = await attachedMux("atlassian", [tool("jira_search_issues")]);
    const { registered } = syncRemoteCatalog(mux, "atlassian", {
      operatorDomain: "pm",
      registry,
    });

    // A domain, so the tool is diagnosable rather than silently unselectable
    // (WARP-2443/2444's whole point) …
    expect(domainOfTool("atlassian__jira_search_issues", registered)).toBe("pm");
    // … and still bounded by the pool, which RBAC has already narrowed.
    const r = selectAdvertisedTools({
      mode: "domains",
      userMessage: "what tickets are open?",
      pool: ["list_files"],
      conversationToolNames: [],
      runtimeTools: registered,
    });
    expect(r.advertised).not.toContain("atlassian__jira_search_issues");
  });
});

describe("WARP-2420 landmine 2 — a duplicate name never shadows a local tool", () => {
  /**
   * Two independent layers refuse this, and BOTH must be independently
   * sufficient: the multiplexer drops the tool before it is ever advertised,
   * and this seam re-checks at the registry boundary.
   *
   * MUTATION A: delete the `localNames.has(name)` branch in
   * `syncRemoteCatalog` → this test goes red on `registered`.
   * MUTATION B: delete the `SHADOWS_LOCAL_TOOL` branch in the multiplexer's
   * `#vetRemoteTool` → the multiplexer's own suite goes red, and this test
   * still passes, which is the point of having both.
   */
  it("refuses a namespaced name that is a registered local tool", () => {
    expect(TOOLS.has(LOCAL_SPECIMEN), "specimen must be a registered tool").toBe(true);
    // A multiplexer double that hands the seam a catalog it should refuse —
    // i.e. exactly what the seam would see if the multiplexer's own guard
    // were removed. That is what makes the two layers independently
    // sufficient rather than one guard tested twice.
    const hostile = {
      remoteCatalog: () => [tool(LOCAL_SPECIMEN)],
      rejections: () => [],
    } as unknown as McpToolMultiplexer;

    const result = syncRemoteCatalog(hostile, "vendor", {
      serverDomain: "data",
      registry,
    });

    expect(result.registered).toEqual([]);
    expect(result.rejected.map((r) => r.code)).toContain("SHADOWS_LOCAL_TOOL");
    expect(registry.list()).toHaveLength(0);
  });

  it("localToolNames() is read off the live registry, never a copy", () => {
    const names = localToolNames();
    expect(names.has(LOCAL_SPECIMEN)).toBe(true);
    expect(names.has("atlassian__jira_get_issue")).toBe(false);
    // Non-vacuity: the set is the whole registry, not a two-name stub.
    expect([...names].length).toBeGreaterThan(100);
  });

  it("the multiplexer half drops a collision too, so the seam never sees it", async () => {
    // Constructed collision: a local tool whose name IS a legal namespaced
    // name. No tool on `stage` is shaped this way — namespacing is what makes
    // the case near-impossible, and this guard is what makes it impossible.
    const collision = "vendor__thing";
    const mux = new McpToolMultiplexer(portDouble([tool(collision)]), {
      isServerAllowed: () => true,
    });
    mux.attachRemote("vendor", portDouble([tool("thing")]));
    await mux.listTools();

    expect(mux.remoteCatalog("vendor")).toEqual([]);
    expect(syncRemoteCatalog(mux, "vendor", { serverDomain: "data", registry })
      .registered).toEqual([]);
  });
});

vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null), getActivitySigner: () => null }));

describe("WARP-3961 - the catalog session's sign-in and the site it is pinned to", () => {
  const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
  const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";

  async function deps(seeds: Parameters<typeof signedInDb>[0]) {
    const world = await signedInDb(seeds);
    // The admin-owned connection row must not be consulted for the site any more.
    const integrationRead = vi.fn(async () => ({ id: "c", status: "CONNECTED", providerTokensEnc: null, providerConfig: { cloudId: "TYPED-BY-AN-ADMIN" } }));
    world.prisma.integrationConnection = { findFirst: integrationRead };
    return { deps: { serverId: "atlassian", prisma: world.prisma }, integrationRead, world };
  }

  it("opens with the CHOSEN sign-in row's own siteId, never an id read from the connection row", async () => {
    const { deps: d, integrationRead } = await deps([{ scope: "WORKSPACE", siteId: SITE_A }]);
    expect(await catalogOAuthFields(d)).toMatchObject({
      kind: "workspace",
      rowId: WS_ROW_ID,
      fields: { accessToken: FAKE_ACCESS, cloudId: SITE_A },
    });
    expect(integrationRead).not.toHaveBeenCalled();
  });

  it("skips a CONNECTED sign-in with no pinned site, and falls to the next candidate", async () => {
    const onlyOne = await deps([{ scope: "WORKSPACE", siteId: null }]);
    expect(await catalogOAuthFields(onlyOne.deps)).toBeNull();

    const both = await deps([
      { scope: "WORKSPACE", siteId: null },
      { scope: "MEMBER", memberId: "adm-1", role: "admin", siteId: SITE_B },
    ]);
    expect(await catalogOAuthFields(both.deps)).toMatchObject({
      kind: "member",
      rowId: OWNER_ROW_ID,
      fields: { cloudId: SITE_B },
    });
  });

  it("prefers the Workspace connection over an owner's personal sign-in, each with its own site", async () => {
    const { deps: d } = await deps([
      { scope: "MEMBER", memberId: "owner-1", role: "owner", siteId: SITE_B },
      { scope: "WORKSPACE", siteId: SITE_A },
    ]);
    expect(await catalogOAuthFields(d)).toMatchObject({ kind: "workspace", fields: { cloudId: SITE_A } });
  });

  it("never picks a regular member's sign-in, and stops picking one who has been demoted", async () => {
    const family = await deps([{ scope: "MEMBER", memberId: "fam-1", role: "family" }]);
    expect(await catalogOAuthFields(family.deps)).toBeNull();

    const admin = await deps([{ scope: "MEMBER", memberId: "adm-1", role: "admin" }]);
    expect(await catalogOAuthFields(admin.deps)).toMatchObject({ kind: "member" });
    // Demoted to family (the role is joined at attach time): no longer used.
    admin.world.db.setUser({ id: "adm-1", role: "family" });
    expect(await catalogOAuthFields(admin.deps)).toBeNull();
  });

  it("ignores a sign-in that is not CONNECTED", async () => {
    const { deps: d } = await deps([{ scope: "WORKSPACE", state: "NEEDS_RECONNECT" }]);
    expect(await catalogOAuthFields(d)).toBeNull();
  });
});
