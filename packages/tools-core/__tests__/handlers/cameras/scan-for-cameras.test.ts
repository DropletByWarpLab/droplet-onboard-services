import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import scanForCameras from "../../../src/handlers/cameras/scan-for-cameras.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1462 regression: this tool used to dispatch to ctx.http.cameras
// (camera-discovery, :8085) whose /scan is gated behind a Bearer DEVICE_SECRET
// the cameras client never injects — every call 403'd at runtime. It now binds
// to the orchestrator's POST /api/cameras/scan (which forwards DEVICE_SECRET
// server-side), so the mocks below target ctx.http.orchestrator and the
// camera-discovery client must never be touched.
function ctxWith(
  orchestratorPost: Mock,
  camerasPost: Mock = vi.fn(),
): ToolContext {
  return {
    http: {
      cameras: { get: vi.fn(), post: camerasPost, patch: vi.fn(), delete: vi.fn() },
      orchestrator: { get: vi.fn(), post: orchestratorPost, patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("scan_for_cameras", () => {
  it("requiresWrite is true", () => {
    expect(scanForCameras.requiresWrite).toBe(true);
  });

  it("posts to POST /api/cameras/scan on the orchestrator", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "scan_complete", known: 0, pending: 0 }), {
        status: 200,
      }),
    );
    const r = await scanForCameras.handler({}, ctxWith(post));
    expect(post).toHaveBeenCalledWith("/api/cameras/scan", undefined);
    expect(r.ok).toBe(true);
  });

  it("passes the orchestrator's scan envelope through as data", async () => {
    const envelope = { status: "scan_complete", known: 3, pending: 1 };
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope), { status: 200 }),
    );
    const r = await scanForCameras.handler({}, ctxWith(post));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(envelope);
  });

  it("passes the scan_unavailable (service-down) envelope through", async () => {
    const envelope = { status: "scan_unavailable", message: "not running" };
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope), { status: 200 }),
    );
    const r = await scanForCameras.handler({}, ctxWith(post));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(envelope);
  });

  it("never calls the camera-discovery client (WARP-1462 regression)", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "scan_complete", known: 0, pending: 0 }), {
        status: 200,
      }),
    );
    const camerasPost = vi.fn();
    await scanForCameras.handler({}, ctxWith(post, camerasPost));
    expect(camerasPost).not.toHaveBeenCalled();
  });

  it("surfaces a non-2xx orchestrator response as SCAN_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 502 }));
    const r = await scanForCameras.handler({}, ctxWith(post));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("SCAN_FAILED");
  });
});
