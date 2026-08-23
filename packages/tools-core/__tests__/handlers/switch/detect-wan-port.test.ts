import { describe, it, expect, vi } from "vitest";
import detectWanPort from "../../../src/handlers/switch/detect-wan-port.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1462: dispatches through `ctx.http.orchestrator`
// (`POST /api/switch/wan/detect`), never the bearer-less `ctx.http.switchSvc`.
function ctxWithPost(post: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
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

describe("detect_wan_port", () => {
  it("requiresWrite is true", () => {
    expect(detectWanPort.requiresWrite).toBe(true);
  });

  it("posts to /api/switch/wan/detect through the orchestrator (WARP-1462)", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ port: 9 }), { status: 200 }));
    const ctx = ctxWithPost(post);
    const r = await detectWanPort.handler({}, ctx);
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledWith("/api/switch/wan/detect", undefined);
    // WARP-1462: never call the switch service directly (the 403 seam).
    expect(ctx.http.switchSvc.post).not.toHaveBeenCalled();
    expect(ctx.http.switchSvc.get).not.toHaveBeenCalled();
  });

  // WARP-2125: switch_wan_detect is Tier 1 in the orchestrator's safety tier
  // now (a pure read auto-executes — the allowed path is the direct 200 above),
  // but the handler KEEPS the confirmation passthrough as defensive handling:
  // if the operation ever gets confirm-gated again, the tool must surface
  // confirmation_required rather than mistake the envelope for detection data.
  it("returns confirmation_required when the orchestrator answers 202", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "WAN detection requires confirmation" }), { status: 202 }),
    );
    const r = await detectWanPort.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });
});
