import { describe, it, expect, vi } from "vitest";
import exportClip from "../../../src/handlers/cameras/export-clip.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(post: ReturnType<typeof vi.fn>, opts: { ncToken?: string; userId?: string } = {}): ToolContext {
  return {
    http: {
      cameras: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
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
}

describe("export_clip", () => {
  it("requires auth", async () => {
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00Z", ends_at: "2026-01-01T00:05Z" },
      ctxWith(vi.fn(), { ncToken: "" }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects invalid timestamps", async () => {
    const r = await exportClip.handler(
      { camera: "front", starts_at: "not a date", ends_at: "2026-01-01T00:05Z" },
      ctxWith(vi.fn()),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects ends_at that is not strictly after starts_at without calling the cameras service", async () => {
    const post = vi.fn();
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:05:00Z", ends_at: "2026-01-01T00:05:00Z" },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(r.error?.message).toBe("ends_at_must_be_after_starts_at");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an export window longer than 30 minutes without calling the cameras service", async () => {
    const post = vi.fn();
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:30:01Z" },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(r.error?.message).toBe("export_window_exceeds_30_minutes");
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts an export window of exactly 30 minutes", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ nc_path: "/Clips/front/x.mp4" }), { status: 200 }),
    );
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:30:00Z" },
      ctxWith(post),
    );
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("posts the export request and returns the response body", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ nc_path: "/Clips/front/x.mp4" }), { status: 200 }),
    );
    const r = await exportClip.handler(
      { camera: "front", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:05:00Z" },
      ctxWith(post),
    );
    expect(r.ok).toBe(true);
    expect(post.mock.calls[0][0]).toBe("/clips/export");
  });
});
