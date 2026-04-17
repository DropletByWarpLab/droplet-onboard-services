/**
 * WARP-82: network-device service — business logic behind the
 * `/network/devices` and `/network/groups` REST API.
 *
 * Built on top of the Prisma `NetworkDevice` / `DeviceGroup` /
 * `DevicePresenceDay` models introduced in WARP-80 and populated by the
 * reconciler (WARP-81). The reconciler owns the write path for presence
 * + `lastSeen`; this service owns the user-facing read path and all the
 * user-curated mutations (displayName / icon / notes / group membership).
 *
 * Live overlay: `listDevices` merges the current routing-service snapshot
 * (DHCP leases + wireless clients) so the dashboard can show signal
 * strength without blocking on the reconciler's poll cadence. A device is
 * classified `online` if it's been seen within the last 2 minutes.
 *
 * Error model: every expected failure surfaces as a `DeviceRegistryError`
 * with the codes defined in `types/device-registry-error.ts` — the route
 * layer maps those to HTTP status codes via `err.status`. Unexpected
 * failures fall through `next(err)` to the generic error middleware.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { DeviceRegistryError } from "../types/device-registry-error.js";
import { normalizeMac } from "../lib/mac.js";

/**
 * Prisma's `update` and `delete` throw `PrismaClientKnownRequestError` with
 * code `P2025` when the target row does not exist. Left unhandled these
 * bubble out as 500s — for a dashboard user deleting or editing a stale
 * ID the right surface is a clean 404. This helper re-wraps P2025 into a
 * `DeviceRegistryError.notFound(<what>)` so the route layer maps it to
 * 404 via the usual `err.status` path; every other error passes through
 * untouched.
 */
function mapPrismaNotFound<T>(what: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      throw DeviceRegistryError.notFound(what);
    }
    throw err;
  });
}

/**
 * Spec §6.1: icon allowlist. Dashboard renders lucide-react icons; this
 * set is the curated subset we expose in the picker. Anything else gets
 * a 400 so future UI drift can't silently persist junk into the column.
 */
export const ICON_ALLOWLIST = new Set([
  "Tv",
  "Smartphone",
  "Laptop",
  "Tablet",
  "Router",
  "Speaker",
  "Camera",
  "Lightbulb",
  "Gamepad",
  "Monitor",
  "Printer",
  "Watch",
  "Thermometer",
  "Lock",
  "Headphones",
  "Mouse",
  "Keyboard",
  "Radio",
  "Disc",
  "HelpCircle",
]);

const ONLINE_WINDOW_MS = 2 * 60_000;

export interface LiveSnapshot {
  leases: Array<{ mac: string; ip: string; hostname?: string }>;
  wirelessClients: Array<{ mac: string; signal?: number }>;
}

export type LiveSnapshotFn = () => Promise<LiveSnapshot>;

function safeNormalize(mac: string): string | null {
  try {
    return normalizeMac(mac);
  } catch {
    return null;
  }
}

