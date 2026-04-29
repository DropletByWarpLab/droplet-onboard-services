import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Verifies that `McpClientService.callTool(name, args, context)` plumbs
 * the per-call `context` (currently `{ ncToken }`) through to the SDK
 * `Client.callTool` request body's `_meta` field — NOT into the
 * tool's `arguments`.
 *
 * Pairs with `services/mcp-server/__tests__/meta-nctoken.test.ts`,
 * which proves the SERVER side reads `_meta.ncToken` and lands it in
 * `ctx.ncToken`. Together they pin the contract end-to-end without
 * needing a real spawned child.
 */

// Mock the SDK Client so we can capture exactly what `callTool` was
// called with. `vi.hoisted` keeps the spy stable across the
// `vi.mock` factory and the test body.
const sdkSpies = vi.hoisted(() => {
  const callTool = vi.fn().mockResolvedValue({ content: [], isError: false });
  const listTools = vi.fn().mockResolvedValue({ tools: [] });
  const connect = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  return { callTool, listTools, connect, close };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    callTool: sdkSpies.callTool,
    listTools: sdkSpies.listTools,
    connect: sdkSpies.connect,
    close: sdkSpies.close,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

// Import after mocks are registered.
import { McpClientService } from "../services/mcp-client.service.js";

describe("McpClientService callTool — _meta plumbing", () => {
  let svc: McpClientService;

  beforeEach(async () => {
    sdkSpies.callTool.mockClear();
    svc = new McpClientService({ command: "node", args: ["fake-server.js"] });
    await svc.start();
  });

  it("passes _meta on the request when context is provided", async () => {
    await svc.callTool(
      "list_files",
      { path: "/" },
      { ncToken: "nct-abc" },
    );
    expect(sdkSpies.callTool).toHaveBeenCalledWith({
      name: "list_files",
      arguments: { path: "/" },
      _meta: { ncToken: "nct-abc" },
    });
  });

  it("omits _meta entirely when no context is provided", async () => {
    await svc.callTool("list_files", { path: "/" });
    // The SDK request must NOT carry a stray `_meta: undefined` (or
    // `{}`) — the spec reserves the field, and round-tripping an
    // empty object would be ambiguous.
    const callArgs = sdkSpies.callTool.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("_meta");
    expect(callArgs).toEqual({
      name: "list_files",
      arguments: { path: "/" },
    });
  });

  it("omits _meta when context is provided but empty", async () => {
    await svc.callTool("list_files", { path: "/" }, {});
    const callArgs = sdkSpies.callTool.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("_meta");
  });

  it("does NOT leak ncToken into tool arguments", async () => {
    await svc.callTool(
      "list_files",
      { path: "/photos" },
      { ncToken: "nct-xyz" },
    );
    const callArgs = sdkSpies.callTool.mock.calls[0][0] as {
      arguments: Record<string, unknown>;
    };
    // `arguments` must remain exactly what the agent passed — handlers
    // see only the model's tool args, not the user's session token.
    expect(callArgs.arguments).toEqual({ path: "/photos" });
    expect(callArgs.arguments).not.toHaveProperty("ncToken");
  });
});
