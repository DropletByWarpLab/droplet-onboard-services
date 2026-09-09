import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import exportClip from "../../../src/handlers/cameras/export-clip.js";
import type { ToolContext } from "../../../src/types.js";

/**
 * WARP-1439 — export_clip must call the ORCHESTRATOR's
 * POST /api/cameras/:name/clips/export (camera in the path, body
 * {starts_at, ends_at}, NC credential in X-Nextcloud-Token/-User headers).
 * The handler previously posted to `ctx.http.cameras` `/clips/export`, a
 * camera-discovery route that does not exist — every export 404'd.
 */
function ctxWith(
  orchestratorPost: Mock,
  opts: { ncToken?: string; userId?: string } = {},
): { ctx: ToolContext; camerasPost: Mock } {
  const camerasPost = vi.fn();
  const ctx: ToolContext = {
    http: {
      cameras: { get: vi.fn(), post: camerasPost, patch: vi.fn(), delete: vi.fn() },
      orchestrator: {
        get: vi.fn(),
        post: orchestratorPost,
        patch: vi.fn(),
        delete: vi.fn(),
      },
      routing: {} as ToolContext["http"]["routing"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: opts.userId ?? "alice",
    ncToken: opts.ncToken ?? "tok",
    signal: new AbortController().signal,
  };
  return { ctx, camerasPost };
}

describe("export_clip", () => {
  it("requires auth", async () => {
    const { ctx } = ctxWith(vi.fn(), { ncToken: "" });
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00Z", ends_at: "2026-01-01T00:05Z" },
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects invalid timestamps", async () => {
    const { ctx } = ctxWith(vi.fn());
    const r = await exportClip.handler(
      { camera: "front", starts_at: "not a date", ends_at: "2026-01-01T00:05Z" },
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects ends_at that is not strictly after starts_at without any HTTP call", async () => {
    const post = vi.fn();
    const { ctx, camerasPost } = ctxWith(post);
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:05:00Z", ends_at: "2026-01-01T00:05:00Z" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(r.error?.message).toBe("ends_at_must_be_after_starts_at");
    expect(post).not.toHaveBeenCalled();
    expect(camerasPost).not.toHaveBeenCalled();
  });

  it("rejects an export window longer than 30 minutes without any HTTP call", async () => {
    const post = vi.fn();
    const { ctx, camerasPost } = ctxWith(post);
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:30:01Z" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(r.error?.message).toBe("export_window_exceeds_30_minutes");
    expect(post).not.toHaveBeenCalled();
    expect(camerasPost).not.toHaveBeenCalled();
  });

  it("accepts an export window of exactly 30 minutes", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ncPath: "/Clips/front/x.mp4", bytes: 1024, durationSec: 1800 }),
        { status: 201 },
      ),
    );
    const { ctx } = ctxWith(post);
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:30:00Z" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("posts to the orchestrator export route with the exact path, body, and NC headers", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ncPath: "/Clips/front/x.mp4", bytes: 2048, durationSec: 300 }),
        { status: 201 },
      ),
    );
    const { ctx } = ctxWith(post, { userId: "alice", ncToken: "nc-app-pass" });
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:05:00Z" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ ncPath: "/Clips/front/x.mp4", bytes: 2048, durationSec: 300 });
    }
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/api/cameras/front/clips/export",
      {
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: "2026-01-01T00:05:00.000Z",
      },
      {
        headers: {
          "X-Nextcloud-Token": "nc-app-pass",
          "X-Nextcloud-User": "alice",
        },
      },
    );
  });

  it("surfaces an orchestrator error status as EXPORT_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "nextcloud_session_missing" }), { status: 401 }),
    );
    const { ctx } = ctxWith(post);
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:05:00Z" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("EXPORT_FAILED");
    expect(r.error?.message).toBe("orchestrator returned 401");
  });

  it("WARP-1439 regression: never calls the cameras (camera-discovery) service", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ncPath: "/Clips/front/x.mp4", bytes: 1, durationSec: 300 }),
        { status: 201 },
      ),
    );
    const { ctx, camerasPost } = ctxWith(post);
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:05:00Z" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(camerasPost).not.toHaveBeenCalled();
    expect(ctx.http.cameras.get).not.toHaveBeenCalled();
    expect(ctx.http.cameras.patch).not.toHaveBeenCalled();
    expect(ctx.http.cameras.delete).not.toHaveBeenCalled();
  });
});
