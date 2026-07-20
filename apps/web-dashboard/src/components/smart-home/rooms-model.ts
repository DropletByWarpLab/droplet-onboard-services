/**
 * WARP-1396 — the pure room-grouping model for the Devices surface.
 *
 * The page's primary grouping switches from category to rooms; category order
 * is kept WITHIN each room's grid (lights first). "No room yet" collects the
 * unassigned devices and always sorts last. Kept free of React so the ordering
 * and bulk-lights logic are unit-testable.
 */

import type { MatterDevice, MatterGrouped, Room, SmartHomeCategory } from "@/lib/types";

/** Category order within a room's grid (brief §5.1 — lights first). */
export const CATEGORY_ORDER: SmartHomeCategory[] = [
  "light",
  "switch",
  "cover",
  "fan",
  "lock",
  "media_player",
  "climate",
  "sensor",
  "binary_sensor",
  "camera",
  "vacuum",
];

/** The room bulk switch operates on lights + plugs only (brief §5.2) — never
 *  locks, covers, or media. */
export const BULK_CATEGORIES: SmartHomeCategory[] = ["light", "switch"];

/** The 12 room glyphs offered on create (brief §5.4); value must match the
 *  server's ROOM_ICONS allowlist. */
export const ROOM_GLYPHS: Array<{ icon: string; suggests: string }> = [
  { icon: "sofa", suggests: "Living room" },
  { icon: "bed", suggests: "Bedroom" },
  { icon: "chef-hat", suggests: "Kitchen" },
  { icon: "bath", suggests: "Bathroom" },
  { icon: "monitor", suggests: "Office" },
  { icon: "car", suggests: "Garage" },
  { icon: "trees", suggests: "Garden" },
  { icon: "baby", suggests: "Nursery" },
  { icon: "dumbbell", suggests: "Gym" },
  { icon: "washing-machine", suggests: "Laundry" },
  { icon: "door-open", suggests: "Hallway" },
  { icon: "home", suggests: "Home" },
];

export const SUGGESTED_ROOMS = [
  "Living room",
  "Kitchen",
  "Bedroom",
  "Office",
  "Bathroom",
  "Garage",
];

/** The name a household sees: the alias if set, else the product name, else
 *  the Matter-reported name. */
export function displayName(device: MatterDevice): string {
  return device.friendlyName?.trim() || device.productName?.trim() || device.name;
}

/** Flatten the sidecar's grouped-by-category shape into one device list. */
export function flattenGrouped(grouped: MatterGrouped): MatterDevice[] {
  return [
    ...grouped.lights,
    ...grouped.switches,
    ...grouped.covers,
    ...grouped.climate,
    ...grouped.media,
    ...grouped.locks,
    ...grouped.sensors,
    ...grouped.other,
  ];
}

function byCategory(a: MatterDevice, b: MatterDevice): number {
  const ia = CATEGORY_ORDER.indexOf(a.category);
  const ib = CATEGORY_ORDER.indexOf(b.category);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}

export interface RoomBucket {
  room: Room;
  devices: MatterDevice[];
}

export interface RoomLayout {
  rooms: RoomBucket[];
  /** Devices with no room — the "No room yet" section (always rendered last). */
  unassigned: MatterDevice[];
}

/**
 * Group a flat device list into room buckets (in the rooms' sortOrder) plus an
 * unassigned bucket. Empty rooms are KEPT (they render an empty tile, §6.4);
 * devices inside each bucket are ordered by category (lights first).
 */
export function groupByRoom(devices: MatterDevice[], rooms: Room[]): RoomLayout {
  const sorted = [...rooms].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const buckets = new Map<string, MatterDevice[]>();
  sorted.forEach((r) => buckets.set(r.id, []));
  const unassigned: MatterDevice[] = [];

  for (const d of devices) {
    if (d.roomId && buckets.has(d.roomId)) buckets.get(d.roomId)!.push(d);
    else unassigned.push(d);
  }

  return {
    rooms: sorted.map((room) => ({
      room,
      devices: (buckets.get(room.id) ?? []).sort(byCategory),
    })),
    unassigned: unassigned.sort(byCategory),
  };
}

/** Reachable lights/switches a room's bulk switch operates on. */
export function bulkLights(devices: MatterDevice[]): MatterDevice[] {
  return devices.filter(
    (d) =>
      BULK_CATEGORIES.includes(d.category) &&
      d.connectionState === "connected",
  );
}

/** The bulk switch reads ON if ANY of the room's reachable lights is on. */
export function anyLightOn(devices: MatterDevice[]): boolean {
  return bulkLights(devices).some(
    (d) => d.state === "on" || d.attributes.onOff === true,
  );
}
