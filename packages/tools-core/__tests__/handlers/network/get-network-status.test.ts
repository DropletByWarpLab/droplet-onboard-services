import { describe, it, expect, vi } from "vitest";
import getNetworkStatus from "../../../src/handlers/network/get-network-status.js";
import type { ToolContext } from "../../../src/types.js";

describe("get_network_status", () => {
  it("calls the orchestrator /api/network/status and returns body", async () => {
    const fakeBody = { wan: { up: true, ip: "1.2.3.4" }, lan: { clients: 7 } };
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeBody), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const ctx: ToolContext = {
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
    const r = await getNetworkStatus.handler({}, ctx);
    expect(get).toHaveBeenCalledWith("/api/network/status", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(fakeBody);
  });
});
