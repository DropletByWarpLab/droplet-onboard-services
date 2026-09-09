import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getRouterSystemInfo from "../../../src/handlers/network/get-router-system-info.js";
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

describe("get_router_system_info", () => {
  it("returns the orchestrator /api/network/system body", async () => {
    const body = { hostname: "droplet", version: "23.05", uptime: 12345 };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await getRouterSystemInfo.handler({}, ctxWithGet(get));
    expect(get).toHaveBeenCalledWith("/api/network/system", expect.anything());
    expect(r.ok).toBe(true);
  });
});
