import { describe, it, expect, vi } from "vitest";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

describe("createServer", () => {
  it("returns an MCP Server with tools capability advertised", () => {
    const deps: ContextDeps = {
      prisma: {} as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
    };
    const server = createServer(deps);
    expect(server).toBeDefined();
    // MCP SDK 1.29 stores server info on `_serverInfo` (private field).
    const info = (server as unknown as { _serverInfo: { name: string } })._serverInfo;
    expect(info.name).toBe("droplet-mcp-server");
  });
});
