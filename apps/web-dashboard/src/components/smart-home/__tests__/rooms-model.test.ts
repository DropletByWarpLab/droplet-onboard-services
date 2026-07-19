/**
 * WARP-1396 — the pure room-grouping model.
 */
import { describe, it, expect } from "vitest";
import {
  displayName,
  flattenGrouped,
  groupByRoom,
  bulkLights,
  anyLightOn,
} from "../rooms-model";
import type { MatterDevice, MatterGrouped, Room } from "@/lib/types";

function dev(over: Partial<MatterDevice> = {}): MatterDevice {
  return {
    nodeId: "n",
    name: "Cync Light",
    category: "light",
    state: "off",
    connectionState: "connected",
    endpoints: [],
    attributes: {},
    ...over,
  } as MatterDevice;
}

function grouped(over: Partial<MatterGrouped> = {}): MatterGrouped {
  return {
    lights: [],
    switches: [],
    sensors: [],
    climate: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
    ...over,
  };
}

const room = (id: string, name: string, sortOrder = 0): Room => ({
  id,
  name,
  icon: "home",
  sortOrder,
  deviceCount: 0,
});

describe("displayName", () => {
  it("prefers the alias, then the product name, then the Matter name", () => {
    expect(displayName(dev({ friendlyName: "Kitchen strip", productName: "Cync X", name: "Node" }))).toBe(
      "Kitchen strip",
    );
    expect(displayName(dev({ friendlyName: null, productName: "Cync X", name: "Node" }))).toBe("Cync X");
    expect(displayName(dev({ friendlyName: null, productName: undefined, name: "Node" }))).toBe("Node");
  });
});

describe("groupByRoom", () => {
  it("buckets devices by room in sortOrder, keeps empty rooms, and collects the rest as unassigned", () => {
    const rooms = [room("kitchen", "Kitchen", 2), room("living", "Living room", 1), room("empty", "Office", 3)];
    const devices = [
      dev({ nodeId: "a", roomId: "kitchen" }),
      dev({ nodeId: "b", roomId: "living" }),
      dev({ nodeId: "c", roomId: null }),
      dev({ nodeId: "d", roomId: "ghost" }), // stale room → unassigned
    ];
    const layout = groupByRoom(devices, rooms);
    expect(layout.rooms.map((r) => r.room.id)).toEqual(["living", "kitchen", "empty"]);
    expect(layout.rooms[0].devices.map((d) => d.nodeId)).toEqual(["b"]);
    expect(layout.rooms[2].devices).toEqual([]); // empty room kept
    expect(layout.unassigned.map((d) => d.nodeId).sort()).toEqual(["c", "d"]);
  });

  it("orders devices within a room by category (lights first)", () => {
    const rooms = [room("k", "Kitchen")];
    const devices = [
      dev({ nodeId: "lock", category: "lock", roomId: "k" }),
      dev({ nodeId: "light", category: "light", roomId: "k" }),
      dev({ nodeId: "cover", category: "cover", roomId: "k" }),
    ];
    const layout = groupByRoom(devices, rooms);
    expect(layout.rooms[0].devices.map((d) => d.nodeId)).toEqual(["light", "cover", "lock"]);
  });
});

describe("bulk lights", () => {
  it("counts only reachable lights/switches and reports on if any is on", () => {
    const devices = [
      dev({ nodeId: "l1", category: "light", state: "on" }),
      dev({ nodeId: "l2", category: "light", state: "off" }),
      dev({ nodeId: "lock", category: "lock", state: "locked" }),
      dev({ nodeId: "off", category: "light", connectionState: "disconnected", state: "on" }),
    ];
    expect(bulkLights(devices).map((d) => d.nodeId)).toEqual(["l1", "l2"]);
    expect(anyLightOn(devices)).toBe(true);
    expect(anyLightOn([dev({ category: "light", state: "off" })])).toBe(false);
  });
});

describe("flattenGrouped", () => {
  it("flattens the category buckets into one list", () => {
    const g = grouped({ lights: [dev({ nodeId: "a" })], locks: [dev({ nodeId: "b", category: "lock" })] });
    expect(flattenGrouped(g).map((d) => d.nodeId).sort()).toEqual(["a", "b"]);
  });
});
