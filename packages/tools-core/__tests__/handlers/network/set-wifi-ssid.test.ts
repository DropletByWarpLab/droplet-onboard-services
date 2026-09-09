import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import setWifiSsid from "../../../src/handlers/network/set-wifi-ssid.js";
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

  it("returns confirmation_required without confirmed: true — no HTTP call", async () => {
    const post = vi.fn();
    const r = await setWifiSsid.handler({ ssid: "MyNet" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(post).not.toHaveBeenCalled();
  });

  it("passes through an orchestrator 202 as confirmation_required", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "needs confirmation" }), { status: 202 }),
    );
    const r = await setWifiSsid.handler({ ssid: "MyNet", confirmed: true }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });

  it("posts ssid to the orchestrator wifi route when confirmed", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await setWifiSsid.handler({ ssid: "MyNet", confirmed: true }, ctxWithPost(post));
    expect(post).toHaveBeenCalledWith("/api/network/wifi/ssid", { ssid: "MyNet" });
    expect(r.ok).toBe(true);
  });
});
