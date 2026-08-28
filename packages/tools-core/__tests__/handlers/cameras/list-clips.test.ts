import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listClips from "../../../src/handlers/cameras/list-clips.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1439 regression: this tool used to dispatch to ctx.http.cameras
// (camera-discovery, :8085), which never implemented any event/clip routes —
// every call 404'd at runtime. It now binds to the orchestrator's real
// GET /api/cameras/clips route, which performs the has_clip filtering
// server-side and returns the same per-clip shape this handler previously
// assembled locally. Mocks target ctx.http.orchestrator; the camera-discovery
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

const CLIP = {
  id: "e1",
  camera: "front",
  label: "person",
  score: 0.9,
  start_time: 1,
  end_time: 2,
  thumbnail_url: "/api/cameras/events/e1/thumbnail",
  clip_url: "/api/cameras/clips/event/e1",
};

describe("list_clips", () => {
  it("queries GET /api/cameras/clips with the camera filter and returns count + clips", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ clips: [CLIP] }), { status: 200 }),
    );
    const r = await listClips.handler({ camera: "front" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      "/api/cameras/clips?limit=30&camera=front",
      expect.anything(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { count: number; clips: Array<{ id: string }> };
      expect(data.count).toBe(1);
      expect(data.clips[0]).toEqual(CLIP);
    }
  });

  it("omits the camera param when not supplied and clamps limit to 200", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ clips: [] }), { status: 200 }),
    );
    await listClips.handler({ limit: 9999 }, ctxWith(get));
    expect(get).toHaveBeenCalledWith("/api/cameras/clips?limit=200", expect.anything());
  });

  it("never calls the camera-discovery client (WARP-1439 regression)", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ clips: [] }), { status: 200 }),
    );
    const camerasGet = vi.fn();
    await listClips.handler({ camera: "front" }, ctxWith(get, camerasGet));
    expect(camerasGet).not.toHaveBeenCalled();
  });

  it("returns count 0 when the orchestrator body has no clips array", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await listClips.handler({}, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ count: 0, clips: [] });
    }
  });

  it("surfaces a non-2xx orchestrator response as CLIPS_FAILED", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 502 }));
    const r = await listClips.handler({}, ctxWith(get));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("CLIPS_FAILED");
  });
});
