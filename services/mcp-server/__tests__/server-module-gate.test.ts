import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FAIL_CLOSED_MODULE_VERDICT, TOOL_CATALOG, type ModuleVerdict } from "@droplet/tools-core";
import { createServer, type TrustContext } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";
import type { ModuleVerdictSource } from "../src/module-verdict.js";

/**
 * WARP-2972 — module gating at the MCP protocol layer, both transports.
 *
 * A tool whose domain a module toggle or the acting person's grants withhold is
 * ABSENT from `tools/list` and refused by `tools/call` — absent, not an empty
 * list and not an errored one. The verdict comes from the orchestrator (the
 * only process that knows the module registry); when it cannot be had, the
 * server FAILS CLOSED: module-owned tools withheld, unclaimed domains kept.
 */

const CAMERA_TOOL = TOOL_CATALOG.find((t) => t.domain === "cameras" && !t.requiresWrite)!.name;
// A network tool that hops to the orchestrator, so "the handler ran" is observable.
const NETWORK_TOOL = "get_network_status";
// `system` is claimed by no module (FEATURE_UNGATED_TOOL_DOMAINS): never withheld.
const UNCLAIMED_TOOL = TOOL_CATALOG.find((t) => t.domain === "system" && !t.requiresWrite)!.name;

it("the fixtures name real tools in the domains they claim", () => {
  const domainOf = (n: string) => TOOL_CATALOG.find((t) => t.name === n)?.domain;
  expect(domainOf(NETWORK_TOOL)).toBe("network");
  expect(domainOf(CAMERA_TOOL)).toBe("cameras");
  expect(domainOf(UNCLAIMED_TOOL)).toBe("system");
});

const withheld = (...domains: string[]): ModuleVerdict => ({ withheldDomains: new Set(domains) });

function buildDeps(): { deps: ContextDeps; hop: ReturnType<typeof vi.fn> } {
  const hop = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
  return {
    hop,
    deps: {
      prisma: {} as never,
      matter: {} as never,
      httpFactory: () => ({ get: hop, post: hop, patch: hop, delete: hop }),
    },
  };
}

async function connect(trust: TrustContext, moduleVerdict: ModuleVerdictSource | undefined) {
  const { deps, hop } = buildDeps();
  const server = createServer(deps, trust, { moduleVerdict });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "module-gate-test", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, hop };
}

const http = (sub = "u-admin"): TrustContext => ({
  kind: "authenticated",
  claims: { sub, role: "admin" },
});
const stdio: TrustContext = { kind: "local-trusted" };

const namesOf = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
const errorCode = (res: unknown): string | undefined => {
  const text = (res as { content: Array<{ text: string }> }).content[0]!.text;
  return (JSON.parse(text) as { error?: { code?: string } }).error?.code;
};

describe("HTTP transport (an external MCP client)", () => {
  it("tools/list omits the tools of a withheld domain and keeps the rest", async () => {
    const { client } = await connect(http(), async () => withheld("cameras"));
    const names = await namesOf(client);
    expect(names).not.toContain(CAMERA_TOOL);
    expect(names).toContain(NETWORK_TOOL);
    expect(names).toContain(UNCLAIMED_TOOL);
  });

  it("tools/list is a list, not an error, when EVERY module-owned domain is withheld", async () => {
    const { client } = await connect(http(), async () => FAIL_CLOSED_MODULE_VERDICT);
    const names = await namesOf(client);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain(UNCLAIMED_TOOL);
  });

  it("tools/call refuses a withheld tool BEFORE its handler runs", async () => {
    const { client, hop } = await connect(http(), async () => withheld("cameras"));
    const res = await client.callTool({ name: CAMERA_TOOL, arguments: {} });
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("module_disabled");
    expect(hop).not.toHaveBeenCalled();
  });

  it("tools/call still serves a tool the verdict keeps", async () => {
    const { client, hop } = await connect(http(), async () => withheld("cameras"));
    await client.callTool({ name: NETWORK_TOOL, arguments: {} });
    expect(hop).toHaveBeenCalled();
  });

  it("module off for the PERSON: the same verdict source lists different tools for different JWT subjects", async () => {
    // The orchestrator answers per person (their own grants / deny exceptions);
    // the server must key the question on the subject it is talking to.
    const perPerson: ModuleVerdictSource = async (who) =>
      who === "u-carol" ? withheld("cameras") : withheld();
    const carol = await connect(http("u-carol"), perPerson);
    const dave = await connect(http("u-dave"), perPerson);
    expect(await namesOf(carol.client)).not.toContain(CAMERA_TOOL);
    expect(await namesOf(dave.client)).toContain(CAMERA_TOOL);
    const refused = await carol.client.callTool({ name: CAMERA_TOOL, arguments: {} });
    expect(errorCode(refused)).toBe("module_disabled");
    await dave.client.callTool({ name: CAMERA_TOOL, arguments: {} });
    expect(dave.hop).toHaveBeenCalled();
  });

  it("asks about the JWT subject: the JWT names the person, _meta cannot", async () => {
    const source = vi.fn<ModuleVerdictSource>(async () => withheld());
    const { client } = await connect(http("u-carol"), source);
    await client.listTools();
    await client.callTool({ name: NETWORK_TOOL, arguments: {}, _meta: { userId: "someone-else" } });
    expect(source.mock.calls.map((c) => c[0])).toEqual(["u-carol", "u-carol"]);
  });

  it("gates a tool the caller's ROLE would otherwise allow, and does not widen a role", async () => {
    // A family caller loses write tools to RBAC; the module verdict never adds any back.
    const source: ModuleVerdictSource = async () => withheld();
    const { client } = await connect({ kind: "authenticated", claims: { sub: "u", role: "family" } }, source);
    const names = await namesOf(client);
    const write = TOOL_CATALOG.find((t) => t.requiresWrite)!.name;
    expect(names).not.toContain(write);
  });
});

