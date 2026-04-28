import { describe, it, expect, vi } from "vitest";
import setWifiSsid from "../../../src/handlers/network/set-wifi-ssid.js";
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

describe("set_wifi_ssid", () => {
  it("flags write+confirmation", () => {
    expect(setWifiSsid.requiresWrite).toBe(true);
    expect(setWifiSsid.requiresConfirmation).toBe(true);
  });

  it("rejects invalid ssid length", async () => {
    const r = await setWifiSsid.handler({ ssid: "" }, ctxWithPost(vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
  });

  it("returns confirmation_required on 202", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "needs confirmation" }), { status: 202 }),
    );
    const r = await setWifiSsid.handler({ ssid: "MyNet" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });

  it("posts ssid on success", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await setWifiSsid.handler({ ssid: "MyNet" }, ctxWithPost(post));
    expect(post).toHaveBeenCalledWith("/wifi/ssid", { ssid: "MyNet" });
    expect(r.ok).toBe(true);
  });
});
