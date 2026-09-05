import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import blockNetworkDevice from "../../../src/handlers/network/block-network-device.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("block_network_device", () => {
  it("metadata flags are set for write+confirmation", () => {
    expect(blockNetworkDevice.requiresWrite).toBe(true);
    expect(blockNetworkDevice.requiresConfirmation).toBe(true);
  });

  it("returns confirmation_required when orchestrator returns 202", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "block requires confirmation" }), { status: 202 }),
    );
    const r = await blockNetworkDevice.handler({ mac: "AA:BB:CC:DD:EE:FF" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.message).toContain("confirmation");
    }
    expect(post).toHaveBeenCalledWith("/api/network/firewall/block", { mac: "AA:BB:CC:DD:EE:FF" });
  });

  it("returns ok when orchestrator returns 200", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "blocked" }), { status: 200 }),
    );
    const r = await blockNetworkDevice.handler({ mac: "AA:BB:CC:DD:EE:FF" }, ctxWithPost(post));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ status: "blocked" });
  });

  it("rejects missing mac", async () => {
    const r = await blockNetworkDevice.handler({}, ctxWithPost(vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
  });
});
