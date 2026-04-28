import { describe, it, expect, vi } from "vitest";
import listCameraEvents from "../../../src/handlers/cameras/list-camera-events.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      cameras: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

describe("list_camera_events", () => {
  it("uses /events/recent without camera_name", async () => {
    const get = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    await listCameraEvents.handler({}, ctxWithGet(get));
    expect(get).toHaveBeenCalledWith("/events/recent?limit=20", expect.anything());
  });

  it("uses /cameras/<name>/events when camera_name is set", async () => {
    const get = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    await listCameraEvents.handler({ camera_name: "front", limit: 5 }, ctxWithGet(get));
    expect(get).toHaveBeenCalledWith("/cameras/front/events?limit=5", expect.anything());
  });

  it("clamps limit to 100", async () => {
    const get = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    await listCameraEvents.handler({ limit: 9999 }, ctxWithGet(get));
    expect(get).toHaveBeenCalledWith("/events/recent?limit=100", expect.anything());
  });
});
