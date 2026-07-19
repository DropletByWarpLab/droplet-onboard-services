/**
 * WARP-1396 — rooms + device-alias service unit tests.
 *
 * Drives the CRUD + validation + the device-list join against a small
 * in-memory Prisma stub (two tables as arrays) — no DB. The stub implements
 * exactly the delegate methods the service calls.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  listRooms,
  createRoom,
  updateRoom,
  deleteRoom,
  upsertAlias,
  enrichGrouped,
  normalizeName,
  RoomValidationError,
} from "../rooms.service.js";
import type { MatterGrouped } from "../../types/smart-home.js";

type RoomRow = {
  id: string;
  name: string;
  icon: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};
type AliasRow = { nodeId: string; name: string | null; roomId: string | null; updatedAt: Date };

function makePrisma() {
  const rooms: RoomRow[] = [];
  const aliases: AliasRow[] = [];
  let seq = 0;
  const id = () => `room_${++seq}`;

  const countAliases = (roomId: string) =>
    aliases.filter((a) => a.roomId === roomId).length;

  const prisma = {
    room: {
      findMany: async (args?: any) => {
        let rows = [...rooms];
        if (args?.orderBy) {
          rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
        }
        if (args?.select) {
          return rows.map((r) => ({ id: r.id, name: r.name }));
        }
        return rows.map((r) => ({ ...r, _count: { aliases: countAliases(r.id) } }));
      },
      findUnique: async (args: any) => rooms.find((r) => r.id === args.where.id) ?? null,
      aggregate: async () => ({
        _max: { sortOrder: rooms.reduce((m, r) => Math.max(m, r.sortOrder), 0) },
      }),
      create: async (args: any) => {
        const row: RoomRow = {
          id: id(),
          name: args.data.name,
          icon: args.data.icon,
          sortOrder: args.data.sortOrder,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        rooms.push(row);
        return row;
      },
      update: async (args: any) => {
        const r = rooms.find((x) => x.id === args.where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, args.data);
        return { ...r, _count: { aliases: countAliases(r.id) } };
      },
      delete: async (args: any) => {
        const i = rooms.findIndex((x) => x.id === args.where.id);
        if (i < 0) throw new Error("not found");
        const [removed] = rooms.splice(i, 1);
        // FK onDelete: SetNull
        aliases.forEach((a) => {
          if (a.roomId === removed.id) a.roomId = null;
        });
        return removed;
      },
    },
    deviceAlias: {
      findUnique: async (args: any) =>
        aliases.find((a) => a.nodeId === args.where.nodeId) ?? null,
      findMany: async () => [...aliases],
      upsert: async (args: any) => {
        const existing = aliases.find((a) => a.nodeId === args.where.nodeId);
        if (existing) {
          Object.assign(existing, args.update, { updatedAt: new Date(0) });
          return existing;
        }
        const row: AliasRow = { ...args.create, updatedAt: new Date(0) };
        aliases.push(row);
        return row;
      },
      delete: async (args: any) => {
        const i = aliases.findIndex((a) => a.nodeId === args.where.nodeId);
        if (i >= 0) aliases.splice(i, 1);
        return {};
      },
    },
  };
  return prisma as unknown as PrismaClient;
}

let prisma: PrismaClient;
beforeEach(() => {
  prisma = makePrisma();
});

describe("normalizeName", () => {
  it("trims, strips control characters, and caps at 32", () => {
    expect(normalizeName("  Kitchen  ")).toBe("Kitchen");
    expect(normalizeName("Kitchen")).toBe("Kitchen");
    expect(() => normalizeName("x".repeat(33))).toThrow(RoomValidationError);
    expect(() => normalizeName(5 as unknown)).toThrow(RoomValidationError);
  });
});

describe("rooms CRUD", () => {
  it("creates rooms with an incrementing sortOrder and rejects a bad icon", async () => {
    const a = await createRoom(prisma, { name: "Kitchen", icon: "chef-hat" });
    const b = await createRoom(prisma, { name: "Living room" });
    expect(a.icon).toBe("chef-hat");
    expect(b.icon).toBe("home"); // default
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
    await expect(createRoom(prisma, { name: "X", icon: "skull" })).rejects.toThrow(
      RoomValidationError,
    );
    await expect(createRoom(prisma, { name: "   " })).rejects.toThrow(/needs a name/);
  });

  it("lists rooms with device counts and updates name/icon", async () => {
    const k = await createRoom(prisma, { name: "Kitchen" });
    await upsertAlias(prisma, "n1", { roomId: k.id });
    await upsertAlias(prisma, "n2", { roomId: k.id });
    const list = await listRooms(prisma);
    expect(list[0].deviceCount).toBe(2);
    const up = await updateRoom(prisma, k.id, { name: "Cocina", icon: "sofa" });
    expect(up.name).toBe("Cocina");
    expect(up.icon).toBe("sofa");
    expect(up.deviceCount).toBe(2);
  });

  it("deleting a room moves its devices back to no-room (SetNull), never deletes them", async () => {
    const k = await createRoom(prisma, { name: "Kitchen" });
    await upsertAlias(prisma, "n1", { name: "Strip", roomId: k.id });
    await deleteRoom(prisma, k.id);
    const alias = await upsertAlias(prisma, "n1", {}); // read-through
    expect(alias.roomId).toBeNull();
    expect(alias.name).toBe("Strip"); // survives
  });
});

describe("device aliases", () => {
  it("renames and assigns in one call, and prunes an empty alias", async () => {
    const k = await createRoom(prisma, { name: "Kitchen" });
    const a = await upsertAlias(prisma, "n1", { name: "Kitchen strip", roomId: k.id });
    expect(a).toEqual({ nodeId: "n1", name: "Kitchen strip", roomId: k.id });
    // Clear the name AND the room → the row is pruned.
    const cleared = await upsertAlias(prisma, "n1", { name: "", roomId: null });
    expect(cleared).toEqual({ nodeId: "n1", name: null, roomId: null });
    expect(await (prisma as any).deviceAlias.findUnique({ where: { nodeId: "n1" } })).toBeNull();
  });

  it("clears the name via name: null (the pencil 'clear name' path) and keeps the room", async () => {
    const k = await createRoom(prisma, { name: "Kitchen" });
    await upsertAlias(prisma, "n1", { name: "Kitchen strip", roomId: k.id });
    // DeviceDetailPanel.saveName() sends { name: null } when the field is cleared;
    // null must clear the alias name, not throw a 400 (WARP-1396 review fix).
    const cleared = await upsertAlias(prisma, "n1", { name: null });
    expect(cleared).toEqual({ nodeId: "n1", name: null, roomId: k.id });
  });

  it("rejects assigning to a non-existent room", async () => {
    await expect(upsertAlias(prisma, "n1", { roomId: "ghost" })).rejects.toThrow(
      /room not found/,
    );
  });
});

describe("enrichGrouped", () => {
  const dev = (nodeId: string): any => ({
    nodeId,
    name: "Cync Light",
    category: "light",
    state: "on",
    connectionState: "connected",
    endpoints: [],
    attributes: {},
  });
  const empty = (): MatterGrouped => ({
    lights: [],
    switches: [],
    sensors: [],
    climate: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
  });

  it("returns the list untouched when there are no aliases", async () => {
    const g = { ...empty(), lights: [dev("n1")] };
    const out = await enrichGrouped(prisma, g);
    expect(out.lights[0].friendlyName).toBeUndefined();
  });

  it("overlays friendly name + room name onto matching devices", async () => {
    const k = await createRoom(prisma, { name: "Kitchen" });
    await upsertAlias(prisma, "n1", { name: "Strip", roomId: k.id });
    const g = { ...empty(), lights: [dev("n1"), dev("n2")] };
    const out = await enrichGrouped(prisma, g);
    expect(out.lights[0]).toMatchObject({
      friendlyName: "Strip",
      roomId: k.id,
      roomName: "Kitchen",
    });
    // n2 has no alias → no overlay.
    expect(out.lights[1].friendlyName).toBeUndefined();
  });
});
