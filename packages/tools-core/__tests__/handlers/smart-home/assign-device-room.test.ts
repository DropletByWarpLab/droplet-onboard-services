import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import assignDeviceRoom from "../../../src/handlers/smart-home/assign-device-room.js";
import type { ToolContext } from "../../../src/types.js";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Grouped shape from GET /api/matter/devices (via ctx.matter.listDevices). */
const GROUPED = {
  lights: [
    // Household alias set — display name is the alias, not the product name.
    { nodeId: "7", name: "Hue Go", friendlyName: "the lamp" },
    // No alias — display name falls back to the Matter product name.
    { nodeId: "9", name: "Ceiling Light", friendlyName: null },
  ],
  switches: [{ nodeId: "12", name: "Smart Plug", friendlyName: "heater plug" }],
  sensors: [],
  climate: [],
  media: [],
  covers: [],
  locks: [],
  other: [],
};

const DEN = { id: "r-den", name: "Den", icon: "sofa", sortOrder: 1, deviceCount: 0 };

interface MockCtxOpts {
  devices?: unknown;
  listDevicesError?: Error;
  get?: Mock;
  post?: Mock;
  patch?: Mock;
}

function ctxWith(opts: MockCtxOpts = {}) {
  const get = opts.get ?? vi.fn();
  const post = opts.post ?? vi.fn();
  const patch = opts.patch ?? vi.fn();
  const listDevices = opts.listDevicesError
    ? vi.fn().mockRejectedValue(opts.listDevicesError)
    : vi.fn().mockResolvedValue(opts.devices ?? GROUPED);
  const ctx = {
    http: {
      orchestrator: { get, post, patch, delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: { listDevices } as unknown as ToolContext["matter"],
    signal: new AbortController().signal,
  } as ToolContext;
  return { ctx, get, post, patch, listDevices };
}

/** get mock that serves the rooms list. */
function roomsList(rooms: unknown[]): Mock {
  return vi.fn().mockResolvedValue(jsonRes({ rooms }));
}

describe("assign_device_room", () => {
  it("metadata: write tier WITHOUT confirmation, closed schema", () => {
    expect(assignDeviceRoom.name).toBe("assign_device_room");
    expect(assignDeviceRoom.requiresWrite).toBe(true);
    expect(assignDeviceRoom.requiresConfirmation).toBe(false);
    const schema = assignDeviceRoom.inputSchema as {
      additionalProperties: boolean;
      required: readonly string[];
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["device", "room"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["device", "room"]);
  });

  it("rejects missing/empty device with no lookups and no HTTP", async () => {
    const { ctx, get, post, patch, listDevices } = ctxWith();
    const r = await assignDeviceRoom.handler({ device: "  ", room: "Den" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(listDevices).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects an empty or over-long room with no HTTP", async () => {
    const { ctx, patch, listDevices } = ctxWith();
    const empty = await assignDeviceRoom.handler({ device: "the lamp", room: "" }, ctx);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("INVALID_ARGS");
    const long = await assignDeviceRoom.handler(
      { device: "the lamp", room: "x".repeat(61) },
      ctx,
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe("INVALID_ARGS");
    expect(listDevices).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("happy path, existing room: case-insensitive room match, no duplicate room, PATCH body preserves the name by OMITTING it", async () => {
    const get = roomsList([DEN]);
    const patch = vi
      .fn()
      .mockResolvedValue(jsonRes({ nodeId: "7", name: "the lamp", roomId: "r-den" }));
    const { ctx, post } = ctxWith({ get, patch });

    // "den" (lower) must match the stored "Den" — and must NOT create a duplicate.
    const r = await assignDeviceRoom.handler({ device: "The Lamp", room: "den" }, ctx);

    expect(get).toHaveBeenCalledWith("/api/matter/rooms", expect.anything());
    expect(post).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toBe("/api/matter/devices/7/alias");
    // Name preservation: rooms.service upsertAlias keeps the stored alias
    // name only when the `name` key is ABSENT — the body must be roomId-only.
    expect(patch.mock.calls[0][1]).toEqual({ roomId: "r-den" });
    expect(Object.keys(patch.mock.calls[0][1] as object)).toEqual(["roomId"]);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        type: "assign_device_room",
        device: { nodeId: "7", name: "the lamp" },
        room: { id: "r-den", name: "Den" },
        roomCreated: false,
      });
    }
  });

  it("auto-creates a missing room and reports roomCreated: true", async () => {
    const get = roomsList([]);
    const post = vi
      .fn()
      .mockResolvedValue(jsonRes({ id: "r-new", name: "Office", icon: "home", sortOrder: 1 }, 201));
    const patch = vi
      .fn()
      .mockResolvedValue(jsonRes({ nodeId: "12", name: "heater plug", roomId: "r-new" }));
    const { ctx } = ctxWith({ get, post, patch });

    const r = await assignDeviceRoom.handler({ device: "heater plug", room: "Office" }, ctx);

    expect(post).toHaveBeenCalledWith("/api/matter/rooms", { name: "Office" });
    expect(patch.mock.calls[0][0]).toBe("/api/matter/devices/12/alias");
    expect(patch.mock.calls[0][1]).toEqual({ roomId: "r-new" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        device: { nodeId: "12", name: "heater plug" },
        room: { id: "r-new", name: "Office" },
        roomCreated: true,
      });
    }
  });

  it("resolves a device by exact nodeId; display name falls back to the product name", async () => {
    const get = roomsList([DEN]);
    const patch = vi
      .fn()
      .mockResolvedValue(jsonRes({ nodeId: "9", name: null, roomId: "r-den" }));
    const { ctx } = ctxWith({ get, patch });

    const r = await assignDeviceRoom.handler({ device: "9", room: "Den" }, ctx);

    expect(patch.mock.calls[0][0]).toBe("/api/matter/devices/9/alias");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({ device: { nodeId: "9", name: "Ceiling Light" } });
    }
  });

  it("ambiguous name -> AMBIGUOUS_DEVICE listing candidates, with NO writes", async () => {
    const devices = {
      ...GROUPED,
      lights: [
        { nodeId: "7", name: "Hue Go", friendlyName: "Lamp" },
        { nodeId: "8", name: "Lamp", friendlyName: null },
      ],
    };
    const { ctx, get, post, patch } = ctxWith({ devices });

    const r = await assignDeviceRoom.handler({ device: "lamp", room: "Den" }, ctx);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AMBIGUOUS_DEVICE");
      expect(r.error.details).toEqual({
        candidates: [
          { nodeId: "7", name: "Lamp" },
          { nodeId: "8", name: "Lamp" },
        ],
      });
    }
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("unknown device -> DEVICE_NOT_FOUND with no HTTP", async () => {
    const { ctx, get, post, patch } = ctxWith();
    const r = await assignDeviceRoom.handler({ device: "no such thing", room: "Den" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DEVICE_NOT_FOUND");
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("device-list failure -> ASSIGN_FAILED", async () => {
    const { ctx } = ctxWith({ listDevicesError: new Error("sidecar down") });
    const r = await assignDeviceRoom.handler({ device: "the lamp", room: "Den" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ASSIGN_FAILED");
      expect(r.error.message).toContain("sidecar down");
    }
  });

  it("rooms-listing failure -> ASSIGN_FAILED with no writes", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const { ctx, post, patch } = ctxWith({ get });
    const r = await assignDeviceRoom.handler({ device: "the lamp", room: "Den" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ASSIGN_FAILED");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("room-create failure -> ASSIGN_FAILED surfacing the server message", async () => {
    const get = roomsList([]);
    const post = vi.fn().mockResolvedValue(
      jsonRes({ error: "invalid_room", message: "name must be 32 characters or fewer" }, 400),
    );
    const { ctx, patch } = ctxWith({ get, post });
    const r = await assignDeviceRoom.handler(
      { device: "the lamp", room: "A room name well beyond thirty-two characters" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ASSIGN_FAILED");
      expect(r.error.message).toContain("32 characters or fewer");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("PATCH 404 -> DEVICE_NOT_FOUND; other non-OK -> ASSIGN_FAILED", async () => {
    const get404 = roomsList([DEN]);
    const patch404 = vi
      .fn()
      .mockResolvedValue(jsonRes({ error: "room_not_found", message: "room not found" }, 404));
    const { ctx: ctx404 } = ctxWith({ get: get404, patch: patch404 });
    const r404 = await assignDeviceRoom.handler({ device: "the lamp", room: "Den" }, ctx404);
    expect(r404.ok).toBe(false);
    if (!r404.ok) expect(r404.error.code).toBe("DEVICE_NOT_FOUND");

    const get500 = roomsList([DEN]);
    const patch500 = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const { ctx: ctx500 } = ctxWith({ get: get500, patch: patch500 });
    const r500 = await assignDeviceRoom.handler({ device: "the lamp", room: "Den" }, ctx500);
    expect(r500.ok).toBe(false);
    if (!r500.ok) expect(r500.error.code).toBe("ASSIGN_FAILED");
  });
});
