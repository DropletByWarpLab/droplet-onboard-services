import { describe, it, expect, vi } from "vitest";
import setupCameraPorts from "../../../src/handlers/switch/setup-camera-ports.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      switchSvc: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
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

describe("setup_camera_ports", () => {
  it("flags write+confirmation", () => {
    expect(setupCameraPorts.requiresWrite).toBe(true);
    expect(setupCameraPorts.requiresConfirmation).toBe(true);
  });

  it("forwards a partial body", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await setupCameraPorts.handler(
      { vlan_id: 200, camera_ports: [1, 2] },
      ctxWithPost(post),
    );
    expect(post).toHaveBeenCalledWith("/setup/cameras", { vlan_id: 200, camera_ports: [1, 2] });
  });

  it("returns confirmation_required on 202", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reason: "ok" }), { status: 202 }));
    const r = await setupCameraPorts.handler({}, ctxWithPost(post));
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });
});
