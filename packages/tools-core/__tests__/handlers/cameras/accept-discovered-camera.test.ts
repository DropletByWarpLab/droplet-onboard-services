import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import acceptDiscoveredCamera from "../../../src/handlers/cameras/accept-discovered-camera.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: Mock): ToolContext {
  return {
    // WARP-1847: the handler goes through the orchestrator now, not Prisma. A
    // live candidate's id is `mac:<MAC>` — there is no camera row to update, and
    // only camera-discovery holds the probed RTSP URL + does the stream verify.
    http: {
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      cameras: {} as ToolContext["http"]["cameras"],
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

describe("accept_discovered_camera", () => {
  it("requiresWrite is true", () => {
    expect(acceptDiscoveredCamera.requiresWrite).toBe(true);
  });

  it("rejects missing id", async () => {
    const post = vi.fn();
    const r = await acceptDiscoveredCamera.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts a live candidate by its mac: id", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "accepted" }), { status: 200 }));
    const r = await acceptDiscoveredCamera.handler(
      { id: "mac:E4:30:22:50:2A:FD" },
      ctxWithPost(post),
    );
    expect(post).toHaveBeenCalledWith(
      "/api/cameras/discovered/mac%3AE4%3A30%3A22%3A50%3A2A%3AFD/accept",
      undefined,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ status: "accepted" });
  });

  it("accepts a database candidate by uuid", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted", camera: "front_door" }), { status: 200 }),
    );
    const r = await acceptDiscoveredCamera.handler({ id: "c1" }, ctxWithPost(post));
    expect(post).toHaveBeenCalledWith("/api/cameras/discovered/c1/accept", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ status: "accepted", camera: "front_door" });
  });

  it("surfaces a failed stream verify as CAMERA_NEEDS_CREDENTIALS with the upstream prose", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Camera stream did not verify — the RTSP path or credentials are likely wrong." }),
        { status: 422 },
      ),
    );
    const r = await acceptDiscoveredCamera.handler({ id: "mac:AA:BB" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CAMERA_NEEDS_CREDENTIALS");
      expect(r.error.message).toMatch(/did not verify/);
    }
  });

  it("reports any other failure as ACCEPT_FAILED", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 502 }));
    const r = await acceptDiscoveredCamera.handler({ id: "mac:AA:BB" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ACCEPT_FAILED");
      expect(r.error.message).toMatch(/502/);
    }
  });
});
