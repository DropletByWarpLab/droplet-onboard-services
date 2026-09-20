import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import shareClip from "../../../src/handlers/cameras/share-clip.js";
import type { ToolContext } from "../../../src/types.js";

/**
 * share_clip mints a public "anyone with the link" signed URL to private
 * camera footage. It MUST NOT reach the signing path in a single unattended
 * tool call — the orchestrator's safety-tier evaluator answers 202
 * `confirmation_required`, which the handler surfaces so the agent renders an
 * approval chip instead of silently sharing footage.
 *
 * The handler routes through `ctx.http.orchestrator` (not `ctx.http.cameras`):
 * the real /api/cameras/clips/share endpoint, and the only path that runs the
 * confirmation gate, lives on the orchestrator. The cameras (camera-discovery)
 * service has no share endpoint at all.
 */
function ctxWith(
  orchestratorPost: Mock,
  userId?: string,
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
    userId,
    signal: new AbortController().signal,
  };
  return { ctx, camerasPost };
}

describe("share_clip", () => {
  it("requires auth", async () => {
    const { ctx } = ctxWith(vi.fn(), undefined);
    const r = await shareClip.handler({ nc_path: "/x.mp4" }, ctx);
    expect(r.ok).toBe(false);
  });

  it("is declared as requiring confirmation", () => {
    expect(shareClip.requiresConfirmation).toBe(true);
  });

  it("posts to the orchestrator share endpoint, NOT the cameras service", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "/api/cameras/clips/share/x.mp4?t=tok" }), {
        status: 200,
      }),
    );
    const { ctx, camerasPost } = ctxWith(post, "alice");
    await shareClip.handler({ nc_path: "/x.mp4", ttl_minutes: 9999 }, ctx);
    expect(camerasPost).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      "/api/cameras/clips/share",
      { nc_path: "/x.mp4", ttl_minutes: 1440 },
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Nextcloud-User": "alice" }),
      }),
    );
  });

  it("clamps ttl_minutes to [1, 1440]", async () => {
    // Fresh Response per call — a Response body can only be read once.
    const post = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ url: "/u" }), { status: 200 }));
    const { ctx } = ctxWith(post, "alice");
    await shareClip.handler({ nc_path: "/x.mp4", ttl_minutes: 9999 }, ctx);
    expect(post).toHaveBeenCalledWith(
      "/api/cameras/clips/share",
      expect.objectContaining({ ttl_minutes: 1440 }),
      expect.anything(),
    );
    post.mockClear();
    await shareClip.handler({ nc_path: "/x.mp4", ttl_minutes: -5 }, ctx);
    expect(post).toHaveBeenCalledWith(
      "/api/cameras/clips/share",
      expect.objectContaining({ ttl_minutes: 1 }),
      expect.anything(),
    );
  });

  it("surfaces confirmation_required (202) WITHOUT a usable URL — the agent cannot share in one call", async () => {
    // The orchestrator's safety-tier evaluator returns 202 on the first
    // (unconfirmed) call. The handler must translate this into a
    // confirmation_required tool result, never an ok result with a URL.
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "confirmation_required",
          operation: "share_clip",
          reason: "Sharing a clip creates a public link to private footage.",
          confirmationToken: "abc123",
        }),
        { status: 202 },
      ),
    );
    const { ctx } = ctxWith(post, "alice");
    const r = await shareClip.handler({ nc_path: "/Clips/front/x.mp4" }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.status).toBe("confirmation_required");
    // No signed URL anywhere in the result.
    expect(JSON.stringify(r)).not.toContain("/api/cameras/clips/share/");
  });

  it("returns the signed URL once the orchestrator answers 200 (post-confirmation)", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "/api/cameras/clips/share/x.mp4?t=tok",
          expires_at: "2026-04-23T11:00:00.000Z",
        }),
        { status: 200 },
      ),
    );
    const { ctx } = ctxWith(post, "alice");
    const r = await shareClip.handler({ nc_path: "/Clips/front/x.mp4" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { url: string }).url).toContain("/api/cameras/clips/share/");
    }
  });

  it("maps a non-2xx, non-202 orchestrator error to a tool error", async () => {
    const post = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const { ctx } = ctxWith(post, "alice");
    const r = await shareClip.handler({ nc_path: "/x.mp4" }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.status).toBe("error");
  });
});
