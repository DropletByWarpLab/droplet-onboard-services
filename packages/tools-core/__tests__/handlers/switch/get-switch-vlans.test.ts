import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getSwitchVlans from "../../../src/handlers/switch/get-switch-vlans.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1462: dispatches through `ctx.http.orchestrator` (`/api/switch/vlans`),
// never the bearer-less `ctx.http.switchSvc` the switch service 403s.
function ctxWithGet(get: Mock): ToolContext {
  return {
    http: {
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      switchSvc: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("get_switch_vlans", () => {
  it("hits /api/switch/vlans through the orchestrator (WARP-1462)", async () => {
    const get = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const ctx = ctxWithGet(get);
    const r = await getSwitchVlans.handler({}, ctx);
    expect(r.ok).toBe(true);
    expect(get).toHaveBeenCalledWith("/api/switch/vlans", expect.anything());
    expect(ctx.http.switchSvc.get).not.toHaveBeenCalled();
    expect(ctx.http.switchSvc.post).not.toHaveBeenCalled();
  });
});
