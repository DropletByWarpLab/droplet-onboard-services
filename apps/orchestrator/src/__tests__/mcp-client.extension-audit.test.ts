/**
 * WARP-2900 (ADR-056 slice H3) — the stdio dispatch's `tool_call` row names
 * the extension that made the call.
 *
 * An extension calls back into the box through POST /api/extensions/self/call,
 * which dispatches a static read tool as the installing owner with
 * `context.extensionId`. The one existing per-dispatch audit site
 * (McpClientService.callTool) spreads `extensionAuditRefs(name, context)`
 * into its refs. MUTATION: drop that line → red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const spies = vi.hoisted(() => ({
  callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "{}" }], isError: false }),
  record: vi.fn(async (_p: unknown) => null),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    callTool: spies.callTool,
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: spies.record }));

import { McpClientService } from "../services/mcp-client.service.js";

const toolCallRows = () =>
  spies.record.mock.calls
    .map((c) => c[0] as { kind: string; refs: Record<string, unknown> })
    .filter((r) => r.kind === "tool_call");

describe("the stdio dispatch's audit row", () => {
  let svc: McpClientService;
  beforeEach(async () => {
    spies.record.mockClear();
    svc = new McpClientService({ command: "node", args: ["fake-server.js"] });
    await svc.start();
  });

  it("carries refs.extensionId when an extension made the call as its owner", async () => {
    await svc.callTool("get_weather", {}, { userId: "owner", extensionId: "wc" });
    expect(toolCallRows()[0].refs).toMatchObject({ name: "get_weather", userId: "owner", extensionId: "wc", ok: true });
  });

  it("carries none for an ordinary call", async () => {
    await svc.callTool("get_weather", {}, { userId: "owner" });
    expect(toolCallRows()[0].refs).not.toHaveProperty("extensionId");
  });
});
