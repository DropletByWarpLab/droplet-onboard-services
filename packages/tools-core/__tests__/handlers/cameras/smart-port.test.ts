import { describe, it, expect, vi } from "vitest";
import getCameraInitStatus from "../../../src/handlers/cameras/get-camera-init-status.js";
import initializeCamera from "../../../src/handlers/cameras/initialize-camera.js";
import addCameraToFrigate from "../../../src/handlers/cameras/add-camera-to-frigate.js";
import type { ToolContext } from "../../../src/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ctxWithCameras(get?: ReturnType<typeof vi.fn>, post?: ReturnType<typeof vi.fn>): ToolContext {
  return {
    prisma: {} as ToolContext["prisma"],
    http: {
      cameras: {
        get: get ?? vi.fn(),
        post: post ?? vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
      orchestrator: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      switchSvc: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      fileIndexer: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      nextcloud: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

function ctxWithOrchestrator(post: ReturnType<typeof vi.fn>): ToolContext {
  return {
    prisma: {} as ToolContext["prisma"],
    http: {
      cameras: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      orchestrator: {
        get: vi.fn(),
        post,
        patch: vi.fn(),
        delete: vi.fn(),
      },
      routing: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      switchSvc: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      fileIndexer: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      nextcloud: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("get_camera_init_status", () => {
  it("rejects malformed IP", async () => {
    const r = await getCameraInitStatus.handler({ ip: "notanip" }, ctxWithCameras());
    expect(r.ok).toBe(false);
  });

  it("rejects IP with octets out of range", async () => {
    const r = await getCameraInitStatus.handler({ ip: "192.168.300.1" }, ctxWithCameras());
    expect(r.ok).toBe(false);
  });

  it("returns initialized=null when the service has no vendor flow for this IP", async () => {
    const get = vi.fn().mockResolvedValue(jsonResponse({ detail: "not found" }, 404));
    const r = await getCameraInitStatus.handler({ ip: "192.168.20.176" }, ctxWithCameras(get));
    expect(r.ok).toBe(true);
    expect((r as { data: Record<string, unknown> }).data.initialized).toBeNull();
    expect((r as { data: Record<string, unknown> }).data.needs_initialization).toBe(false);
  });

  it("passes through the service payload on 200", async () => {
    const get = vi.fn().mockResolvedValue(
      jsonResponse({
        ip: "192.168.20.176",
        vendor: "hanwha",
        initialized: false,
        needs_initialization: true,
        details: { public_key_present: true },
      }),
    );
    const r = await getCameraInitStatus.handler({ ip: "192.168.20.176" }, ctxWithCameras(get));
    expect(r.ok).toBe(true);
    expect((r as { data: Record<string, unknown> }).data.vendor).toBe("hanwha");
    expect((r as { data: Record<string, unknown> }).data.needs_initialization).toBe(true);
  });

  it("declares Tier-1 read", () => {
    expect(getCameraInitStatus.requiresWrite).toBe(false);
    expect(getCameraInitStatus.requiresConfirmation).toBe(false);
  });
});

describe("initialize_camera", () => {
  it("rejects malformed IP", async () => {
    const r = await initializeCamera.handler({ ip: "notanip" }, ctxWithCameras());
    expect(r.ok).toBe(false);
  });

  it("passes credentials in the body when supplied", async () => {
    const post = vi.fn().mockResolvedValue(jsonResponse({ ip: "192.168.20.176", success: true, vendor: "hanwha" }));
    const ctx = ctxWithCameras(undefined, post);
    const r = await initializeCamera.handler(
      { ip: "192.168.20.176", username: "admin", password: "Droplet123!" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledWith(
      "/cameras/192.168.20.176/initialize",
      { username: "admin", password: "Droplet123!" },
    );
  });

  it("omits empty username/password (lets the service fall back to env)", async () => {
    const post = vi.fn().mockResolvedValue(jsonResponse({ ip: "192.168.20.176", success: true, vendor: "hanwha" }));
    const ctx = ctxWithCameras(undefined, post);
    await initializeCamera.handler({ ip: "192.168.20.176" }, ctx);
    expect(post).toHaveBeenCalledWith("/cameras/192.168.20.176/initialize", {});
  });

  it("surfaces the service's error message on 409", async () => {
    const post = vi.fn().mockResolvedValue(
      jsonResponse({ ip: "192.168.20.176", success: false, message: "already initialized" }, 409),
    );
    const ctx = ctxWithCameras(undefined, post);
    const r = await initializeCamera.handler({ ip: "192.168.20.176" }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.message).toBe("already initialized");
  });

  it("surfaces tier-2 confirmation when the service replies 202", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(jsonResponse({ reason: "needs confirm" }, 202));
    const ctx = ctxWithCameras(undefined, post);
    const r = await initializeCamera.handler({ ip: "192.168.20.176" }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.status).toBe("confirmation_required");
  });

  it("declares Tier-2 write+confirm", () => {
    expect(initializeCamera.requiresWrite).toBe(true);
    expect(initializeCamera.requiresConfirmation).toBe(true);
  });
});

describe("add_camera_to_frigate", () => {
  it("rejects an invalid name", async () => {
    const r = await addCameraToFrigate.handler(
      { name: "bad name with spaces", rtsp_url: "rtsp://x" },
      ctxWithOrchestrator(vi.fn()),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a non-rtsp URL", async () => {
    const r = await addCameraToFrigate.handler(
      { name: "ok_name", rtsp_url: "http://example.com" },
      ctxWithOrchestrator(vi.fn()),
    );
    expect(r.ok).toBe(false);
  });

  it("posts to /api/cameras with name + rtspUrl on success", async () => {
    const post = vi.fn().mockResolvedValue(jsonResponse({ camera: { id: "cam1" } }, 201));
    const r = await addCameraToFrigate.handler(
      {
        name: "hanwha_dome",
        rtsp_url: "rtsp://admin:pw@192.168.20.176:554/profile2/media.smp",
        manufacturer: "Hanwha",
      },
      ctxWithOrchestrator(post),
    );
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledWith(
      "/api/cameras",
      expect.objectContaining({
        name: "hanwha_dome",
        rtspUrl: "rtsp://admin:pw@192.168.20.176:554/profile2/media.smp",
        manufacturer: "Hanwha",
      }),
    );
  });

  it("surfaces the orchestrator error body on failure", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response("Invalid camera name", { status: 400 }),
    );
    const r = await addCameraToFrigate.handler(
      { name: "ok", rtsp_url: "rtsp://x" },
      ctxWithOrchestrator(post),
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.error.code).toBe("ADD_CAMERA_FAILED");
      expect(r.error.details).toBe("Invalid camera name");
    }
  });

  it("declares Tier-2 write+confirm", () => {
    expect(addCameraToFrigate.requiresWrite).toBe(true);
    expect(addCameraToFrigate.requiresConfirmation).toBe(true);
  });
});
