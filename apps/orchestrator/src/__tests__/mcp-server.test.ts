import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Stub the cross-cutting modules llm-tools.ts pulls in so the test
// doesn't load the entire orchestrator graph just to dispatch one tool.
vi.mock("../services/openwrt.client.js", () => ({}));
vi.mock("../services/nextcloud.client.js", () => ({}));
vi.mock("../services/frigate.client.js", () => ({
  fetchEvents: vi.fn(),
}));
vi.mock("../services/health-monitor.service.js", () => ({}));
vi.mock("../config.js", () => ({
  config: { CAMERA_DISCOVERY_URL: "http://x" },
}));

import { handleMcpMessage } from "../services/mcp-server.js";
import { TOOL_REGISTRY } from "../services/llm-tools.js";
import { MCP_PROTOCOL_VERSION, RpcCode } from "../services/mcp-protocol.js";

const baseCtx = {
  prisma: {} as unknown as PrismaClient,
  userId: "alice",
  ncToken: undefined,
  allowedTools: new Set(Object.keys(TOOL_REGISTRY)),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("initialize", () => {
  it("returns the server's capabilities + protocol version", async () => {
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } },
      baseCtx,
    )) as any;
    expect(r.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe("droplet-orchestrator");
  });
});

describe("tools/list", () => {
  it("returns every tool in TOOL_REGISTRY when allowed", async () => {
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      baseCtx,
    )) as any;
    expect(r.result.tools.length).toBe(Object.keys(TOOL_REGISTRY).length);
    // Spot-check a tool that we know exists in the base registry.
    expect(r.result.tools.find((t: any) => t.name === "list_network_devices")).toBeDefined();
  });

  it("hides tools the caller can't invoke (mirrors WRITE_TOOLS gate)", async () => {
    const restricted = {
      ...baseCtx,
      // Only allow read-only ones (simulate unprivileged user).
      allowedTools: new Set(
        Object.keys(TOOL_REGISTRY).filter((n) => !n.startsWith("block_") && !n.startsWith("unblock_") && n !== "scan_for_cameras" && n !== "accept_discovered_camera"),
      ),
    };
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      restricted,
    )) as any;
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).not.toContain("block_device");
    expect(names).not.toContain("unblock_device");
    expect(names).not.toContain("scan_for_cameras");
    // Read-only tools still present
    expect(names).toContain("list_network_devices");
  });
});

describe("tools/call", () => {
  it("invalid params returns INVALID_PARAMS", async () => {
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: null },
      baseCtx,
    )) as any;
    expect(r.error.code).toBe(RpcCode.INVALID_PARAMS);

    const r2 = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "" } },
      baseCtx,
    )) as any;
    expect(r2.error.code).toBe(RpcCode.INVALID_PARAMS);
  });

  it("disallowed tool returns TOOL_NOT_FOUND (doesn't leak existence)", async () => {
    const restricted = {
      ...baseCtx,
      allowedTools: new Set<string>(),
    };
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "block_device", arguments: { mac: "x" } } },
      restricted,
    )) as any;
    expect(r.error.code).toBe(RpcCode.TOOL_NOT_FOUND);
    // Same response for a truly nonexistent tool — caller can't tell them apart.
    const r2 = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "totally_made_up_tool" } },
      restricted,
    )) as any;
    expect(r2.error.code).toBe(RpcCode.TOOL_NOT_FOUND);
  });

  it("nonexistent allowed tool returns TOOL_NOT_FOUND", async () => {
    const ctx = { ...baseCtx, allowedTools: new Set(["totally_made_up_tool"]) };
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "totally_made_up_tool" } },
      ctx,
    )) as any;
    expect(r.error.code).toBe(RpcCode.TOOL_NOT_FOUND);
  });
});

describe("ping", () => {
  it("returns an empty result", async () => {
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 9, method: "ping" },
      baseCtx,
    )) as any;
    expect(r.result).toEqual({});
  });
});

describe("unknown methods", () => {
  it("returns METHOD_NOT_FOUND", async () => {
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 10, method: "resources/list" },
      baseCtx,
    )) as any;
    expect(r.error.code).toBe(RpcCode.METHOD_NOT_FOUND);
  });
});
