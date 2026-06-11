import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type TrustContext } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

/**
 * WARP-860 — per-call Plane service-token context plumbed via MCP
 * `_meta.pmToken` + `_meta.pmWorkspaces`.
 *
 * The orchestrator runtime-provisions a Plane service API token
 * (pm-service-token.service.ts) and forwards it per `pm_*` dispatch:
 * `mcpClient.callTool(name, args, { pmToken, pmWorkspaces? })` → MCP
 * `_meta` → `server.ts` CallToolRequestSchema handler → `buildContext`
 * → `ctx.pmApiKey` / `ctx.pmWorkspaces` → pm handlers.
 *
 * BOTH fields are gated on `trustedPrincipal` exactly like `userRole`
 * and `_enhancement` (WARP-845 / WARP-437): an HTTP client must not be
 * able to inject credentials or a fictional workspace list past the
 * JWT trust boundary. These tests pin the wire shape AND the gate.
 */

const realFetch = globalThis.fetch;

function buildDeps(): ContextDeps {
  return {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: () => ({
      get: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      post: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      patch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      delete: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    }),
  };
}

/** Capture the X-API-Key header the pm-client puts on the wire. */
function mockPlaneFetch(captured: { apiKey?: string; calls: number }) {
  const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    captured.calls++;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.apiKey = headers["X-API-Key"];
    return new Response("[]", { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function connect(trust: TrustContext) {
  const server = createServer(buildDeps(), trust);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "meta-pm-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function resultText(res: unknown): string {
  const content = (res as { content?: { text?: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

describe("MCP _meta.pmToken / _meta.pmWorkspaces (WARP-860)", () => {
  beforeEach(() => {
    process.env.DROPLET_PM_API_URL = "http://pm-api:8000";
    delete process.env.DROPLET_PM_ADMIN_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.DROPLET_PM_API_URL;
    vi.restoreAllMocks();
  });

  it("stdio (local-trusted): _meta.pmToken reaches the pm-client as X-API-Key", async () => {
    const captured = { apiKey: undefined as string | undefined, calls: 0 };
    mockPlaneFetch(captured);
    const { client, server } = await connect({ kind: "local-trusted" });

    await client.callTool({
      name: "pm_list_projects",
      arguments: { workspace_slug: "droplet-home" },
      _meta: { pmToken: "plane_api_svc" },
    });

    expect(captured.apiKey).toBe("plane_api_svc");

    await client.close();
    await server.close();
  });

  it("stdio: empty / non-string _meta.pmToken is dropped (defensive)", async () => {
    const captured = { apiKey: undefined as string | undefined, calls: 0 };
    mockPlaneFetch(captured);
    const { client, server } = await connect({ kind: "local-trusted" });

    await client.callTool({
      name: "pm_list_projects",
      arguments: { workspace_slug: "droplet-home" },
      _meta: { pmToken: "" },
    });

    expect(captured.apiKey).toBeUndefined();

    await client.close();
    await server.close();
  });

  it("stdio: _meta.pmWorkspaces short-circuits pm_list_workspaces with no HTTP call", async () => {
    const captured = { apiKey: undefined as string | undefined, calls: 0 };
    mockPlaneFetch(captured);
    const { client, server } = await connect({ kind: "local-trusted" });

    const workspaces = [{ id: "w1", slug: "droplet-home", name: "Droplet Home" }];
    const res = await client.callTool({
      name: "pm_list_workspaces",
      arguments: {},
      _meta: { pmToken: "plane_api_svc", pmWorkspaces: workspaces },
    });

    expect(captured.calls).toBe(0);
    expect(JSON.parse(resultText(res))).toEqual({ workspaces });

    await client.close();
    await server.close();
  });

  it("stdio: a malformed _meta.pmWorkspaces entry drops the whole field", async () => {
    const captured = { apiKey: undefined as string | undefined, calls: 0 };
    mockPlaneFetch(captured);
    const { client, server } = await connect({ kind: "local-trusted" });

    await client.callTool({
      name: "pm_list_workspaces",
      arguments: {},
      _meta: {
        // second entry has no slug — the validator must reject the field,
        // not forward a half-valid list to the handler.
        pmWorkspaces: [
          { id: "w1", slug: "droplet-home", name: "Droplet Home" },
          { id: "w2", name: "No Slug" },
        ],
      },
    });

    // Field dropped → handler falls through to the HTTP call.
    expect(captured.calls).toBe(1);

    await client.close();
    await server.close();
  });

  it("HTTP (authenticated): _meta.pmToken is IGNORED — credentials can't be injected", async () => {
    const captured = { apiKey: undefined as string | undefined, calls: 0 };
    mockPlaneFetch(captured);
    const { client, server } = await connect({
      kind: "authenticated",
      claims: { sub: "alice", role: "family" },
    });

    await client.callTool({
      name: "pm_list_projects",
      arguments: { workspace_slug: "droplet-home" },
      _meta: { pmToken: "attacker-token" },
    });

    expect(captured.apiKey).toBeUndefined();

    await client.close();
    await server.close();
  });

  it("HTTP (authenticated): _meta.pmWorkspaces is IGNORED — no workspace fictions", async () => {
    const captured = { apiKey: undefined as string | undefined, calls: 0 };
    mockPlaneFetch(captured);
    const { client, server } = await connect({
      kind: "authenticated",
      claims: { sub: "alice", role: "family" },
    });

    await client.callTool({
      name: "pm_list_workspaces",
      arguments: {},
      _meta: {
        pmWorkspaces: [{ id: "wX", slug: "evil", name: "Injected" }],
      },
    });

    // Injection ignored → the handler must hit the real upstream.
    expect(captured.calls).toBe(1);

    await client.close();
    await server.close();
  });
});