describe("fail closed (no verdict could be had)", () => {
  it("withholds module-owned tools from tools/list and keeps unclaimed domains", async () => {
    const { client } = await connect(http(), async () => FAIL_CLOSED_MODULE_VERDICT);
    const names = await namesOf(client);
    const owned = TOOL_CATALOG.filter((t) => FAIL_CLOSED_MODULE_VERDICT.withheldDomains.has(t.domain));
    expect(owned.length).toBeGreaterThan(0);
    for (const t of owned) expect(names, t.name).not.toContain(t.name);
    expect(names).toContain(UNCLAIMED_TOOL);
  });

  it("refuses a module-owned call and serves an unclaimed one", async () => {
    const { client, hop } = await connect(http(), async () => FAIL_CLOSED_MODULE_VERDICT);
    const refused = await client.callTool({ name: NETWORK_TOOL, arguments: {} });
    expect(errorCode(refused)).toBe("module_disabled");
    expect(hop).not.toHaveBeenCalled();
    await client.callTool({ name: UNCLAIMED_TOOL, arguments: {} });
    expect(hop).toHaveBeenCalled();
  });
});

describe("stdio transport (the orchestrator's own child)", () => {
  it("tools/list stays the RAW registry: the orchestrator gates the pool on top of its own cache", async () => {
    // The stdio client caches tools/list for the process lifetime; a verdict
    // baked into that list would outlive the toggle. Gating happens at list
    // time in the orchestrator, and at CALL time here.
    const source = vi.fn<ModuleVerdictSource>(async () => withheld("cameras"));
    const { client } = await connect(stdio, source);
    expect(await namesOf(client)).toContain(CAMERA_TOOL);
    expect(source).not.toHaveBeenCalled();
  });

  it("tools/call refuses a withheld tool for the person in _meta.userId", async () => {
    const source = vi.fn<ModuleVerdictSource>(async () => withheld("cameras"));
    const { client, hop } = await connect(stdio, source);
    const res = await client.callTool({ name: CAMERA_TOOL, arguments: {}, _meta: { userId: "carol" } });
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("module_disabled");
    expect(source).toHaveBeenCalledWith("carol");
    expect(hop).not.toHaveBeenCalled();
  });

  it("module off for the PERSON over stdio: the same child refuses carol and serves dave", async () => {
    const perPerson: ModuleVerdictSource = async (who) =>
      who === "carol" ? withheld("cameras") : withheld();
    const { client, hop } = await connect(stdio, perPerson);
    const refused = await client.callTool({ name: CAMERA_TOOL, arguments: {}, _meta: { userId: "carol" } });
    expect(errorCode(refused)).toBe("module_disabled");
    expect(hop).not.toHaveBeenCalled();
    await client.callTool({ name: CAMERA_TOOL, arguments: {}, _meta: { userId: "dave" } });
    expect(hop).toHaveBeenCalled();
  });

  it("asks about the box when the call names nobody (a scheduled run)", async () => {
    const source = vi.fn<ModuleVerdictSource>(async () => withheld());
    const { client } = await connect(stdio, source);
    await client.callTool({ name: NETWORK_TOOL, arguments: {} });
    expect(source).toHaveBeenCalledWith(undefined);
  });

  it("fails closed on call when no verdict could be had", async () => {
    const { client, hop } = await connect(stdio, async () => FAIL_CLOSED_MODULE_VERDICT);
    const res = await client.callTool({ name: NETWORK_TOOL, arguments: {}, _meta: { userId: "carol" } });
    expect(errorCode(res)).toBe("module_disabled");
    expect(hop).not.toHaveBeenCalled();
  });
});

describe("no verdict source configured (unit tests, embedders)", () => {
  it("withholds nothing", async () => {
    const { client } = await connect(http(), undefined);
    const names = await namesOf(client);
    expect(names).toContain(CAMERA_TOOL);
    expect(names).toContain(NETWORK_TOOL);
  });
});

describe("index.ts wires the verdict into BOTH transports", () => {
  // A server built WITHOUT a source gates nothing, so a transport that forgot
  // the option is a silent fail-open. There is one construction site per
  // transport; pin them.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");

  it("the stdio server", () => {
    expect(src).toMatch(/createServer\(deps,\s*\{\s*kind:\s*"local-trusted"\s*\},\s*\{[^}]*moduleVerdict/);
  });

  it("the HTTP server", () => {
    expect(src).toMatch(/createServer\(deps,\s*\{\s*kind:\s*"authenticated",\s*claims\s*\},\s*\{[^}]*moduleVerdict/);
  });
});
