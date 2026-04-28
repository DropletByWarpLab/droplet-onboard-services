import { describe, it, expect, vi } from "vitest";
import setWifiChannel from "../../../src/handlers/network/set-wifi-channel.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      routing: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
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

  it("returns confirmation_required on 202", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "needs confirmation" }), { status: 202 }),
    );
    const r = await setWifiChannel.handler({ channel: "6" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(post).toHaveBeenCalledWith("/wifi/channel", { channel: "6" });
  });
});
