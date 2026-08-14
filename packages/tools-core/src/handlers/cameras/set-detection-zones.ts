/**
 * WARP-1440 — `set_detection_zones` LLM tool.
 *
 * Wholesale-replaces a camera's motion-detection zones (and optionally
 * its motion masks) via the orchestrator's
 * `PATCH /api/cameras/:name/settings` route. Saving POSTs the merged
 * config to Frigate with `save_option=restart` — the NVR RESTARTS and
 * ALL cameras stop recording/detecting for roughly 5-15 seconds, which
 * is why this is Tier 2 and the confirmation echo must carry the
 * warning.
 *
 * Tier 2 (write + requires confirmation), enforced BY THE HANDLER —
 * same two-phase contract as `memory_forget`: the first call returns
 * `confirmation_required` (no HTTP) summarizing the zones + the restart;
 * the model relays it and re-issues with `confirmed: true` only after
 * an explicit user yes.
 *
 * Wire shape: the tool accepts LLM-friendly `[[x, y], …]` coordinate
 * PAIRS, but the PATCH route expects each zone/mask `coordinates` as a
 * FLAT number array (`[x1, y1, x2, y2, …]`) — the handler validates the
 * pairs against the camera-settings service's rules (zone-name regex
 * `^[a-zA-Z0-9_-]{1,40}$`, no duplicates, >= 3 points, coords finite in
 * [0, 1], object labels `^[a-z0-9_-]{1,32}$/i`) and flattens before
 * sending. `inertia` is intentionally not exposed — the route defaults
 * it to 3.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";

const TOOL_NAME = "set_detection_zones";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Mirror of the orchestrator route's CAMERA_NAME_RE. */
const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** Mirror of camera-settings.service.ts ZONE_NAME_RE. */
const ZONE_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;
/** Mirror of the service's object-label rule. */
const OBJECT_LABEL_RE = /^[a-z0-9_-]{1,32}$/i;

const coordinatePairs = {
  type: "array",
  minItems: 3,
  items: {
    type: "array",
    items: { type: "number", minimum: 0, maximum: 1 },
    minItems: 2,
    maxItems: 2,
  },
} as const;

