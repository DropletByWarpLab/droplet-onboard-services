import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import unblockNetworkDevice from "../../../src/handlers/network/unblock-network-device.js";
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

describe("unblock_network_device", () => {
  it("flags write+confirmation", () => {
    expect(unblockNetworkDevice.requiresWrite).toBe(true);
    expect(unblockNetworkDevice.requiresConfirmation).toBe(true);
  });

  it("rejects missing mac", async () => {
    const r = await unblockNetworkDevice.handler({}, ctxWithPost(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("returns confirmation_required on 202", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reason: "needs ok" }), { status: 202 }));
    const r = await unblockNetworkDevice.handler({ mac: "AA:BB" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(post).toHaveBeenCalledWith("/api/network/firewall/unblock", { mac: "AA:BB" });
  });

  it("ok on 200", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "unblocked" }), { status: 200 }));
    const r = await unblockNetworkDevice.handler({ mac: "AA:BB" }, ctxWithPost(post));
    expect(r.ok).toBe(true);
  });
});
