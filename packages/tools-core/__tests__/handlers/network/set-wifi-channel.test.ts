import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import setWifiChannel from "../../../src/handlers/network/set-wifi-channel.js";
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

describe("set_wifi_channel", () => {
  it("flags write+confirmation", () => {
    expect(setWifiChannel.requiresWrite).toBe(true);
    expect(setWifiChannel.requiresConfirmation).toBe(true);
  });

  it("rejects missing channel", async () => {
    const r = await setWifiChannel.handler({}, ctxWithPost(vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
  });

  it("returns confirmation_required without confirmed: true — no HTTP call", async () => {
    const post = vi.fn();
    const r = await setWifiChannel.handler({ channel: "6" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(post).not.toHaveBeenCalled();
  });

  it("posts channel to the orchestrator wifi route when confirmed", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await setWifiChannel.handler({ channel: "6", confirmed: true }, ctxWithPost(post));
    expect(post).toHaveBeenCalledWith("/api/network/wifi/channel", { channel: "6" });
    expect(r.ok).toBe(true);
  });
});