export function createNetworkDeviceService(
  prisma: PrismaClient,
  liveSnapshot: LiveSnapshotFn,
) {
  async function listDevices(
    opts: { onlineOnly?: boolean; groupId?: string } = {},
  ) {
    const where = opts.groupId
      ? { groups: { some: { id: opts.groupId } } }
      : undefined;

    const [rows, snap] = await Promise.all([
      prisma.networkDevice.findMany({
        where,
        include: { groups: true },
      }),
      liveSnapshot().catch(() => ({ leases: [], wirelessClients: [] })),
    ]);

    // Build a MAC -> signal lookup from wireless clients (normalized).
    const signalByMac = new Map<string, number | undefined>();
    for (const w of snap.wirelessClients) {
      const mac = safeNormalize(w.mac);
      if (mac) signalByMac.set(mac, w.signal);
    }

    const now = Date.now();
    const enriched = rows.map((row: any) => {
      const online = row.lastSeen.getTime() > now - ONLINE_WINDOW_MS;
      const signal = signalByMac.get(row.mac);
      return {
        ...row,
        online,
        signal,
      };
    });

    return opts.onlineOnly ? enriched.filter((d: any) => d.online) : enriched;
  }

  async function getDevice(macRaw: string) {
    const mac = normalizeMac(macRaw);
    const device = await prisma.networkDevice.findUnique({
      where: { mac },
      include: {
        groups: true,
        presenceDays: { orderBy: { date: "desc" }, take: 30 },
      },
    });
    if (!device) {
      throw DeviceRegistryError.notFound(`Device ${mac}`);
    }
    return { device, presence: (device as any).presenceDays ?? [] };
  }

  async function updateDevice(
    macRaw: string,
    patch: { displayName?: string; icon?: string; notes?: string },
  ) {
    if (patch.icon !== undefined && !ICON_ALLOWLIST.has(patch.icon)) {
      throw DeviceRegistryError.invalidIcon(patch.icon);
    }
    const mac = normalizeMac(macRaw);
    // Narrow the data object to the keys actually present — avoids
    // Prisma interpreting an explicit `undefined` as a clear-to-null on
    // some client versions, and avoids overwriting notes with undefined.
    const data: Record<string, string | null> = {};
    if (patch.displayName !== undefined) data.displayName = patch.displayName;
    if (patch.icon !== undefined) data.icon = patch.icon;
    if (patch.notes !== undefined) data.notes = patch.notes;

    return mapPrismaNotFound("Device", () =>
      prisma.networkDevice.update({
        where: { mac },
        data,
      }),
    );
  }

  async function assignDeviceGroups(macRaw: string, groupIds: string[]) {
    const mac = normalizeMac(macRaw);
    return mapPrismaNotFound("Device", () =>
      prisma.networkDevice.update({
        where: { mac },
        data: { groups: { set: groupIds.map((id) => ({ id })) } },
        include: { groups: true },
      }),
    );
  }

  async function listGroups() {
    return prisma.deviceGroup.findMany({
      include: { _count: { select: { devices: true } } },
    });
  }

  async function createGroup(name: string, color?: string, icon?: string) {
    const existing = await prisma.deviceGroup.findUnique({ where: { name } });
    if (existing) {
      throw DeviceRegistryError.duplicateGroupName(name);
    }
    // Use Prisma's generated input type so optional scalar columns line up
    // with the `.create()` signature — `Record<string, string>` is not
    // assignable to `DeviceGroupCreateInput`.
    const data: Prisma.DeviceGroupCreateInput = { name };
    if (color !== undefined) data.color = color;
    if (icon !== undefined) data.icon = icon;
    return prisma.deviceGroup.create({ data });
  }

  async function renameGroup(
    id: string,
    patch: { name?: string; color?: string; icon?: string },
  ) {
    if (patch.name !== undefined) {
      const clash = await prisma.deviceGroup.findFirst({
        where: { name: patch.name, NOT: { id } },
      });
      if (clash) {
        throw DeviceRegistryError.duplicateGroupName(patch.name);
      }
    }
    // Use Prisma's generated update input so only declared columns are
    // settable and optional patch fields line up with the update signature.
    const data: Prisma.DeviceGroupUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.color !== undefined) data.color = patch.color;
    if (patch.icon !== undefined) data.icon = patch.icon;
    return mapPrismaNotFound("Group", () =>
      prisma.deviceGroup.update({ where: { id }, data }),
    );
  }

  async function deleteGroup(id: string) {
    // Prisma cascades the implicit join table; NetworkDevice rows stay.
    return mapPrismaNotFound("Group", () =>
      prisma.deviceGroup.delete({ where: { id } }),
    );
  }

  async function forgetDevice(macRaw: string) {
    const mac = normalizeMac(macRaw);
    return mapPrismaNotFound("Device", () =>
      prisma.networkDevice.delete({ where: { mac } }),
    );
  }

  return {
    listDevices,
    getDevice,
    updateDevice,
    assignDeviceGroups,
    listGroups,
    createGroup,
    renameGroup,
    deleteGroup,
    forgetDevice,
  };
}

export type NetworkDeviceService = ReturnType<typeof createNetworkDeviceService>;
