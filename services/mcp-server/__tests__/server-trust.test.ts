import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type TrustContext } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

/**
 * WARP-563 — tool trust must be an explicit, named TrustContext, never
 * inferred from the absence of a claims object.
 *
 *   { kind: "local-trusted" }                 -> stdio in-proc: trusted, no RBAC
 *   { kind: "authenticated", claims }         -> network: RBAC always enforced
 *
 * The load-bearing regression test is the "unrecognized posture" case: the
 * pre-fix code derived `trustedPrincipal = claims === undefined`, so anything
 * reaching createServer without claims silently became trusted. With the
 * explicit flag, only `kind === "local-trusted"` is trusted; any other (or
 * unknown/future) posture must FAIL CLOSED to read-only.
 */

const WRITE_TOOL = "block_network_device"; // requiresWrite === true
const READ_TOOL = "list_network_devices"; // requiresWrite === false

function buildDeps(): ContextDeps {
  return {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: () => ({
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    }),
  };
}

async function connect(trust: TrustContext) {
  const server = createServer(buildDeps(), trust);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "trust-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function errorCode(res: Awaited<ReturnType<Client["callTool"]>>): string | undefined {
  if (!res.isError) return undefined;
  const blocks = res.content as { type: string; text: string }[];
  try {
    return JSON.parse(blocks[0].text)?.error?.code;
  } catch {
    return undefined;
  }
}

describe("createServer trust is an explicit TrustContext (WARP-563)", () => {
  it("local-trusted (stdio) may call a write tool — not RBAC-denied", async () => {
    const { client, server } = await connect({ kind: "local-trusted" });
    const res = await client.callTool({
      name: WRITE_TOOL,
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    // It may error for other reasons (empty deps stub), but NEVER for RBAC.
    expect(errorCode(res)).not.toBe("forbidden_tool_for_role");
    await client.close();
    await server.close();
  });

  it("authenticated owner may call a write tool — not RBAC-denied", async () => {
    const { client, server } = await connect({
      kind: "authenticated",
      claims: { sub: "u-owner", role: "owner" },
    });
    const res = await client.callTool({
      name: WRITE_TOOL,
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    expect(errorCode(res)).not.toBe("forbidden_tool_for_role");
    await client.close();
    await server.close();
  });

  it("authenticated guest is denied a write tool with forbidden_tool_for_role", async () => {
    const { client, server } = await connect({
      kind: "authenticated",
      claims: { sub: "u-guest", role: "guest" },
    });
    const res = await client.callTool({
      name: WRITE_TOOL,
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("forbidden_tool_for_role");
    await client.close();
    await server.close();
  });

  it("authenticated guest may still call a read tool", async () => {
    const { client, server } = await connect({
      kind: "authenticated",
      claims: { sub: "u-guest", role: "guest" },
    });
    const res = await client.callTool({ name: READ_TOOL, arguments: {} });
    // Read tools are never RBAC-denied; a non-RBAC handler failure is fine.
    expect(errorCode(res)).not.toBe("forbidden_tool_for_role");
    await client.close();
    await server.close();
  });

  it("REGRESSION: an unrecognized/future trust posture FAILS CLOSED to read-only", async () => {
    // Simulates a future transport (or refactor) that forgets to declare a
    // posture. The pre-fix `claims === undefined` heuristic would treat this
    // as trusted; the explicit flag must deny the write tool instead.
    const bogus = { kind: "future-transport" } as unknown as TrustContext;
    const { client, server } = await connect(bogus);
    const res = await client.callTool({
      name: WRITE_TOOL,
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("forbidden_tool_for_role");
    await client.close();
    await server.close();
  });
});
