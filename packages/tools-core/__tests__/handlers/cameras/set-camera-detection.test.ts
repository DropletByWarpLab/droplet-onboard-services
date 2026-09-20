/**
 * WARP-1440 — `set_camera_detection` (Tier 2: write + handler-enforced
 * two-step confirmation).
 *
 * The first (unconfirmed) call must return `confirmation_required`
 * WITHOUT any HTTP traffic — the echo names the camera and the effect so
 * the model can relay it verbatim. Only `confirmed: true` reaches the
 * orchestrator, and the disable path must complete the route's own
 * Tier-2 token handshake (202 → POST /api/cameras/command/confirm with
 * the operation echo) exactly like the dashboard's `disableCamera()`.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import setCameraDetection from "../../../src/handlers/cameras/set-camera-detection.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(orchestratorPost: Mock): ToolContext {
  return {
    http: {
      cameras: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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
    userId: "alice",
    signal: new AbortController().signal,
  } as ToolContext;
}

describe("set_camera_detection — tool metadata", () => {
  it("is named set_camera_detection and is Tier-2 (write + confirm)", () => {
    expect(setCameraDetection.name).toBe("set_camera_detection");
    expect(setCameraDetection.requiresWrite).toBe(true);
    expect(setCameraDetection.requiresConfirmation).toBe(true);
  });

  it("has an additionalProperties:false input schema requiring camera + enabled", () => {
    const schema = setCameraDetection.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["camera", "enabled"]);
  });
});

describe("set_camera_detection — argument validation (no HTTP)", () => {
  it("rejects a missing camera", async () => {
    const post = vi.fn();
    const res = await setCameraDetection.handler({ enabled: false }, ctxWith(post));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("INVALID_ARGS");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an invalid camera name (regex parity with the route)", async () => {
    const post = vi.fn();
    const res = await setCameraDetection.handler(
      { camera: "front door/../etc", enabled: false },
      ctxWith(post),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a missing/non-boolean enabled", async () => {
    const post = vi.fn();
    const res = await setCameraDetection.handler({ camera: "front_door" }, ctxWith(post));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    const res2 = await setCameraDetection.handler(
      { camera: "front_door", enabled: "yes" },
      ctxWith(post),
    );
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("set_camera_detection — handler-enforced confirmation", () => {
  it("disable: first call returns confirmation_required naming the camera and effect, NO HTTP", async () => {
    const post = vi.fn();
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: false },
      ctxWith(post),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("confirmation_required");
      expect(res.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(res.error.message).toContain("front_door");
      expect(res.error.message).toContain("stops detection and recording");
      expect(res.error.message).toContain("until re-enabled");
      expect(res.error.details).toMatchObject({
        type: "set_camera_detection",
        camera: "front_door",
        enabled: false,
      });
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("enable: first call returns confirmation_required with the re-enable echo, NO HTTP", async () => {
    const post = vi.fn();
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: true },
      ctxWith(post),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("confirmation_required");
      expect(res.error.message).toContain("front_door");
      expect(res.error.message).toContain("re-enables detection and recording");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("confirmed: false is treated as unconfirmed", async () => {
    const post = vi.fn();
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: false, confirmed: false },
      ctxWith(post),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe("confirmation_required");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("set_camera_detection — confirmed execution", () => {
  it("enable: POSTs the enable route and returns the success shape", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "enabled", camera: "front_door" }), { status: 200 }),
    );
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: true, confirmed: true },
      ctxWith(post),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/cameras/front_door/enable");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "set_camera_detection",
        camera: "front_door",
        enabled: true,
      });
    }
  });

  it("disable: completes the Tier-2 handshake — 202 token echoed to /cameras/command/confirm with the operation name", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "confirmation_required",
            confirmationToken: "tok123",
            tier: 2,
            expiresIn: 60,
          }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "ok", operation: "disable_camera", confirmed: true }),
          { status: 200 },
        ),
      );
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: false, confirmed: true },
      ctxWith(post),
    );
    expect(post).toHaveBeenNthCalledWith(1, "/api/cameras/front_door/disable");
    expect(post).toHaveBeenNthCalledWith(2, "/api/cameras/command/confirm", {
      confirmationToken: "tok123",
      operation: "disable_camera",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "set_camera_detection",
        camera: "front_door",
        enabled: false,
      });
    }
  });

  it("disable: inline 200 (no Tier-2 gate) succeeds without a confirm hop", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "disabled", camera: "front_door" }), { status: 200 }),
    );
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: false, confirmed: true },
      ctxWith(post),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });
});

describe("set_camera_detection — error mapping", () => {
  it("maps 404 to CAMERA_NOT_FOUND", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "camera front_door not found" }), { status: 404 }),
    );
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: true, confirmed: true },
      ctxWith(post),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("CAMERA_NOT_FOUND");
    }
  });

  it("maps a generic non-OK to TOGGLE_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: true, confirmed: true },
      ctxWith(post),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("TOGGLE_FAILED");
  });

  it("disable: 202 without a confirmationToken is TOGGLE_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "confirmation_required" }), { status: 202 }),
    );
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: false, confirmed: true },
      ctxWith(post),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("TOGGLE_FAILED");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("disable: failed confirm hop surfaces the server's message as TOGGLE_FAILED", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ confirmationToken: "tok123" }), { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Token expired", code: "TOKEN_EXPIRED" }), {
          status: 400,
        }),
      );
    const res = await setCameraDetection.handler(
      { camera: "front_door", enabled: false, confirmed: true },
      ctxWith(post),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("TOGGLE_FAILED");
      expect(res.error.message).toContain("Token expired");
    }
  });
});
