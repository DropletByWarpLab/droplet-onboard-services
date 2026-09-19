import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import setupCameraPorts from "../../../src/handlers/switch/setup-camera-ports.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1462: dispatches through `ctx.http.orchestrator`
// (`POST /api/switch/setup/cameras`), never the bearer-less
// `ctx.http.switchSvc` the switch service 403s.
function ctxWithPost(post: Mock): ToolContext {
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

describe("setup_camera_ports", () => {
  it("flags write+confirmation", () => {
    expect(setupCameraPorts.requiresWrite).toBe(true);
    expect(setupCameraPorts.requiresConfirmation).toBe(true);
  });

  it("forwards a partial body to /api/switch/setup/cameras (WARP-1462)", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const ctx = ctxWithPost(post);
    await setupCameraPorts.handler(
      { vlan_id: 200, camera_ports: [1, 2] },
      ctx,
    );
    expect(post).toHaveBeenCalledWith("/api/switch/setup/cameras", { vlan_id: 200, camera_ports: [1, 2] });
    // WARP-1462: never call the switch service directly (the 403 seam).
    expect(ctx.http.switchSvc.post).not.toHaveBeenCalled();
  });

  it("returns confirmation_required on 202", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reason: "ok" }), { status: 202 }));
    const r = await setupCameraPorts.handler({}, ctxWithPost(post));
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });

  // WARP-1176 (PYNET-001): plan-only camera-VLAN setup must never read as
  // "the camera VLAN is configured" — that is the exact audit finding.
  it("annotates a plan-only (dry-run) response as not applied", async () => {
    const body = {
      status: "planned",
      vlan_id: 100,
      camera_ports: [1, 2],
      uplink_ports: [9, 10],
      message: "VLAN 100 planned (dry-run): ...",
      dry_run: true,
    };
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await setupCameraPorts.handler({ vlan_id: 100 }, ctxWithPost(post));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as Record<string, unknown>;
      expect(data.dry_run).toBe(true);
      expect(data.applied).toBe(false);
      expect(String(data.warning)).toContain("NOT applied to hardware");
    }
  });

  it("leaves an applied (live-write) response untouched", async () => {
    const body = {
      status: "ok",
      vlan_id: 100,
      camera_ports: [1, 2],
      uplink_ports: [9, 10],
      message: "VLAN 100 configured: ...",
      dry_run: false,
    };
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await setupCameraPorts.handler({ vlan_id: 100 }, ctxWithPost(post));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual(body);
      expect(r.data).not.toHaveProperty("warning");
    }
  });
});
