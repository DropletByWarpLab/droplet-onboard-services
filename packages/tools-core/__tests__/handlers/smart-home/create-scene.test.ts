/**
 * WARP-1447 — `create_scene` tool: handler-enforced two-step confirm
 * (validate → resolve devices → confirmation echo → POST /api/scenes),
 * with device-name resolution via ctx.matter.listDevices() and the
 * route's exact createSceneSchema wire shape on the confirmed hop.
 */
import { describe, it, expect, vi } from "vitest";
import createScene from "../../../src/handlers/smart-home/create-scene.js";
import { runApproved } from "../../helpers/approve.js";
import type { ToolContext } from "../../../src/types.js";

/** Grouped shape returned by GET /api/matter/devices (MatterGrouped). */
const GROUPED = {
  lights: [
    { nodeId: "101", name: "Hue Bulb", friendlyName: "living-room lamp" },
    { nodeId: "102", name: "Hue Bulb", friendlyName: "bedroom lamp" },
  ],
  switches: [],
  sensors: [],
  climate: [],
  media: [],
  covers: [],
  locks: [{ nodeId: "201", name: "Yale Lock", friendlyName: "front door" }],
  other: [],
};

function ctxWith(
  post: ReturnType<typeof vi.fn>,
  listDevices: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(GROUPED),
): ToolContext {
  return {
    http: {
      orchestrator: {
        get: vi.fn(),
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
    matter: { listDevices } as unknown as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("create_scene", () => {
  it("flags write+confirmation and registers under the canonical name", () => {
    expect(createScene.name).toBe("create_scene");
    expect(createScene.requiresWrite).toBe(true);
    expect(createScene.requiresConfirmation).toBe(true);
  });

  // ── Validation (mirrors the route's zod limits; no HTTP, no device lookup) ──

  it.each([
    ["missing name", { actions: [{ device: "101", command: "turn_off" }] }],
    ["blank name", { name: "  ", actions: [{ device: "101", command: "turn_off" }] }],
    ["name over 120 chars", { name: "x".repeat(121), actions: [{ device: "101", command: "turn_off" }] }],
    ["missing actions", { name: "Movie night" }],
    ["empty actions", { name: "Movie night", actions: [] }],
    [
      "more than 64 actions",
      {
        name: "Movie night",
        actions: Array.from({ length: 65 }, () => ({ device: "101", command: "turn_off" })),
      },
    ],
    ["action without command", { name: "Movie night", actions: [{ device: "101" }] }],
    ["action without device", { name: "Movie night", actions: [{ command: "turn_off" }] }],
    [
      "non-object action args",
      { name: "Movie night", actions: [{ device: "101", command: "turn_off", args: [1] }] },
    ],
    ["non-string icon", { name: "Movie night", icon: 7, actions: [{ device: "101", command: "turn_off" }] }],
    [
      "icon over 64 chars",
      { name: "Movie night", icon: "i".repeat(65), actions: [{ device: "101", command: "turn_off" }] },
    ],
  ])("rejects %s with INVALID_ARGS before any lookup or write", async (_label, args) => {
    const post = vi.fn();
    const listDevices = vi.fn();
    const r = await runApproved(createScene, args as Record<string, unknown>, ctxWith(post, listDevices));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(listDevices).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  // ── Confirmation-first: resolved-device echo, NO HTTP write ──

  it("unconfirmed call returns confirmation_required echoing the RESOLVED devices, without POSTing", async () => {
    const post = vi.fn();
    const r = await runApproved(createScene, 
      {
        name: "Movie night",
        actions: [
          { device: "Living-Room Lamp", command: "turn_off" },
          { device: "front door", command: "lock" },
        ],
      },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      // Plain-language action summary with the resolved device labels.
      expect(r.error.message).toContain('"Movie night"');
      expect(r.error.message).toContain("turn off living-room lamp");
      expect(r.error.message).toContain("lock front door");
      // The details carry the real nodeIds the user is approving.
      expect(r.error.details).toMatchObject({
        type: "create_scene",
        name: "Movie night",
        actions: [
          { deviceNodeId: "101", device: "living-room lamp", command: "turn_off" },
          { deviceNodeId: "201", device: "front door", command: "lock" },
        ],
      });
    }
    expect(post).not.toHaveBeenCalled();
  });

  // ── Confirmed happy path: exact wire shape of createSceneSchema ──

  it("confirmed call POSTs the route's exact zod shape and returns id/name/actionCount", async () => {
    const post = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          id: "scene-1",
          name: "Movie night",
          icon: "film",
          actions: [
            { id: "a0", idx: 0, deviceNodeId: "101", command: "turn_off", args: null },
            { id: "a1", idx: 1, deviceNodeId: "102", command: "set_brightness", args: { level: 20 } },
          ],
        },
        201,
      ),
    );
    const r = await runApproved(createScene, 
      {
        name: "Movie night",
        icon: "film",
        actions: [
          { device: "living-room lamp", command: "turn_off" },
          { device: "bedroom lamp", command: "set_brightness", args: { level: 20 } },
        ],
        confirmed: true,
      },
      ctxWith(post),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/api/scenes");
    // Exact body: resolved nodeIds, args only where provided, no stray keys.
    expect(post.mock.calls[0][1]).toEqual({
      name: "Movie night",
      icon: "film",
      actions: [
        { deviceNodeId: "101", command: "turn_off" },
        { deviceNodeId: "102", command: "set_brightness", args: { level: 20 } },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        type: "create_scene",
        id: "scene-1",
        name: "Movie night",
        actionCount: 2,
      });
    }
  });

  it("passes a known nodeId through without name matching", async () => {
    const post = vi.fn().mockResolvedValue(
      jsonResponse({ id: "scene-2", name: "Goodnight", actions: [{}] }, 201),
    );
    const r = await runApproved(createScene, 
      { name: "Goodnight", actions: [{ device: "201", command: "lock" }], confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(true);
    expect(post.mock.calls[0][1]).toEqual({
      name: "Goodnight",
      actions: [{ deviceNodeId: "201", command: "lock" }],
    });
  });

  // ── Device resolution failures (before confirmation, before HTTP) ──

  it("returns DEVICE_NOT_FOUND for an unknown device name", async () => {
    const post = vi.fn();
    const r = await runApproved(createScene, 
      { name: "Movie night", actions: [{ device: "garage heater", command: "turn_on" }] },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DEVICE_NOT_FOUND");
    expect(post).not.toHaveBeenCalled();
  });

  it("returns AMBIGUOUS_DEVICE with candidates when a name matches several devices", async () => {
    const post = vi.fn();
    const r = await runApproved(createScene, 
      { name: "Movie night", actions: [{ device: "Hue Bulb", command: "turn_off" }] },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AMBIGUOUS_DEVICE");
      expect(r.error.details).toMatchObject({
        device: "Hue Bulb",
        candidates: [
          { nodeId: "101", label: "living-room lamp" },
          { nodeId: "102", label: "bedroom lamp" },
        ],
      });
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("returns DEVICE_RESOLUTION_FAILED when the device list is unavailable", async () => {
    const post = vi.fn();
    const listDevices = vi.fn().mockRejectedValue(new Error("sidecar down"));
    const r = await runApproved(createScene, 
      { name: "Movie night", actions: [{ device: "living-room lamp", command: "turn_off" }] },
      ctxWith(post, listDevices),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("DEVICE_RESOLUTION_FAILED");
      expect(r.error.message).toContain("sidecar down");
    }
    expect(post).not.toHaveBeenCalled();
  });

  // ── Server error mappings ──

  it("maps a 400 to INVALID_SCENE passing the server message through", async () => {
    const post = vi.fn().mockResolvedValue(
      jsonResponse({ error: "Invalid scene", details: { fieldErrors: {} } }, 400),
    );
    const r = await runApproved(createScene, 
      { name: "Movie night", actions: [{ device: "101", command: "turn_off" }], confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_SCENE");
      expect(r.error.message).toBe("Invalid scene");
    }
  });

  it("maps any other non-2xx to CREATE_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const r = await runApproved(createScene, 
      { name: "Movie night", actions: [{ device: "101", command: "turn_off" }], confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CREATE_FAILED");
      expect(r.error.message).toContain("500");
    }
  });
});
