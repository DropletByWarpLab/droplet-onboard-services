/**
 * WARP-1396 — device rooms + aliases (the household map).
 *
 * Rooms and aliases are Droplet-LOCAL data (orchestrator Postgres), never
 * Matter fabric state. `enrichGrouped` overlays each device's friendly name +
 * room onto the sidecar device list at read time — the sidecar stays the
 * fabric-state owner, this layer only adds household identity. Renames never
 * write the Matter `nodeLabel` (bridged ecosystems fight over it), so the
 * alias survives re-commissioning.
 */

import type { PrismaClient } from "@prisma/client";
import type { MatterGrouped, Room } from "../types/smart-home.js";

/** The 12 room glyphs the UI offers (brief §5.4) — validated server-side so a
 *  bad value can never reach the client's icon map. */
export const ROOM_ICONS = [
  "home",
  "sofa",
  "bed",
  "chef-hat",
  "bath",
  "monitor",
  "car",
  "trees",
  "baby",
  "dumbbell",
  "washing-machine",
  "door-open",
] as const;

export class RoomValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_room",
  ) {
    super(message);
    this.name = "RoomValidationError";
  }
}

/** Strip ASCII control characters (0x00-0x1f, 0x7f) without a control-char
 *  regex literal (keeps the linter happy and source edits robust). */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/** Names (rooms + device aliases) share one rule: 1–32 chars, trimmed, no
 *  control characters. Empty → caller decides (clear alias, or reject room). */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new RoomValidationError("name must be a string");
  }
  const name = stripControl(raw).trim();
  if (name.length > 32) {
    throw new RoomValidationError("name must be 32 characters or fewer");
  }
  return name;
}

function normalizeIcon(raw: unknown): string {
  if (raw == null) return "home";
  if (typeof raw !== "string" || !ROOM_ICONS.includes(raw as (typeof ROOM_ICONS)[number])) {
    throw new RoomValidationError("icon is not one of the allowed room glyphs");
  }
  return raw;
}

export async function listRooms(prisma: PrismaClient): Promise<Room[]> {
  const rows = await prisma.room.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { aliases: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    sortOrder: r.sortOrder,
    deviceCount: r._count.aliases,
  }));
}

export async function createRoom(
  prisma: PrismaClient,
  input: { name: unknown; icon?: unknown },
): Promise<Room> {
  const name = normalizeName(input.name);
  if (!name) throw new RoomValidationError("a room needs a name");
  const icon = normalizeIcon(input.icon);
  // New rooms sort after the current max (alpha within equal order).
  const max = await prisma.room.aggregate({ _max: { sortOrder: true } });
  const room = await prisma.room.create({
    data: { name, icon, sortOrder: (max._max.sortOrder ?? 0) + 1 },
  });
  return { id: room.id, name: room.name, icon: room.icon, sortOrder: room.sortOrder, deviceCount: 0 };
}

export async function updateRoom(
  prisma: PrismaClient,
  id: string,
  input: { name?: unknown; icon?: unknown; sortOrder?: unknown },
): Promise<Room> {
  const data: { name?: string; icon?: string; sortOrder?: number } = {};
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (!name) throw new RoomValidationError("a room needs a name");
    data.name = name;
  }
  if (input.icon !== undefined) data.icon = normalizeIcon(input.icon);
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== "number" || !Number.isInteger(input.sortOrder)) {
      throw new RoomValidationError("sortOrder must be an integer");
    }
    data.sortOrder = input.sortOrder;
  }
  const room = await prisma.room
    .update({ where: { id }, data, include: { _count: { select: { aliases: true } } } })
    .catch(() => {
      throw new RoomValidationError("room not found", 404, "room_not_found");
    });
  return {
    id: room.id,
    name: room.name,
    icon: room.icon,
    sortOrder: room.sortOrder,
    deviceCount: room._count.aliases,
  };
}

/** Delete a room. Its DeviceAlias rows keep working — the FK `onDelete: SetNull`
 *  moves the devices back to "No room yet" (brief §5.5). */
export async function deleteRoom(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.room.delete({ where: { id } }).catch(() => {
    throw new RoomValidationError("room not found", 404, "room_not_found");
  });
}

/**
 * Upsert a device's household identity — rename and/or (re)assign a room in one
 * call. `name: null` or `""` clears the alias name (reverts to the product
 * name); `roomId: null` moves it to "No room yet". A row with neither a name
 * nor a room is pruned so the table doesn't accumulate empty aliases.
 */
export async function upsertAlias(
  prisma: PrismaClient,
  nodeId: string,
  input: { name?: unknown; roomId?: unknown },
): Promise<{ nodeId: string; name: string | null; roomId: string | null }> {
  const existing = await prisma.deviceAlias.findUnique({ where: { nodeId } });

  let name: string | null = existing?.name ?? null;
  if (input.name !== undefined) {
    const n = normalizeName(input.name);
    name = n.length ? n : null;
  }

  let roomId: string | null = existing?.roomId ?? null;
  if (input.roomId !== undefined) {
    if (input.roomId === null || input.roomId === "") {
      roomId = null;
    } else if (typeof input.roomId === "string") {
      const room = await prisma.room.findUnique({ where: { id: input.roomId } });
      if (!room) throw new RoomValidationError("room not found", 404, "room_not_found");
      roomId = input.roomId;
    } else {
      throw new RoomValidationError("roomId must be a string or null");
    }
  }

  // Nothing left to remember → prune.
  if (name === null && roomId === null) {
    if (existing) await prisma.deviceAlias.delete({ where: { nodeId } });
    return { nodeId, name: null, roomId: null };
  }

  const row = await prisma.deviceAlias.upsert({
    where: { nodeId },
    create: { nodeId, name, roomId },
    update: { name, roomId },
  });
  return { nodeId: row.nodeId, name: row.name, roomId: row.roomId };
}

/**
 * Overlay friendly name + room onto every device in the grouped list. One
 * query for all aliases (there are at most as many as commissioned devices),
 * one for rooms, then a pure in-memory join.
 */
export async function enrichGrouped(
  prisma: PrismaClient,
  grouped: MatterGrouped,
): Promise<MatterGrouped> {
  const aliases = await prisma.deviceAlias.findMany();
  if (aliases.length === 0) return grouped;

  const roomNames = new Map(
    (await prisma.room.findMany({ select: { id: true, name: true } })).map((r) => [r.id, r.name]),
  );
  const byNode = new Map(aliases.map((a) => [a.nodeId, a]));

  const overlay = (list: MatterGrouped["lights"]) =>
    list.map((d) => {
      const a = byNode.get(d.nodeId);
      if (!a) return d;
      return {
        ...d,
        friendlyName: a.name ?? null,
        roomId: a.roomId ?? null,
        roomName: a.roomId ? roomNames.get(a.roomId) ?? null : null,
      };
    });

  return {
    lights: overlay(grouped.lights),
    switches: overlay(grouped.switches),
    sensors: overlay(grouped.sensors),
    climate: overlay(grouped.climate),
    media: overlay(grouped.media),
    covers: overlay(grouped.covers),
    locks: overlay(grouped.locks),
    other: overlay(grouped.other),
  };
}
