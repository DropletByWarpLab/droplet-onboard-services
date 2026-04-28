import { describe, it, expect, vi } from "vitest";
import detectWanPort from "../../../src/handlers/switch/detect-wan-port.js";
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

describe("detect_wan_port", () => {
  it("requiresWrite is true", () => {
    expect(detectWanPort.requiresWrite).toBe(true);
  });

  it("posts to /wan/detect", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ port: 9 }), { status: 200 }));
    const r = await detectWanPort.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledWith("/wan/detect", undefined);
  });
});
