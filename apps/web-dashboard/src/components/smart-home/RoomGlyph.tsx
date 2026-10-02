"use client";

/**
 * WARP-1396 — maps a room's stored icon slug to its lucide glyph. The slug set
 * is the server's ROOM_ICONS allowlist, so an unknown value can only come
 * from data drift — falls back to Building2.
 */

import {
  Home,
  Sofa,
  BedDouble,
  ChefHat,
  Bath,
  Monitor,
  Car,
  Trees,
  Baby,
  Dumbbell,
  WashingMachine,
  DoorOpen,
  Building2,
  Presentation,
  Coffee,
  Server,
  Warehouse,
  Factory,
  Package,
  Printer,
  type LucideIcon,
} from "lucide-react";

const GLYPHS: Record<string, LucideIcon> = {
  home: Home,
  sofa: Sofa,
  bed: BedDouble,
  "chef-hat": ChefHat,
  bath: Bath,
  monitor: Monitor,
  car: Car,
  trees: Trees,
  baby: Baby,
  dumbbell: Dumbbell,
  "washing-machine": WashingMachine,
  "door-open": DoorOpen,
  "building-2": Building2,
  presentation: Presentation,
  coffee: Coffee,
  server: Server,
  warehouse: Warehouse,
  factory: Factory,
  package: Package,
  printer: Printer,
};

export function RoomGlyph({ icon, size = 20 }: { icon: string; size?: number }) {
  const Glyph = GLYPHS[icon] ?? Building2;
  return <Glyph size={size} />;
}
