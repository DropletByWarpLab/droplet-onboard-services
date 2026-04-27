import { describe, it, expect, vi } from "vitest";
import getWifiSettings from "../../../src/handlers/network/get-wifi-settings.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      routing: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

describe("get_wifi_settings", () => {
  it("read-only metadata", () => {
    expect(getWifiSettings.name).toBe("get_wifi_settings");
    expect(getWifiSettings.requiresWrite).toBe(false);
  });

  it("returns the routing /wifi body verbatim", async () => {
    const body = { ssid: "Droplet", channel: "6" };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await getWifiSettings.handler({}, ctxWithGet(get));
    expect(get).toHaveBeenCalledWith("/wifi", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(body);
  });

  it("error on 503", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const r = await getWifiSettings.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
  });
});
