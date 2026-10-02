import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_CATALOG, type Tool, type ToolDomain } from "@droplet/tools-core";
import { createServer, type TrustContext } from "../src/server.js";
import { OFF_BOX_WITHHELD_DOMAINS, filterToolsForRole, isWithheldOffBox } from "../src/rbac.js";
import type { ContextDeps } from "../src/context.js";
import { NO_MODULE_GATING } from "../src/module-verdict.js";

/**
 * Tool domains that never leave the box (rbac.ts `OFF_BOX_WITHHELD_DOMAINS`) —
 * withheld on every transport that is not the orchestrator's own stdio child
 * (`local-trusted`), whatever the caller's role: an owner's JWT over HTTP
 * (an external MCP client pointed at a published :9090) included, because that
 * client hands results to its own cloud model.
 *
 * The set ships EMPTY — no domain is withheld today — and the first suite pins
 * that on the real server. The guard itself is generic, so the rest registers
 * a probe domain for the length of each case and removes it afterwards, and
 * pins what withholding a domain buys: absent from `tools/list`, refused by
 * `tools/call` before any role check or handler, and untouched on the stdio
 * child (on-box chat keeps every tool).
 *
 * Mutations these are written to catch:
 *   - drop the off-box filter from `filterToolsForRole`  → the list cases red
 *   - drop the guard from the CallTool handler           → the call cases red
 *   - apply the guard to the trusted stdio child too     → the on-box case reds
 *   - withhold a domain by default                       → the "ships empty" suite reds
 */

/** A camera read: a real tool, in a domain no module gate or role narrows for the callers below. */
const CAMERA_TOOL = TOOL_CATALOG.find((t) => t.domain === "cameras" && !t.requiresWrite)!.name;
const CAMERA_TOOLS = TOOL_CATALOG.filter((t) => t.domain === "cameras").map((t) => t.name);
// A network tool that hops to the orchestrator, so "the handler ran" is observable.
const NETWORK_TOOL = "get_network_status";
const PROBE_DOMAIN: ToolDomain = "cameras";

/** The set is a plain `Set` behind a `ReadonlySet` type; a case registers and removes its probe through this. */
const registry = OFF_BOX_WITHHELD_DOMAINS as Set<ToolDomain>;

/** Register the probe domain around every case of the enclosing `describe`. */
function withholdProbeDomain(): void {
  beforeEach(() => {
    registry.add(PROBE_DOMAIN);
  });
  afterEach(() => {
    registry.delete(PROBE_DOMAIN);
  });
}

function fakeTool(name: string, requiresWrite: boolean): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    requiresWrite,
    requiresConfirmation: false,
    handler: async () => ({ ok: true, data: null }),
  };
}

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

/** Gating is not under test here, so the module gate is opted out of explicitly (a server with no verdict source fails closed). */
async function connect(trust: TrustContext) {
  const { deps, hop } = buildDeps();
  const server = createServer(deps, trust, { moduleVerdict: NO_MODULE_GATING });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "off-box-test", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, hop };
}

const overHttp = (role: "owner" | "admin"): TrustContext => ({
  kind: "authenticated",
  claims: { sub: `u-${role}`, role },
});
const stdio: TrustContext = { kind: "local-trusted" };

const namesOf = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
const errorCode = (res: unknown): string | undefined => {
  const text = (res as { content: Array<{ text: string }> }).content[0]!.text;
  return (JSON.parse(text) as { error?: { code?: string } }).error?.code;
};

describe("no domain is withheld off the box by default", () => {
  it("the set ships empty, and no catalog tool is withheld", () => {
    expect([...OFF_BOX_WITHHELD_DOMAINS]).toEqual([]);
    expect(CAMERA_TOOLS.length).toBeGreaterThan(1);
    for (const entry of TOOL_CATALOG) expect(isWithheldOffBox({ name: entry.name }), entry.name).toBe(false);
  });

  it("an owner over HTTP lists a tool of any domain and is served it", async () => {
    const { client, hop } = await connect(overHttp("owner"));
    const names = await namesOf(client);
    expect(names).toContain(CAMERA_TOOL);
    expect(names).toContain(NETWORK_TOOL);
    const res = await client.callTool({ name: CAMERA_TOOL, arguments: {} });
    expect(errorCode(res)).not.toBe("withheld_off_box");
    expect(hop).toHaveBeenCalled();
  });
});

describe("a domain withheld off the box", () => {
  withholdProbeDomain();

  it("is recognised by its tools, and by nothing else: a tool of another domain, or of a remote server, is not withheld", () => {
    expect(isWithheldOffBox({ name: CAMERA_TOOL })).toBe(true);
    expect(isWithheldOffBox({ name: NETWORK_TOOL })).toBe(false);
    // A remote server's tool (not in our catalog) is not ours to classify here.
    expect(isWithheldOffBox({ name: "some_remote_tool" })).toBe(false);
  });

  it("is dropped from the list for every role, even a privileged one — only the trusted principal keeps it", () => {
    const all = TOOL_CATALOG.map((e) => fakeTool(e.name, e.requiresWrite));
    for (const role of ["owner", "admin", "family", "guest", undefined] as const) {
      const names = filterToolsForRole(all, role).map((t) => t.name);
      for (const name of CAMERA_TOOLS) expect(names, `${role}: ${name}`).not.toContain(name);
    }
    expect(filterToolsForRole(all, "owner").map((t) => t.name)).toContain(NETWORK_TOOL);
    const trusted = filterToolsForRole(all, undefined, { trustedPrincipal: true }).map((t) => t.name);
    for (const name of CAMERA_TOOLS) expect(trusted, name).toContain(name);
  });

  describe.each([["an owner", overHttp("owner")], ["an admin", overHttp("admin")]])(
    "%s over HTTP (an external MCP client)",
    (_label, trust) => {
      it("tools/list names none of its tools (and still lists the rest)", async () => {
        const { client } = await connect(trust);
        const names = await namesOf(client);
        for (const name of CAMERA_TOOLS) expect(names, name).not.toContain(name);
        expect(names).toContain(NETWORK_TOOL);
      });

      it("a CallTool for one by name is refused before its handler runs", async () => {
        const { client, hop } = await connect(trust);
        for (const name of CAMERA_TOOLS) {
          const res = await client.callTool({ name, arguments: {} });
          expect(res.isError, name).toBe(true);
          expect(errorCode(res), name).toBe("withheld_off_box");
        }
        expect(hop).not.toHaveBeenCalled();
      });

      it("a tool of another domain is still served", async () => {
        const { client, hop } = await connect(trust);
        await client.callTool({ name: NETWORK_TOOL, arguments: {} });
        expect(hop).toHaveBeenCalled();
      });
    },
  );

  describe("on-box chat: the orchestrator's stdio child (local-trusted)", () => {
    it("lists all of its tools and dispatches one to its handler", async () => {
      const { client, hop } = await connect(stdio);
      const names = await namesOf(client);
      for (const name of CAMERA_TOOLS) expect(names, name).toContain(name);
      const res = await client.callTool({ name: CAMERA_TOOL, arguments: {} });
      expect(errorCode(res)).not.toBe("withheld_off_box");
      expect(hop).toHaveBeenCalled();
    });
  });
});
