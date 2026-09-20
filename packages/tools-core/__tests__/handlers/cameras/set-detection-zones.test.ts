/**
 * WARP-1440 — `set_detection_zones` (Tier 2: write + handler-enforced
 * two-step confirmation).
 *
 * Saving zones goes through PATCH /api/cameras/:name/settings, which
 * RESTARTS Frigate (~5-15 s all-camera outage) — so the unconfirmed
 * echo MUST mention the restart, and nothing may hit the wire until
 * `confirmed: true`. Client-side validation mirrors the orchestrator's
 * camera-settings service rules (zone-name regex, normalised [0,1]
 * coords, >= 3 points) so the model gets precise errors without
 * burning a round-trip.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import setDetectionZones from "../../../src/handlers/cameras/set-detection-zones.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(orchestratorPatch: Mock): ToolContext {
  return {
    http: {
      cameras: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      orchestrator: {
        get: vi.fn(),
        post: vi.fn(),
        patch: orchestratorPatch,
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

/** A valid triangle in normalized coords. */
const TRIANGLE: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [0.5, 0.5],
];

describe("set_detection_zones — tool metadata", () => {
  it("is named set_detection_zones and is Tier-2 (write + confirm)", () => {
    expect(setDetectionZones.name).toBe("set_detection_zones");
    expect(setDetectionZones.requiresWrite).toBe(true);
    expect(setDetectionZones.requiresConfirmation).toBe(true);
  });

  it("has an additionalProperties:false input schema requiring camera + zones", () => {
    const schema = setDetectionZones.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["camera", "zones"]);
  });

  it("warns about the NVR restart in the tool description", () => {
    expect(setDetectionZones.description.toLowerCase()).toContain("restart");
  });
});

describe("set_detection_zones — client-side validation (no HTTP)", () => {
  it("rejects a missing camera", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      { zones: [{ name: "driveway", coordinates: TRIANGLE }] },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects a non-array zones", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      { camera: "front_door", zones: "driveway" },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects a bad zone name (service regex parity)", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      { camera: "front_door", zones: [{ name: "drive way!", coordinates: TRIANGLE }] },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ZONES");
      expect(res.error.message).toContain("Invalid zone name");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects duplicate zone names", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [
          { name: "driveway", coordinates: TRIANGLE },
          { name: "driveway", coordinates: TRIANGLE },
        ],
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ZONES");
      expect(res.error.message).toContain("Duplicate zone name");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects coordinates outside [0, 1]", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: [[0, 0], [1.5, 0], [0.5, 0.5]] }],
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ZONES");
      expect(res.error.message).toContain("normalised [0, 1]");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects a polygon with fewer than 3 points", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: [[0, 0], [0.5, 0.5]] }],
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ZONES");
      expect(res.error.message).toContain("at least 3");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects coordinates that are not [x, y] pairs", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: [0, 0, 0.5, 0, 0.5, 0.5] }],
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ZONES");
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects an invalid object label", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: TRIANGLE, objects: ["per son"] }],
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ZONES");
      expect(res.error.message).toContain("invalid object label");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects a motion mask with fewer than 3 points", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: TRIANGLE }],
        motion_masks: [{ coordinates: [[0, 0], [0.5, 0.5]] }],
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ZONES");
      expect(res.error.message).toContain("motion mask");
    }
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("set_detection_zones — handler-enforced confirmation", () => {
  it("first call returns confirmation_required with zone names + restart warning, NO HTTP", async () => {
    const patch = vi.fn();
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [
          { name: "driveway", coordinates: TRIANGLE },
          { name: "porch", coordinates: TRIANGLE, objects: ["person"] },
        ],
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("confirmation_required");
      expect(res.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(res.error.message).toContain("front_door");
      expect(res.error.message).toContain("2 zone");
      expect(res.error.message).toContain("driveway");
      expect(res.error.message).toContain("porch");
      // The restart is the whole reason this is Tier-2 — it must be echoed.
      expect(res.error.message.toLowerCase()).toContain("restart");
      expect(res.error.details).toMatchObject({
        type: "set_detection_zones",
        camera: "front_door",
        zones: ["driveway", "porch"],
      });
    }
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("set_detection_zones — confirmed execution", () => {
  it("PATCHes the settings route with the exact flat-coordinate body", async () => {
    const patch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ settings: {} }), { status: 200 }),
    );
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [
          { name: "driveway", coordinates: TRIANGLE, objects: ["person"] },
        ],
        motion_masks: [{ coordinates: [[0, 0.9], [1, 0.9], [1, 1]] }],
        confirmed: true,
      },
      ctxWith(patch),
    );
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/api/cameras/front_door/settings", {
      zones: [
        { name: "driveway", coordinates: [0, 0, 0.5, 0, 0.5, 0.5], objects: ["person"] },
      ],
      motionMasks: [{ coordinates: [0, 0.9, 1, 0.9, 1, 1] }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "set_detection_zones",
        camera: "front_door",
        zones: ["driveway"],
        restartTriggered: true,
      });
    }
  });

  it("omits motionMasks from the body when motion_masks is not provided", async () => {
    const patch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ settings: {} }), { status: 200 }),
    );
    await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: TRIANGLE }],
        confirmed: true,
      },
      ctxWith(patch),
    );
    expect(patch).toHaveBeenCalledWith("/api/cameras/front_door/settings", {
      zones: [{ name: "driveway", coordinates: [0, 0, 0.5, 0, 0.5, 0.5], objects: [] }],
    });
  });
});

describe("set_detection_zones — error mapping", () => {
  it("passes a validation 400's message through as INVALID_ZONES", async () => {
    const patch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Zone driveway inertia must be between 1 and 50" }), {
        status: 400,
      }),
    );
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: TRIANGLE }],
        confirmed: true,
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ZONES");
      expect(res.error.message).toContain("inertia must be between 1 and 50");
    }
  });

  it("maps 404 to CAMERA_NOT_FOUND", async () => {
    const patch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "camera front_door not found" }), { status: 404 }),
    );
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: TRIANGLE }],
        confirmed: true,
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CAMERA_NOT_FOUND");
  });

  it("maps a generic non-OK to ZONES_UPDATE_FAILED", async () => {
    const patch = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    const res = await setDetectionZones.handler(
      {
        camera: "front_door",
        zones: [{ name: "driveway", coordinates: TRIANGLE }],
        confirmed: true,
      },
      ctxWith(patch),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("ZONES_UPDATE_FAILED");
  });
});
