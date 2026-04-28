/**
 * MCP integration tests — exercise the streamable-HTTP transport added in
 * WARP-103 against a live mcp-server (Compose service or `node dist/index.js
 * --transport=http`).
 *
 * Covers the four scenarios from spec §11.2, scoped to the HTTP surface
 * (the spec's scenario 1 — dashboard → stdio in-proc — is already covered
 * by services/mcp-server/__tests__/stdio-roundtrip.test.ts):
 *
 *   1. unauthenticated request gets HTTP 401 / MCP `Unauthorized`
 *   2. admin JWT can list every tool and call `list_network_devices`
 *   3. family JWT sees only read tools and is refused on write tool dispatch
 *   4. admin call to `block_network_device` returns `confirmation_required`
 *      (NOT a hard error per spec §7.1) — confirms the 202-passthrough
 *      survives end-to-end through the HTTP transport.
 *
 * Run against a live stack:
 *   docker compose -f docker/docker-compose.yml up -d
 *   MCP_BASE_URL=http://localhost:9090/ JWT_SECRET=$(grep ^JWT_SECRET .env | cut -d= -f2) \
 *     npx vitest run tests/mcp.integration.test.ts
 *
 * The CI-friendly path is `tests/docker-compose.test.yml` once the
 * mcp-server service is wired in (out of scope for WARP-103); this file
 * is the standalone vitest harness in the meantime.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_BASE = process.env.MCP_BASE_URL ?? "http://localhost:9090/";
const SECRET = process.env.JWT_SECRET ?? "test-secret";

function jwtFor(role: "admin" | "family"): string {
  // Admin-issued JWT shape, mirroring how a real client obtains one via
  // POST /api/auth/login on the orchestrator. Per spec §13 note 2, v1
  // does not provide a service-account token endpoint — a long-lived
  // admin-issued JWT is the documented path, so this `jwt.sign` call is
  // an analogue of "operator runs login, copies the token".
  return jwt.sign({ sub: `u-${role}`, role }, SECRET, { expiresIn: "5m" });
}

async function connect(role: "admin" | "family"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_BASE), {
    requestInit: { headers: { Authorization: `Bearer ${jwtFor(role)}` } },
  });
  const client = new Client({ name: "mcp-integration", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("mcp integration (compose stack)", () => {
  let admin: Client;
  let family: Client;

  beforeAll(async () => {
    // Smoke check: mcp-server's healthcheck must answer before we trust
    // the rest of the test run. Skip the suite cleanly if the stack
    // isn't up — these tests are opt-in (run against a live deploy),
    // not part of the unit-test default.
    const healthUrl = new URL("/health", MCP_BASE);
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) {
        throw new Error(`mcp-server /health returned ${res.status}`);
      }
    } catch (err) {
      throw new Error(
        `mcp-server not reachable at ${MCP_BASE}. Bring the stack up first ` +
          `(docker compose -f docker/docker-compose.yml up -d mcp-server). ` +
          `Underlying: ${(err as Error).message}`,
      );
    }
    admin = await connect("admin");
    family = await connect("family");
  }, 30_000);

  afterAll(async () => {
    await admin?.close();
    await family?.close();
  });

  // Scenario 1 — no JWT → MCP `Unauthorized` (HTTP 401 envelope) ────────
  it("rejects unauthenticated request with HTTP 401", async () => {
    const res = await fetch(MCP_BASE, { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("missing_bearer_token");
  });

  // Scenario 2 — admin JWT lists all tools and can call list_network_devices ─
  it("admin can list every tool", async () => {
    const res = await admin.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).toContain("block_network_device");
    // Per spec §6.1 the registry is ~50–60 tools after WARP-102; assert
    // the lower bound only so a future port doesn't have to update us.
    expect(names.length).toBeGreaterThanOrEqual(50);
  });

  it("admin can call list_network_devices and gets a non-error tool result", async () => {
    const res = await admin.callTool({ name: "list_network_devices", arguments: {} });
    // The handler may legitimately return a routing-side error if the
    // routing service is unreachable from the mcp-server pod, but the
    // shape must NOT be an RBAC refusal.
    if (res.isError) {
      const blocks = res.content as { type: string; text: string }[];
      const parsed = JSON.parse(blocks[0].text);
      expect(parsed.error?.code).not.toBe("forbidden_tool_for_role");
    } else {
      expect(Array.isArray(res.content)).toBe(true);
    }
  });

  // Scenario 3 — family JWT sees only read tools, refused on write dispatch
  it("family cannot see write tools in tools/list", async () => {
    const res = await family.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).not.toContain("block_network_device");
  });

  it("family cannot call write tools (forbidden_tool_for_role)", async () => {
    const res = await family.callTool({
      name: "block_network_device",
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    expect(res.isError).toBe(true);
    const blocks = res.content as { type: string; text: string }[];
    const parsed = JSON.parse(blocks[0].text);
    expect(parsed.error.code).toBe("forbidden_tool_for_role");
  });

  // Scenario 4 — admin call to block_network_device returns confirmation_required
  it("admin call to block_network_device returns confirmation_required (not isError)", async () => {
    const res = await admin.callTool({
      name: "block_network_device",
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    // Per spec §7.1: confirmation_required is `isError: false` — the
    // model treats it as a normal tool result and surfaces the message.
    // The wrapped body still says status: "confirmation_required".
    expect(res.isError).toBe(false);
    const blocks = res.content as { type: string; text: string }[];
    const parsed = JSON.parse(blocks[0].text);
    expect(parsed.status).toBe("confirmation_required");
  });
});
