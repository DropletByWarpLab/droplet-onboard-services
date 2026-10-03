import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type TrustContext } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";
import { NO_MODULE_GATING } from "../src/module-verdict.js";

/**
 * WARP-3116 — the dashboard's page list rides `_meta.dashboardPages` from
 * the orchestrator's agent loop to the navigation handlers. Trusted-stdio
 * only, like `userRole` and `_enhancement`: over HTTP a client could hand
 * the tools a list of its own making.
 */

const PAGES = [
  { href: "/voice", label: "Voice", section: "Systems › Network" },
  { href: "/settings", label: "Settings", section: "Admin" },
];

const deps: ContextDeps = {
  prisma: {} as never,
  matter: {} as never,
  httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
};

async function connect(trust: TrustContext) {
  const server = createServer(deps, trust, { moduleVerdict: NO_MODULE_GATING });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "meta-dashboard-pages-test", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

// `callTool` returns a union that includes the task-result shape (no
// `content`), so the narrowing happens here once rather than at each call.
function body(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

describe("MCP _meta.dashboardPages propagation", () => {
  it("reaches open_dashboard_page on the trusted stdio path", async () => {
    const { client, server } = await connect({ kind: "local-trusted" });
    const res = await client.callTool({
      name: "open_dashboard_page",
      arguments: { page: "voice settings" },
      _meta: { userId: "alice", dashboardPages: PAGES },
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(body(res))).toMatchObject({
      action: "navigate",
      href: "/voice",
      label: "Voice",
    });
    await client.close();
    await server.close();
  });

  it("is ignored over HTTP, where the caller is not the orchestrator", async () => {
    const { client, server } = await connect({
      kind: "authenticated",
      claims: { sub: "alice", role: "owner" },
    });
    const res = await client.callTool({
      name: "open_dashboard_page",
      arguments: { page: "voice" },
      _meta: { dashboardPages: PAGES },
    });
    expect(res.isError).toBe(true);
    expect(body(res)).toContain("NAVIGATION_UNAVAILABLE");
    await client.close();
    await server.close();
  });

  it("drops a non-array value", async () => {
    const { client, server } = await connect({ kind: "local-trusted" });
    const res = await client.callTool({
      name: "find_dashboard_page",
      arguments: { query: "voice" },
      _meta: { dashboardPages: { href: "/voice", label: "Voice" } },
    });
    expect(res.isError).toBe(true);
    expect(body(res)).toContain("NAVIGATION_UNAVAILABLE");
    await client.close();
    await server.close();
  });
});
