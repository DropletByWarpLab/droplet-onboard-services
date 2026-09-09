import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import scanWifiNetworks from "../../../src/handlers/network/scan-wifi-networks.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("scan_wifi_networks", () => {
  it("returns the orchestrator /api/network/wifi/scan body", async () => {
    const body = { networks: [{ ssid: "Foo", signal: -42 }] };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await scanWifiNetworks.handler({}, ctxWithGet(get));
    expect(get).toHaveBeenCalledWith("/api/network/wifi/scan", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(body);
  });
});
