import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listCameraEvents from "../../../src/handlers/cameras/list-camera-events.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1439 regression: this tool used to dispatch to ctx.http.cameras
// (camera-discovery, :8085), which never implemented any event routes —
// every call 404'd at runtime. It now binds to the orchestrator's real
// routes (GET /api/cameras/:name/events and GET /api/cameras/events/recent),
// so the mocks below target ctx.http.orchestrator and the camera-discovery
// client must never be touched.
function ctxWith(
  orchestratorGet: Mock,
  camerasGet: Mock = vi.fn(),
): ToolContext {
  return {
    http: {
      cameras: { get: camerasGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      orchestrator: { get: orchestratorGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

const okEvents = (events: unknown[] = []) =>
  new Response(JSON.stringify({ events }), { status: 200 });

describe("list_camera_events", () => {
  it("uses GET /api/cameras/events/recent without camera_name", async () => {
    const get = vi.fn().mockResolvedValue(okEvents());
    await listCameraEvents.handler({}, ctxWith(get));
    expect(get).toHaveBeenCalledWith("/api/cameras/events/recent?limit=20", expect.anything());
  });

  it("uses GET /api/cameras/<name>/events when camera_name is set", async () => {
    const get = vi.fn().mockResolvedValue(okEvents());
    await listCameraEvents.handler({ camera_name: "front", limit: 5 }, ctxWith(get));
    expect(get).toHaveBeenCalledWith("/api/cameras/front/events?limit=5", expect.anything());
  });

  it("clamps limit to 100", async () => {
    const get = vi.fn().mockResolvedValue(okEvents());
    await listCameraEvents.handler({ limit: 9999 }, ctxWith(get));
    expect(get).toHaveBeenCalledWith("/api/cameras/events/recent?limit=100", expect.anything());
  });

  it("never calls the camera-discovery client (WARP-1439 regression)", async () => {
    const get = vi.fn().mockResolvedValue(okEvents());
    const camerasGet = vi.fn();
    await listCameraEvents.handler({ camera_name: "front" }, ctxWith(get, camerasGet));
    expect(camerasGet).not.toHaveBeenCalled();
  });

  it("passes the orchestrator's { events } payload through", async () => {
    const events = [
      { id: "e1", camera: "front", label: "person", score: 0.9, startTime: 1, endTime: 2 },
    ];
    const get = vi.fn().mockResolvedValue(okEvents(events));
    const r = await listCameraEvents.handler({ camera_name: "front" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ events });
    }
  });

  it("surfaces a non-2xx orchestrator response as EVENTS_FAILED", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 502 }));
    const r = await listCameraEvents.handler({}, ctxWith(get));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("EVENTS_FAILED");
  });
});
