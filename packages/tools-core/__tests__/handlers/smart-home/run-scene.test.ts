import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import runScene from "../../../src/handlers/smart-home/run-scene.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  post: Mock,
  get?: Mock,
): ToolContext {
  return {
    http: {
      orchestrator: {
        get: get ?? vi.fn(),
        post,
        patch: vi.fn(),
        delete: vi.fn(),
      },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

const SCENE_UUID = "11111111-2222-3333-4444-555555555555";

describe("run_scene", () => {
  it("flags write+confirmation", () => {
    expect(runScene.requiresWrite).toBe(true);
    expect(runScene.requiresConfirmation).toBe(true);
  });

  it("rejects an empty scene argument", async () => {
    const post = vi.fn();
    const r = await runScene.handler({ scene: "  " }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  // TOOLS-01: the handler must NOT pre-satisfy the orchestrator's
  // confirmation gate. The POST URL must never carry `?confirm=true`.
  it("does NOT auto-confirm: POST URL omits ?confirm=true", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ sceneId: SCENE_UUID, successCount: 1, actionCount: 1, results: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await runScene.handler({ scene: SCENE_UUID }, ctxWith(post));
    expect(post).toHaveBeenCalledTimes(1);
    const calledPath = post.mock.calls[0][0] as string;
    expect(calledPath).toBe(`/api/scenes/${SCENE_UUID}/run`);
    expect(calledPath).not.toContain("confirm");
  });

  // WARP-640: a 202 confirmation_required from the route is relayed as a
  // confirmation_required ToolResult that FORWARDS the single-use token (in
  // error.details), so the dashboard chip can render "Approve & run" — not a
  // hard SCENE_RUN_FAILED.
  it("relays the route's 202 confirmation_required and forwards the token", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "confirmation_required",
          confirmationToken: "tok-abc123",
          sceneId: SCENE_UUID,
          message:
            'Running "Movie night" will run 2 device action(s). Approve to run it.',
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await runScene.handler({ scene: SCENE_UUID }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(r.error.details).toMatchObject({
        type: "scene_run",
        sceneId: SCENE_UUID,
        confirmationToken: "tok-abc123",
      });
    }
    // Still never pre-satisfies the gate.
    expect(post.mock.calls[0][0]).toBe(`/api/scenes/${SCENE_UUID}/run`);
  });

  it("resolves a scene by name via GET /api/scenes before running it", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ scenes: [{ id: SCENE_UUID, name: "Movie night", icon: null, actionCount: 2 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ sceneId: SCENE_UUID, successCount: 2, actionCount: 2, results: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await runScene.handler({ scene: "movie night" }, ctxWith(post, get));
    expect(get).toHaveBeenCalledWith("/api/scenes", expect.anything());
    expect(post.mock.calls[0][0]).toBe(`/api/scenes/${SCENE_UUID}/run`);
    expect(r.ok).toBe(true);
  });

  it("returns SCENE_NOT_FOUND when a name does not resolve", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ scenes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const post = vi.fn();
    const r = await runScene.handler({ scene: "no such scene" }, ctxWith(post, get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCENE_NOT_FOUND");
    expect(post).not.toHaveBeenCalled();
  });

  it("surfaces SCENE_PARTIAL_FAILURE when some actions fail", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sceneId: SCENE_UUID,
          successCount: 1,
          actionCount: 2,
          results: [
            { idx: 0, deviceNodeId: "a", command: "turn_on", ok: true },
            { idx: 1, deviceNodeId: "b", command: "lock", ok: false, error: "offline" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await runScene.handler({ scene: SCENE_UUID }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("error");
      expect(r.error.code).toBe("SCENE_PARTIAL_FAILURE");
    }
  });

  it("returns SCENE_RUN_FAILED on a non-confirmation error status", async () => {
    const post = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const r = await runScene.handler({ scene: SCENE_UUID }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCENE_RUN_FAILED");
  });
});
