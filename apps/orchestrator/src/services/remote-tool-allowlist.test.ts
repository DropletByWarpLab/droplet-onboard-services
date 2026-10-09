/**
 * WARP-2434 — the per-server tool allowlist, composed with the role's
 * `AccessRoleConnectorGrant`, enforced at DISPATCH and not only in the listing.
 *
 * The promise is about requests that must not happen, so the assertions here
 * are on the calls an injected `fetch` saw (never a globally patched one), and
 * on what the real dispatch guards answer for a tool the model NAMED even
 * though it was never offered.
 *
 * Real code under test: `McpToolMultiplexer` (listing + dispatch),
 * `withRemoteAllowlist` / `remoteToolAllowlisted` (the one predicate),
 * `runtimeToolLookupFrom` + `toolDispatchDenial` / `toolAllowedForPrincipal`
 * (the role axis the chat catalog, the agent loop, durable runs and approvals
 * all go through).
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolDomain } from "@droplet/tools-core";
import { McpToolMultiplexer } from "./mcp-multiplexer.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import {
  RECORD_DENY_CODES,
  RemoteToolClassificationCache,
  createRecordBackedRemoteCallPolicy,
  remoteToolAllowlisted,
  withRemoteAllowlist,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";
import { runtimeToolLookupFrom } from "./tool-layers.service.js";
import {
  narrowToolsToScope,
  toolAllowedForPrincipal,
  toolDispatchDenial,
  type ToolAccessScope,
} from "./tool-access.service.js";

const SERVER = "bigvendor";
const TOTAL = 50;
const ALLOWED = 8;
const at = new Date("2026-10-08T00:00:00Z");

const toolName = (i: number) => `tool_${i}`;
const allNames = Array.from({ length: TOTAL }, (_, i) => toolName(i));
const allowedNames = allNames.slice(0, ALLOWED);
const unlistedNames = allNames.slice(ALLOWED);

/** A reviewed READ (so the classification policy behind the allowlist would
 *  allow it): the allowlist is the only thing separating the 8 from the 42. */
function row(
  tool: string,
  over: Partial<RemoteToolClassificationRow> = {},
  serverId = SERVER,
): RemoteToolClassificationRow {
  return {
    serverId,
    toolName: tool,
    requiresWrite: false,
    requiresConfirmation: false,
    denied: false,
    allowlisted: false,
    reviewedBy: "owner",
    reviewedAt: at,
    wireDescription: null,
    firstSeenAt: at,
    lastSeenAt: at,
    ...over,
  };
}

function seededCache(allowlisted: readonly string[]): RemoteToolClassificationCache {
  const cache = new RemoteToolClassificationCache();
  cache.seed(allNames.map((n) => row(n, { allowlisted: allowlisted.includes(n) })));
  return cache;
}

const descriptors: McpToolDescriptor[] = allNames.map((name) => ({
  name,
  description: `fixture ${name}`,
  inputSchema: { type: "object", properties: {} },
}));

/** A remote whose only way out is the injected `fetch`. */
function fetchBackedRemote(fetchImpl: typeof fetch): McpClientPort {
  return {
    isStarted: true,
    async listTools() {
      return descriptors;
    },
    async callTool(name) {
      const res = await fetchImpl(`https://mcp.example.test/${SERVER}/call/${name}`, { method: "POST" });
      return { content: [{ type: "text", text: await res.text() }], isError: false };
    },
  };
}

const localPort: McpClientPort = {
  isStarted: true,
  listTools: async () => [],
  callTool: async () => ({ content: [{ type: "text", text: "local" }], isError: false }),
};

function build(opts: { cache: RemoteToolClassificationCache; policyOnly?: boolean; listingOnly?: boolean }) {
  const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  // Production composition (mcp-client.singleton.ts): allowlist in front of the record policy.
  const guarded = withRemoteAllowlist(opts.cache.lookup, createRecordBackedRemoteCallPolicy(opts.cache.lookup));
  const mux = new McpToolMultiplexer(localPort, {
    isServerAllowed: () => true,
    // The CONTROL for the mutation: listing filtered, dispatch policy open.
    remoteCallPolicy: opts.listingOnly ? () => ({ kind: "allow" }) : guarded,
    isRemoteToolOffered: opts.policyOnly
      ? undefined
      : (serverId, wireName) => remoteToolAllowlisted(opts.cache.lookup, serverId, wireName),
  });
  expect(mux.attachRemote(SERVER, fetchBackedRemote(fetchImpl))).toBeNull();
  return { mux, fetchImpl };
}

const calledTools = (fetchImpl: ReturnType<typeof vi.fn>): string[] =>
  fetchImpl.mock.calls.map((c) => String(c[0]).split("/call/")[1]!);

