import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getSwitchPorts from "../../../src/handlers/switch/get-switch-ports.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1462: the tool now dispatches through `ctx.http.orchestrator`
// (`/api/switch/ports`, service bearer auto-injected), never the bearer-less
// `ctx.http.switchSvc` that the switch service 403s. `switchSvc` is kept as a
// spy so the regression assertion below proves it is never touched.
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

describe("get_switch_ports", () => {
  it("reads through the orchestrator /api/switch/ports proxy (WARP-1462)", async () => {
    const get = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const ctx = ctxWithGet(get);
    const r = await getSwitchPorts.handler({}, ctx);
    expect(r.ok).toBe(true);
    expect(get).toHaveBeenCalledWith("/api/switch/ports", expect.anything());
    // WARP-1462: the switch service is never called directly (the 403 seam).
    expect(ctx.http.switchSvc.get).not.toHaveBeenCalled();
    expect(ctx.http.switchSvc.post).not.toHaveBeenCalled();
  });

  it("errors when the orchestrator is unavailable", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const r = await getSwitchPorts.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
  });
});
