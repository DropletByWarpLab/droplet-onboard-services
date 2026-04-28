import { describe, it, expect, vi } from "vitest";
import listClips from "../../../src/handlers/cameras/list-clips.js";
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

describe("list_clips", () => {
  it("filters events to only those with has_clip=true", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "e1", camera: "front", label: "person", score: 0.9, has_clip: true, start_time: 1, end_time: 2 },
          { id: "e2", camera: "front", label: "noise", has_clip: false },
        ]),
        { status: 200 },
      ),
    );
    const r = await listClips.handler({ camera: "front" }, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { count: number; clips: Array<{ id: string }> };
      expect(data.count).toBe(1);
      expect(data.clips[0].id).toBe("e1");
    }
  });
});
