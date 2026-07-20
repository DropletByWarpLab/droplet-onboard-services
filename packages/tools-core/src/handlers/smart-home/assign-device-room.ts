/**
 * WARP-1447 — `assign_device_room` LLM tool.
 *
 * Puts a smart-home device in a room ("move the lamp to the den") so
 * room-based control and the dashboard's household map work. Flow:
 *
 *   1. Resolve the device from `ctx.matter.listDevices()` — exact nodeId
 *      match first, else case-insensitive match on the household alias
 *      (`friendlyName`) or Matter product name (`name`). Ambiguous names
 *      error with the candidate list; nothing is written.
 *   2. Resolve the room case-insensitively from `GET /api/matter/rooms`;
 *      auto-create it via `POST /api/matter/rooms` when no room matches
 *      (the route admits the MCP service principal — WARP-1447 guard).
 *   3. Assign via `PATCH /api/matter/devices/:nodeId/alias` with a body of
 *      `{ roomId }` ONLY. rooms.service.ts `upsertAlias` leaves the stored
 *      alias name untouched when the `name` key is absent, so the device's
 *      display name is preserved without a read-modify-write round-trip.
 *
 * PATCH, not PUT: the tools-core `HttpClient` deliberately exposes only
 * get/post/patch/delete, and `upsertAlias` is a partial update — the
 * orchestrator's alias route accepts both verbs (routes/matter.ts).
 *
 * Write tier, NO confirmation — organizing devices into rooms is
 * reversible household bookkeeping (same tier as create_reminder), not a
 * physical actuation like control_device.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

interface DeviceEntry {
  nodeId: string;
  /** Matter-reported product name. */
  name?: string | null;
  /** WARP-1396 household alias; absent/null when the user never renamed. */
  friendlyName?: string | null;
}

interface RoomEntry {
  id: string;
  name: string;
}

const inputSchema = {
  type: "object",
  properties: {
    device: {
      type: "string",
      description:
        "The device to assign — its household name (e.g. 'kitchen strip'), product name, or Matter node id.",
    },
    room: {
      type: "string",
      minLength: 1,
      maxLength: 60,
      description:
        "Room name (e.g. 'Den'). Matched case-insensitively against existing rooms; auto-created if no room matches.",
    },
  },
  required: ["device", "room"],
  additionalProperties: false,
} as const;

function err(code: string, message: string, details?: unknown): ToolResult {
  return {
    ok: false,
    status: "error",
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

/** Best-effort human-readable message from an orchestrator error body. */
async function bodyMessage(res: Response): Promise<string> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown; error?: unknown } | null;
  const m = body?.message ?? body?.error;
  return typeof m === "string" ? m : `orchestrator returned ${res.status}`;
}

/**
 * Flatten the grouped `GET /api/matter/devices` shape (8 category arrays;
 * the degraded shape adds a non-array `_status` key, which is skipped).
 */
function flattenDevices(grouped: unknown): DeviceEntry[] {
  if (!grouped || typeof grouped !== "object") return [];
  const out: DeviceEntry[] = [];
  for (const value of Object.values(grouped)) {
    if (!Array.isArray(value)) continue;
    for (const d of value) {
      if (d && typeof d === "object" && typeof (d as { nodeId?: unknown }).nodeId === "string") {
        out.push(d as DeviceEntry);
      }
    }
  }
  return out;
}

/** What the household calls the device: alias, else product name, else id. */
function displayName(d: DeviceEntry): string {
  return (typeof d.friendlyName === "string" && d.friendlyName.trim()) || d.name || d.nodeId;
}