const inputSchema = {
  type: "object",
  properties: {
    camera: {
      type: "string",
      description: "Camera name from list_cameras (e.g. front_door).",
    },
    zones: {
      type: "array",
      description:
        "COMPLETE replacement set of detection zones for this camera (existing zones not listed here are removed). Each zone is a polygon in normalized coordinates.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Zone name — letters, digits, underscore, hyphen (max 40 chars).",
          },
          coordinates: {
            ...coordinatePairs,
            description:
              "Polygon vertices as [x, y] pairs normalized to 0..1 (top-left origin), at least 3 points.",
          },
          objects: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional object labels this zone applies to (e.g. person, car). Omit or leave empty for all tracked labels.",
          },
        },
        required: ["name", "coordinates"],
        additionalProperties: false,
      },
    },
    motion_masks: {
      type: "array",
      description:
        "Optional COMPLETE replacement set of motion masks (areas ignored by motion detection, e.g. a busy street or timestamp overlay). Omit to leave existing masks untouched; pass [] to remove them all.",
      items: {
        type: "object",
        properties: {
          coordinates: {
            ...coordinatePairs,
            description:
              "Mask polygon vertices as [x, y] pairs normalized to 0..1, at least 3 points.",
          },
        },
        required: ["coordinates"],
        additionalProperties: false,
      },
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the action, and the user approves from that prompt.",
    },
  },
  required: ["camera", "zones"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

function invalidZones(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ZONES", message } };
}

/**
 * Validate a polygon given as [x, y] pairs and flatten it to the route's
 * wire shape. `label` seeds the error messages (mirrors the service's
 * wording so pre-flight and server errors read the same). Returns the
 * flat array, or a string error message.
 */
function flattenPolygon(raw: unknown, label: string): number[] | string {
  if (!Array.isArray(raw)) return `${label} coordinates must be an array of [x, y] pairs`;
  if (raw.length < 3) return `${label} needs at least 3 (x, y) points`;
  const flat: number[] = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length !== 2) {
      return `${label} coordinates must be an array of [x, y] pairs`;
    }
    for (const c of point) {
      if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
        return `${label} coordinates must be normalised [0, 1]`;
      }
      flat.push(c);
    }
  }
  return flat;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const camera = typeof args.camera === "string" ? args.camera.trim() : "";
  if (camera.length === 0) return invalidArgs("camera is required");
  if (!CAMERA_NAME_RE.test(camera)) {
    return invalidArgs(
      "invalid camera name — letters, digits, underscore, and hyphen only (max 64 chars)",
    );
  }
  if (!Array.isArray(args.zones)) {
    return invalidArgs("zones is required and must be an array");
  }

  // Pre-flight the exact rules the camera-settings service enforces so
  // the model gets a precise error without a round-trip (and without
  // asking the user to approve a change that would 400 anyway).
  const zones: Array<{ name: string; coordinates: number[]; objects: string[] }> = [];
  const seen = new Set<string>();
  for (const raw of args.zones) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return invalidZones("Each zone must be an object with name and coordinates");
    }
    const z = raw as Record<string, unknown>;
    if (typeof z.name !== "string" || !ZONE_NAME_RE.test(z.name)) {
      return invalidZones(
        `Invalid zone name: ${String(z.name)} — letters, digits, underscore, hyphen (max 40 chars)`,
      );
    }
    if (seen.has(z.name)) return invalidZones(`Duplicate zone name: ${z.name}`);
    seen.add(z.name);
    const flat = flattenPolygon(z.coordinates, `Zone ${z.name}`);
    if (typeof flat === "string") return invalidZones(flat);
    const objects: string[] = [];
    if (z.objects !== undefined) {
      if (!Array.isArray(z.objects)) {
        return invalidZones(`Zone ${z.name} objects must be an array of label strings`);
      }
      for (const obj of z.objects) {
        if (typeof obj !== "string" || !OBJECT_LABEL_RE.test(obj)) {
          return invalidZones(`Zone ${z.name} has invalid object label: ${String(obj)}`);
        }
        objects.push(obj);
      }
    }
    zones.push({ name: z.name, coordinates: flat, objects });
  }

  let motionMasks: Array<{ coordinates: number[] }> | undefined;
  if (args.motion_masks !== undefined) {
    if (!Array.isArray(args.motion_masks)) {
      return invalidZones("motion_masks must be an array");
    }
    motionMasks = [];
    for (const raw of args.motion_masks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return invalidZones("Each motion mask must be an object with coordinates");
      }
      const flat = flattenPolygon((raw as Record<string, unknown>).coordinates, "Each motion mask");
      if (typeof flat === "string") return invalidZones(flat);
      motionMasks.push({ coordinates: flat });
    }
  }

  // Confirmation gate — AFTER validation, BEFORE any HTTP. The restart
  // is the whole reason this is Tier-2, so the echo must carry it.
  const fingerprint = confirmationFingerprint([TOOL_NAME, camera, zones, motionMasks ?? null]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    const names = zones.map((z) => z.name);
    const summary =
      zones.length === 0
        ? `remove ALL detection zones from "${camera}"`
        : `replace the detection zones on "${camera}" with ${zones.length} zone(s): ${names.join(", ")}`;
    const maskNote =
      motionMasks !== undefined ? ` and set ${motionMasks.length} motion mask(s)` : "";
    return confirmationRequired(
      `I'd like to ${summary}${maskNote}. Saving RESTARTS the NVR (Frigate) — ` +
        "ALL cameras briefly stop recording and detecting for about 5-15 seconds. " +
        "Ask the user to approve. " +
        "You cannot approve on their behalf.",
      { type: "set_detection_zones", camera, zones: names },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  // Exact body keys the PATCH route accepts: `zones` and `motionMasks`
  // (camelCase), with FLAT coordinate arrays. `motionMasks` only when
  // the caller provided masks — omitting it leaves existing masks alone.
  const body: {
    zones: Array<{ name: string; coordinates: number[]; objects: string[] }>;
    motionMasks?: Array<{ coordinates: number[] }>;
  } = { zones };
  if (motionMasks !== undefined) body.motionMasks = motionMasks;

  const res = await ctx.http.orchestrator.patch(
    `/api/cameras/${encodeURIComponent(camera)}/settings`,
    body,
  );

  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const serverMsg = errBody && typeof errBody.error === "string" ? errBody.error : null;
    if (res.status === 404) {
      return {
        ok: false,
        status: "error",
        error: { code: "CAMERA_NOT_FOUND", message: serverMsg ?? `camera "${camera}" not found` },
      };
    }
    if (res.status === 400) {
      return invalidZones(serverMsg ?? "orchestrator rejected the zone update");
    }
    return {
      ok: false,
      status: "error",
      error: {
        code: "ZONES_UPDATE_FAILED",
        message: serverMsg ?? `orchestrator returned ${res.status}`,
      },
    };
  }

  return {
    ok: true,
    data: {
      type: "set_detection_zones",
      camera,
      zones: zones.map((z) => z.name),
      restartTriggered: true,
    },
  };
}

const tool: Tool = {
  name: "set_detection_zones",
  description:
    "Define or replace a camera's motion-detection zones (and optionally its motion masks). Zones are polygons in normalized [0,1] coordinates that scope detection and alerts to areas like a driveway or porch; the list you pass wholesale-replaces the camera's existing zones. WARNING: saving restarts the NVR (Frigate) — ALL cameras briefly stop recording and detecting for about 5-15 seconds. Two-step: the first call returns confirmation_required summarizing the zones and the restart — relay it to the user, and only after they explicitly approve, approval is handled outside this conversation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