describe("a 50-tool server with an 8-tool allowlist (WARP-2434)", () => {
  it("offers exactly the 8", async () => {
    const { mux } = build({ cache: seededCache(allowedNames) });
    const offered = (await mux.listTools()).map((t) => t.name);
    expect(offered).toEqual(allowedNames.map((n) => `${SERVER}__${n}`));
  });

  /**
   * MUTATION: apply the allowlist to the listing only (the `listingOnly` build
   * below) -> the 42 reach `fetch` and this goes red. The next test is that
   * mutation, kept as a control so the assertion is known to discriminate.
   */
  it("leaves the other 42 unreachable when the model NAMES them directly", async () => {
    const { mux, fetchImpl } = build({ cache: seededCache(allowedNames) });
    await mux.listTools();
    for (const n of unlistedNames) {
      const out = await mux.callTool(`${SERVER}__${n}`, {});
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content[0]!.text!)).toMatchObject({ error: RECORD_DENY_CODES.notAllowlisted });
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    for (const n of allowedNames) expect((await mux.callTool(`${SERVER}__${n}`, {})).isError).toBe(false);
    expect(calledTools(fetchImpl)).toEqual(allowedNames);
  });

  it("does not lean on the offered list: with the listing unfiltered, dispatch alone still refuses", async () => {
    const { mux, fetchImpl } = build({ cache: seededCache(allowedNames), policyOnly: true });
    await mux.listTools(); // catalog vetted; the offered list is NOT filtered in this build
    expect((await mux.callTool(`${SERVER}__${unlistedNames[0]}`, {})).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CONTROL: filtering only the listing leaves the 42 reachable (what the guard above prevents)", async () => {
    const { mux, fetchImpl } = build({ cache: seededCache(allowedNames), listingOnly: true });
    expect((await mux.listTools()).length).toBe(ALLOWED);
    for (const n of unlistedNames) await mux.callTool(`${SERVER}__${n}`, {});
    expect(fetchImpl).toHaveBeenCalledTimes(TOTAL - ALLOWED);
  });

  it("an allowlist change is live on the next call: withdrawing a tool closes it", async () => {
    const cache = seededCache(allowedNames);
    const { mux, fetchImpl } = build({ cache });
    await mux.listTools();
    expect((await mux.callTool(`${SERVER}__tool_0`, {})).isError).toBe(false);
    cache.seed(allNames.map((n) => row(n, { allowlisted: allowedNames.slice(1).includes(n) })));
    expect((await mux.callTool(`${SERVER}__tool_0`, {})).isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("remoteToolAllowlisted — positive and fail-closed", () => {
  const cache = new RemoteToolClassificationCache();
  cache.seed([
    row("on", { allowlisted: true }),
    row("off", { allowlisted: false }),
    row("blocked", { allowlisted: true, denied: true }),
    // A row from before the column existed: the field is simply absent.
    { ...row("legacy"), allowlisted: undefined },
  ]);

  it("admits only an existing, allowlisted, unblocked row", () => {
    expect(remoteToolAllowlisted(cache.lookup, SERVER, "on")).toBe(true);
    expect(remoteToolAllowlisted(cache.lookup, SERVER, "off")).toBe(false);
    expect(remoteToolAllowlisted(cache.lookup, SERVER, "blocked")).toBe(false);
    expect(remoteToolAllowlisted(cache.lookup, SERVER, "legacy")).toBe(false);
  });

  it("refuses an unknown tool and an unknown server, and never asks the inner policy", () => {
    const inner = vi.fn(() => ({ kind: "allow" as const }));
    const policy = withRemoteAllowlist(cache.lookup, inner);
    const call = (serverId: string, wireName: string) =>
      policy({ serverId, wireName, namespacedName: `${serverId}__${wireName}`, args: {} });
    expect(call(SERVER, "nope")).toMatchObject({ kind: "deny", code: RECORD_DENY_CODES.notAllowlisted });
    expect(call("nobody", "on")).toMatchObject({ kind: "deny", code: RECORD_DENY_CODES.notAllowlisted });
    expect(inner).not.toHaveBeenCalled();
    expect(call(SERVER, "on")).toEqual({ kind: "allow" });
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("composition with AccessRoleConnectorGrant — the INTERSECTION, never the union", () => {
  const registry = new RuntimeToolRegistry();
  registry.registerServerTools(
    SERVER,
    allNames.map((n) => ({
      name: `${SERVER}__${n}`,
      serverId: SERVER,
      domain: "pm" as ToolDomain,
      domainSource: "operator" as const,
      description: "fixture",
      inputSchema: {},
    })),
  );
  const cache = seededCache(allowedNames);
  const lookup = runtimeToolLookupFrom(registry, cache.lookup);
  const scope = (grants?: Array<[string, string]>): ToolAccessScope => ({
    domains: new Set(["pm"]),
    writeDomains: new Set(),
    locks: false,
    ...(grants ? { connectorGrants: new Map(grants) } : {}),
  });
  const granted = scope([[SERVER, "read"]]);
  const dispatch = (name: string, s: ToolAccessScope) =>
    toolDispatchDenial(`${SERVER}__${name}`, {}, s, lookup)?.code ?? null;

  it("grant AND allowlist: only the 8 pass the dispatch guard, the 42 are FORBIDDEN_TOOL_FOR_ROLE", () => {
    for (const n of allowedNames) expect(dispatch(n, granted)).toBeNull();
    for (const n of unlistedNames) expect(dispatch(n, granted)).toBe("FORBIDDEN_TOOL_FOR_ROLE");
  });

  it("allowlisted but the role holds no grant row for the server: refused (an allowlist never grants)", () => {
    for (const s of [scope([["other-vendor", "read_write"]]), scope([]), scope()]) {
      for (const n of allowedNames) expect(dispatch(n, s)).toBe("FORBIDDEN_TOOL_FOR_ROLE");
    }
  });

  it("offer time and dispatch agree, because both are the same predicate", () => {
    const offered = narrowToolsToScope(
      allNames.map((n) => ({ name: `${SERVER}__${n}` })),
      granted,
      lookup,
    ).map((t) => t.name);
    expect(offered).toEqual(allowedNames.map((n) => `${SERVER}__${n}`));
    const passing = allNames.filter((n) => dispatch(n, granted) === null).map((n) => `${SERVER}__${n}`);
    expect(passing).toEqual(offered);
  });

  it("a read grant never admits a write-classified tool; read_write alone does not either without the domain's write grant", () => {
    const writeCache = new RemoteToolClassificationCache();
    writeCache.seed([row("w", { allowlisted: true, requiresWrite: true, requiresConfirmation: true })]);
    const reg = new RuntimeToolRegistry();
    reg.registerServerTools(SERVER, [
      {
        name: `${SERVER}__w`,
        serverId: SERVER,
        domain: "pm" as ToolDomain,
        domainSource: "operator",
        description: "fixture",
        inputSchema: {},
      },
    ]);
    const l = runtimeToolLookupFrom(reg, writeCache.lookup);
    const withWrite = (level: string): ToolAccessScope => ({
      domains: new Set(["pm"]),
      writeDomains: new Set(["pm"]),
      locks: false,
      connectorGrants: new Map([[SERVER, level]]),
    });
    expect(toolDispatchDenial(`${SERVER}__w`, {}, withWrite("read"), l)?.code).toBe("FORBIDDEN_TOOL_FOR_ROLE");
    expect(toolDispatchDenial(`${SERVER}__w`, {}, withWrite("read_write"), l)).toBeNull();
    // …and read_write without the domain write grant is still refused: grants only narrow.
    expect(toolDispatchDenial(`${SERVER}__w`, {}, { ...withWrite("read_write"), writeDomains: new Set() }, l)?.code).toBe(
      "FORBIDDEN_TOOL_FOR_ROLE",
    );
  });

  /**
   * Romain, 2026-10-08: a member with no AccessRole (scope null) is governed by
   * the allowlist alone. The scope-only dispatch sites answer "no narrowing" for
   * them, and the multiplexer floor (same predicate as the offered list) decides.
   */
  it("a role-less member: an allowlisted tool is offered and runs, a non-allowlisted one the model names is refused", async () => {
    const { mux, fetchImpl } = build({ cache: seededCache(allowedNames) });
    // No scope: the principal helpers and the dispatch gate narrow nothing.
    expect(toolAllowedForPrincipal(`${SERVER}__tool_0`, "family", null)).toBe(true);
    expect(toolDispatchDenial(`${SERVER}__tool_20`, {}, null, lookup)).toBeNull();
    // Offer time and dispatch agree through the one predicate.
    const offered = (await mux.listTools()).map((t) => t.name);
    expect(offered).toEqual(allowedNames.map((n) => `${SERVER}__${n}`));
    expect((await mux.callTool(`${SERVER}__tool_0`, {})).isError).toBe(false);
    const refused = await mux.callTool(`${SERVER}__tool_20`, {});
    expect(JSON.parse(refused.content[0]!.text!)).toMatchObject({ error: RECORD_DENY_CODES.notAllowlisted });
    expect(calledTools(fetchImpl)).toEqual(["tool_0"]);
  });
});
