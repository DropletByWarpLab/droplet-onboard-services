import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type http from "node:http";
import { startHttp } from "../src/transports/http.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

/**
 * End-to-end: real MCP `Client` over `StreamableHTTPClientTransport`
 * talking to our `startHttp` listener. Covers:
 *   - 401 on missing Bearer
 *   - 401 on invalid signature
 *   - admin sees + can call write tools
 *   - family sees only read tools
 *   - family is refused on write tool dispatch (re-check)
 *   - /health works without auth
 */
const SECRET = "test-secret-http";

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

async function connect(port: number, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-roundtrip-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("http roundtrip", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const deps = buildDeps();
    // Bind to port 0 so the OS picks a free one — avoids flake on CI when
    // a previous run leaked the port.
    server = startHttp({
      port: 0,
      host: "127.0.0.1",
      jwtSecret: SECRET,
      buildServer: (claims) => createServer(deps, claims),
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("http transport did not bind");
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("/health responds 200 without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("rejects request without Bearer token with 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("missing_bearer_token");
  });

  it("rejects request with invalid JWT signature with 401", async () => {
    const bad = jwt.sign({ sub: "u1", role: "admin" }, "wrong-secret", { expiresIn: "5m" });
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bad}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_token");
  });

  it("admin sees write tools in tools/list", async () => {
    const token = jwt.sign({ sub: "admin1", role: "admin" }, SECRET, { expiresIn: "5m" });
    const client = await connect(port, token);
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).toContain("block_network_device");
    await client.close();
  });

  it("family does NOT see write tools in tools/list", async () => {
    const token = jwt.sign({ sub: "f1", role: "family" }, SECRET, { expiresIn: "5m" });
    const client = await connect(port, token);
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).not.toContain("block_network_device");
    await client.close();
  });

  it("family calling a write tool is refused with forbidden_tool_for_role", async () => {
    const token = jwt.sign({ sub: "f1", role: "family" }, SECRET, { expiresIn: "5m" });
    const client = await connect(port, token);
    const res = await client.callTool({
      name: "block_network_device",
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    expect(res.isError).toBe(true);
    const blocks = res.content as { type: string; text: string }[];
    const parsed = JSON.parse(blocks[0].text);
    expect(parsed.error.code).toBe("forbidden_tool_for_role");
    await client.close();
  });

  // WARP-103 reviewer follow-up: a JWT with a non-canonical role string
  // (e.g. "Admin" with a capital A) must be rejected at the auth layer
  // (401), not silently downgraded to undefined and then up-graded to
  // stdio-trusted. Defense in depth against future orchestrator-side
  // typos in token issuance.
  it("rejects JWT with case-mismatched role 'Admin' with 401", async () => {
    const token = jwt.sign({ sub: "u1", role: "Admin" }, SECRET, { expiresIn: "5m" });
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_token");
  });

  it("rejects JWT with unknown role string 'viewer' with 401", async () => {
    const token = jwt.sign({ sub: "u2", role: "viewer" }, SECRET, { expiresIn: "5m" });
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_token");
  });

  it("accepts JWT with no role claim and treats it as untrusted (sees only read tools)", async () => {
    const token = jwt.sign({ sub: "anon" }, SECRET, { expiresIn: "5m" });
    const client = await connect(port, token);
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).not.toContain("block_network_device");
    await client.close();
  });
});
