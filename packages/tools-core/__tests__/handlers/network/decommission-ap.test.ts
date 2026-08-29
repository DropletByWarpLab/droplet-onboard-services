import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import decommissionAp from "../../../src/handlers/network/decommission-ap.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(post: Mock): ToolContext {
  return {
    http: {
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
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

describe("decommission_ap (WARP-446)", () => {
  it("metadata declares write + confirmation (admin-tier; drops connected devices)", () => {
    expect(decommissionAp.name).toBe("decommission_ap");
    expect(decommissionAp.requiresWrite).toBe(true);
    expect(decommissionAp.requiresConfirmation).toBe(true);
  });

  it("returns INVALID_ARGS when mac is missing", async () => {
    const post = vi.fn();
    const r = await decommissionAp.handler({}, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it("posts to /api/aps/:mac/decommission", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ap: { mac: "B8:27:EB:00:00:01", status: "DECOMMISSIONED" } }), {
        status: 200,
      }),
    );
    const r = await decommissionAp.handler({ mac: "B8:27:EB:00:00:01" }, ctxWith(post));
    expect(post).toHaveBeenCalledWith(
      "/api/aps/B8%3A27%3AEB%3A00%3A00%3A01/decommission",
      undefined,
    );
    expect(r.ok).toBe(true);
  });

  it("surfaces 404 from orchestrator as a typed error", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "AP not found" }), { status: 404 }),
    );
    const r = await decommissionAp.handler({ mac: "B8:27:EB:00:00:99" }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DECOMMISSION_FAILED");
  });
});
