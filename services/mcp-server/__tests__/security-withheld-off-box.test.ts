import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type http from "node:http";
import { startHttp } from "../src/transports/http.js";
import { createServer } from "../src/server.js";
import { isWithheldOffBox, OFF_BOX_WITHHELD_DOMAINS } from "../src/rbac.js";
import type { ContextDeps } from "../src/context.js";

/**
 * WARP-2979 (#2420 review 2a; ADR-059 P4 §6.13 "security never leaves the
 * box") — the four `security_*` tools are withheld on every transport that is
 * not the orchestrator's own stdio child.
 *
 * Why the HTTP transport: an owner who publishes :9090 and points Claude
 * Desktop at it with their JWT would otherwise get every Security read tool,
 * with the results going to that client's cloud model.
 *
 * Why this keeps on-box chat: the dashboard's chat, voice and agent runs all
 * run the orchestrator's agent loop, which spawns this server over stdio
 * (`local-trusted`, services/mcp-client.service.ts). droplet-local-LLM runs no
 * agent and no MCP client (its ADR-003: "Tools come from a stdio-spawned MCP
 * server"). So `local-trusted` is the only on-box path, and it keeps all four.
 */
const SECRET = "test-secret-security-withheld";
const SECURITY_TOOLS = ["security_list_incidents", "security_get_incident", "security_search_events", "security_zone_status"];

function buildDeps() {
  const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ incidents: [], nextCursor: null }), { status: 200 }));
  const deps: ContextDeps = {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: () => ({ get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
  };
  return { deps, get };
}

const errorCode = (res: Awaited<ReturnType<Client["callTool"]>>): string | undefined => {
  if (!res.isError) return undefined;
  try {
    return JSON.parse((res.content as { text: string }[])[0]!.text)?.error?.code;
  } catch {
    return undefined;
  }
};

describe("the security domain off the box (§6.13)", () => {
  it("the withheld set is exactly `security`; a security tool is withheld, a camera tool is not", () => {
    expect([...OFF_BOX_WITHHELD_DOMAINS]).toEqual(["security"]);
    expect(isWithheldOffBox({ name: "security_list_incidents" })).toBe(true);
    expect(isWithheldOffBox({ name: "list_cameras" })).toBe(false);
    // A remote server's tool (not in our catalog) is not ours to classify here.
    expect(isWithheldOffBox({ name: "some_remote_tool" })).toBe(false);
  });

  describe("an external client over HTTP, with the OWNER's JWT", () => {
    let server: http.Server;
    let port: number;
    let get: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      const built = buildDeps();
      get = built.get;
      server = startHttp({
        port: 0,
        host: "127.0.0.1",
        jwtSecret: SECRET,
        buildServer: (claims) => createServer(built.deps, { kind: "authenticated", claims }),
      });
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("http transport did not bind");
      port = addr.port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function ownerClient() {
      const token = jwt.sign({ type: "access", sub: "u-owner", role: "owner" }, SECRET, { expiresIn: "5m" });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "claude-desktop-like", version: "0.0.1" }, { capabilities: {} });
      await client.connect(transport);
      return client;
    }

    it("tools/list names no security_* tool (and still lists the rest)", async () => {
      const client = await ownerClient();
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const t of SECURITY_TOOLS) expect(names).not.toContain(t);
      expect(names).toContain("list_cameras");
      await client.close();
    });

    it("a CallTool for one by name is refused before its handler runs", async () => {
      const client = await ownerClient();
      for (const name of SECURITY_TOOLS) {
        const res = await client.callTool({ name, arguments: name === "security_get_incident" ? { id: "00000000-0000-4000-8000-000000000001" } : {} });
        expect(res.isError, name).toBe(true);
        expect(errorCode(res), name).toBe("withheld_off_box");
      }
      expect(get).not.toHaveBeenCalled();
      await client.close();
    });
  });

  describe("on-box chat: the orchestrator's stdio child (local-trusted)", () => {
    it("lists all four and dispatches one to the orchestrator's assistant route", async () => {
      const { deps, get } = buildDeps();
      const server = createServer(deps, { kind: "local-trusted" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "orchestrator-agent-loop", version: "0.0.1" }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const t of SECURITY_TOOLS) expect(names).toContain(t);
      const res = await client.callTool({ name: "security_list_incidents", arguments: {} });
      expect(errorCode(res)).not.toBe("withheld_off_box");
      expect(get).toHaveBeenCalled();
      expect(String(get.mock.calls[0]![0])).toContain("/api/security/assistant/incidents");
      await client.close();
      await server.close();
    });
  });
});