function resolveDevice(
  devices: DeviceEntry[],
  query: string,
): { match?: DeviceEntry; candidates?: DeviceEntry[] } {
  const exact = devices.find((d) => d.nodeId === query);
  if (exact) return { match: exact };
  const target = query.toLowerCase();
  const matches = devices.filter(
    (d) =>
      (typeof d.friendlyName === "string" && d.friendlyName.trim().toLowerCase() === target) ||
      (typeof d.name === "string" && d.name.trim().toLowerCase() === target),
  );
  if (matches.length === 1) return { match: matches[0] };
  if (matches.length > 1) return { candidates: matches };
  return {};
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = typeof args.device === "string" ? args.device.trim() : "";
  const roomName = typeof args.room === "string" ? args.room.trim() : "";
  if (!device) {
    return err("INVALID_ARGS", "device is required (name or Matter node id)");
  }
  if (!roomName || roomName.length > 60) {
    return err("INVALID_ARGS", "room must be a name between 1 and 60 characters");
  }

  // 1. Resolve the device — before any write.
  let grouped: unknown;
  try {
    grouped = await ctx.matter.listDevices();
  } catch (e) {
    return err(
      "ASSIGN_FAILED",
      `Could not list smart-home devices: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const { match, candidates } = resolveDevice(flattenDevices(grouped), device);
  if (candidates) {
    return err(
      "AMBIGUOUS_DEVICE",
      `Multiple devices match "${device}": ${candidates
        .map((d) => `${displayName(d)} (node ${d.nodeId})`)
        .join(", ")}. Retry with the node id.`,
      { candidates: candidates.map((d) => ({ nodeId: d.nodeId, name: displayName(d) })) },
    );
  }
  if (!match) {
    return err(
      "DEVICE_NOT_FOUND",
      `No smart-home device matches "${device}" by name or node id. Call list_smart_home_devices to see what exists.`,
    );
  }

  // 2. Resolve the room case-insensitively; create it when missing.
  const roomsRes = await ctx.http.orchestrator.get("/api/matter/rooms", {
    headers: { Accept: "application/json" },
  });
  if (!roomsRes.ok) {
    return err("ASSIGN_FAILED", `Could not list rooms: ${await bodyMessage(roomsRes)}`);
  }
  const roomsBody = (await roomsRes.json()) as { rooms?: RoomEntry[] };
  const target = roomName.toLowerCase();
  let room = (roomsBody.rooms ?? []).find((r) => r.name.trim().toLowerCase() === target);
  let roomCreated = false;
  if (!room) {
    const createRes = await ctx.http.orchestrator.post("/api/matter/rooms", { name: roomName });
    if (!createRes.ok) {
      return err(
        "ASSIGN_FAILED",
        `Could not create room "${roomName}": ${await bodyMessage(createRes)}`,
      );
    }
    room = (await createRes.json()) as RoomEntry;
    roomCreated = true;
  }

  // 3. Assign. The body carries `roomId` ONLY — upsertAlias preserves the
  //    stored alias name when the `name` key is absent (rooms.service.ts),
  //    so this never renames the device.
  const assignRes = await ctx.http.orchestrator.patch(
    `/api/matter/devices/${encodeURIComponent(match.nodeId)}/alias`,
    { roomId: room.id },
  );
  if (assignRes.status === 404) {
    return err("DEVICE_NOT_FOUND", `Assignment failed: ${await bodyMessage(assignRes)}`);
  }
  if (!assignRes.ok) {
    return err(
      "ASSIGN_FAILED",
      `Could not put "${displayName(match)}" in "${room.name}": ${await bodyMessage(assignRes)}`,
    );
  }

  return {
    ok: true,
    data: {
      type: "assign_device_room",
      device: { nodeId: match.nodeId, name: displayName(match) },
      room: { id: room.id, name: room.name },
      roomCreated,
    },
  };
}

const tool: Tool = {
  name: "assign_device_room",
  description:
    "Put a smart-home device in a room ('move the lamp to the den', 'the heater is in the office') so room-based control and the dashboard's household map work. Accepts the device's household or product name, or its Matter node id, plus a room name — the room is matched case-insensitively and created automatically if it doesn't exist yet. Never changes the device's display name, and is freely reversible by reassigning.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
