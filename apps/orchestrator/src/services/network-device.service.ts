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
import {
  withSwrCache as defaultWithSwrCache,
  invalidatePrefix as defaultInvalidatePrefix,
} from "./cache.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("network-device");

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
  /**
   * Every station the box can see, from the router's radios AND from each
   * approved coverage AP's own assoclist (WARP-1715). `viaApMac` names the AP
   * a station joined through; absent means the router's own radio. Without the
   * AP legs, devices on a standalone AP's Wi-Fi appeared wired with no signal —
   * they hold a router lease but appear in no router assoclist.
   */
  wirelessClients: Array<{ mac: string; signal?: number; viaApMac?: string }>;
}

export type LiveSnapshotFn = () => Promise<LiveSnapshot>;

/**
 * WARP-90: cache adapter injected into the service. The default
 * implementation delegates to the Redis-backed helpers in
 * `cache.service.ts`; tests pass a no-op variant (or a controllable fake)
 * so the existing behavioral assertions never observe a stale read and
 * so the new read-through-write-through tests can verify producer
 * invocation counts.
 */
export interface NetworkDeviceCache {
  withSwrCache<T>(
    key: string,
    ttlSec: number,
    producer: () => Promise<T>,
  ): Promise<T>;
  invalidatePrefix(prefix: string): Promise<number>;
}

/** Passthrough cache — producer every time, no invalidation side effects. */
export const noopNetworkDeviceCache: NetworkDeviceCache = {
  withSwrCache: async (_key, _ttl, producer) => producer(),
  invalidatePrefix: async () => 0,
};

const defaultNetworkDeviceCache: NetworkDeviceCache = {
  withSwrCache: defaultWithSwrCache,
  invalidatePrefix: defaultInvalidatePrefix,
};

const DEVICE_LIST_PREFIX = "network:devices:";
const GROUP_LIST_PREFIX = "network:groups:";
const LIST_TTL_SEC = 10;

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
  cache: NetworkDeviceCache = defaultNetworkDeviceCache,
) {
  /**
   * WARP-111: single-flight de-dupe for the list reads. Dashboard SWR
   * hooks refresh every 15-30s across every open client; when Redis is
   * down `withSwrCache` degrades to passthrough, so each refresh would
   * otherwise hit Prisma independently and stampede the DB. This map
   * collapses concurrent reads that share a cache key into ONE in-flight
   * promise; the entry is removed in `.finally` (covering BOTH resolve and
   * reject) so a settled or failed read never gets replayed to later
   * callers. Keyed on the same cache key the SWR layer uses, so each
   * distinct opts combination keeps its own flight.
   */
  const inFlight = new Map<string, Promise<unknown>>();

  /**
   * Canonical MACs -> identity of the access points Droplet itself provisions.
   *
   * WARP-1712 used this to HIDE APs from the devices grid, on the reasoning
   * that the same hardware in two places invites renaming it in one and being
   * confused by the other. WARP-1715 keeps the concern but not the remedy
   * (founder call, 2026-08-04): an AP IS part of the household network and
   * should be visible there — so the row is kept and FLAGGED
   * (`isAccessPoint`), and the dashboard renders it in its own "Network
   * infrastructure" group rather than mixed among the laptops. The Coverage
   * Extenders panel remains the place you manage it.
   *
   * Never throws. The filter is cosmetic — an AP that slips through is a
   * duplicated row, whereas a rejection here would 500 the entire Devices
   * page. That trade only goes one way. It also keeps every caller's Prisma
   * stub from having to grow a table just to satisfy a display filter.
   */
  async function infraApIndex(): Promise<Map<string, { name: string; model: string | null }>> {
    const index = new Map<string, { name: string; model: string | null }>();
    try {
      const rows = await prisma.apDevice.findMany({
        where: { backend: "DROPLET_IMAGE" },
        select: { mac: true, displayName: true, model: true },
      });
      // Both tables store canonical MACs (every ingress goes through
      // `normalizeMac`), but re-normalise anyway so a row written by an
      // older/looser path can't slip the index on case or separators.
      for (const ap of rows) {
        const mac = safeNormalize(ap.mac);
        if (!mac) continue;
        index.set(mac, {
          name: ap.displayName?.trim() || ap.model?.trim() || "Access point",
          model: ap.model,
        });
      }
    } catch (err) {
      logger.warn(
        { err },
        "network-device: AP table unreadable; access points render as ordinary devices",
      );
    }
    return index;
  }

  function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = run().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  async function listDevices(
    opts: { onlineOnly?: boolean; groupId?: string } = {},
  ) {
    // Stable key: encodes the two opt dimensions that actually change the
    // result shape. Kept deliberately short + readable so Redis output is
    // easy to eyeball in ops. See WARP-90.
    const onlineSegment = opts.onlineOnly ? "online" : "all";
    const groupSegment = opts.groupId ?? "none";
    const cacheKey = `${DEVICE_LIST_PREFIX}list:${onlineSegment}:${groupSegment}`;

    return singleFlight(cacheKey, () =>
    cache.withSwrCache(cacheKey, LIST_TTL_SEC, async () => {
      const where = opts.groupId
        ? { groups: { some: { id: opts.groupId } } }
        : undefined;

      const [rows, snap, infraAps] = await Promise.all([
        prisma.networkDevice.findMany({
          where,
          include: { groups: true },
        }),
        liveSnapshot().catch(() => ({ leases: [], wirelessClients: [] })),
        // WARP-1712: our own flashed access points are INFRASTRUCTURE, not
        // clients. They take a DHCP lease like anything else, so the
        // reconciler rightly creates a NetworkDevice row for them — but
        // rendering that row in the devices grid puts the same hardware in
        // two places, where an operator can rename it in one and be confused
        // by the other. The Coverage Extenders panel owns them; this list
        // hides them.
        //
        // Scoped to DROPLET_IMAGE on purpose: those are the APs Droplet
        // provisions and fully controls, so the extenders panel really is a
        // complete home for them. A UNIFI / EASYMESH AP is third-party gear
        // the operator may legitimately want to see, block or group as a
        // network device, so those rows stay visible.
        //
        // Degrades rather than throwing: this read only drives a COSMETIC
        // filter, so if the AP table can't be reached the right outcome is
        // "the AP shows up in the list too", not a 500 that takes the whole
        // Devices page down with it. Same posture as `liveSnapshot()` above.
        infraApIndex(),
      ]);

      // Build a MAC -> signal lookup from wireless clients (normalized).
      const signalByMac = new Map<string, number | undefined>();
      const viaApByMac = new Map<string, string>();
      for (const w of snap.wirelessClients) {
        const mac = safeNormalize(w.mac);
        if (!mac) continue;
        signalByMac.set(mac, w.signal);
        // WARP-1715: name the AP a station joined through, so a device on the
        // AP's radio stops looking wired.
        const apMac = w.viaApMac ? safeNormalize(w.viaApMac) : null;
        if (apMac) viaApByMac.set(mac, infraAps.get(apMac)?.name ?? apMac);
      }

      const now = Date.now();
      const enriched = rows.map((row) => {
        const online = row.lastSeen.getTime() > now - ONLINE_WINDOW_MS;
        const signal = signalByMac.get(row.mac);
        const ap = infraAps.get(row.mac);
        return {
          ...row,
          // WARP-106: computed display flag. `lastAppliedBlocked` is the
          // ticker-authored source of truth; fall back to `manualBlock`
          // (user intent) before the ticker has ever run. There is no
          // reconciler-authored `isBlocked` column anymore.
          isBlocked: row.lastAppliedBlocked ?? row.manualBlock,
          online,
          signal,
          // WARP-1715 — an unnamed AP row rendered as "Unknown" beside the
          // household's laptops. Never overwrite a name the operator set.
          displayName: row.displayName ?? ap?.name ?? null,
          isAccessPoint: Boolean(ap),
          apModel: ap?.model ?? null,
          /** The AP this device joined through, or null on the router's radio. */
          viaAp: viaApByMac.get(row.mac) ?? null,
        };
      });

      return opts.onlineOnly ? enriched.filter((d) => d.online) : enriched;
    }),
    );
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
    // WARP-106: attach the computed display flag (see listDevices).
    return {
      device: {
        ...device,
        isBlocked: device.lastAppliedBlocked ?? device.manualBlock,
      },
      presence: device.presenceDays ?? [],
    };
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

    const result = await mapPrismaNotFound("Device", () =>
      prisma.networkDevice.update({
        where: { mac },
        data,
      }),
    );
    // WARP-90: metadata patch doesn't touch group membership — only the
    // device-list cache can be stale, so skip the groups prefix.
    await cache.invalidatePrefix(DEVICE_LIST_PREFIX);
    return result;
  }

  async function assignDeviceGroups(macRaw: string, groupIds: string[]) {
    const mac = normalizeMac(macRaw);
    const result = await mapPrismaNotFound("Device", () =>
      prisma.networkDevice.update({
        where: { mac },
        data: { groups: { set: groupIds.map((id) => ({ id })) } },
        include: { groups: true },
      }),
    );
    // Membership change affects device rows (embedded groups[]) AND the
    // group _count.devices aggregate returned by listGroups.
    await Promise.all([
      cache.invalidatePrefix(DEVICE_LIST_PREFIX),
      cache.invalidatePrefix(GROUP_LIST_PREFIX),
    ]);
    return result;
  }

  async function listGroups() {
    const cacheKey = `${GROUP_LIST_PREFIX}list`;
    // WARP-111: same single-flight collapse as listDevices — the groups
    // list shape is uniform and read-only, so the dedupe is transparent.
    return singleFlight(cacheKey, () =>
      cache.withSwrCache(cacheKey, LIST_TTL_SEC, () =>
        prisma.deviceGroup.findMany({
          include: { _count: { select: { devices: true } } },
        }),
      ),
    );
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
    const result = await prisma.deviceGroup.create({ data });
    // New group → group list is stale; device rows inherit groups[] in
    // their payload so conservative invalidation covers both prefixes.
    await Promise.all([
      cache.invalidatePrefix(DEVICE_LIST_PREFIX),
      cache.invalidatePrefix(GROUP_LIST_PREFIX),
    ]);
    return result;
  }

  async function renameGroup(
    id: string,
    patch: { name?: string; color?: string; icon?: string; blockPhoneHome?: boolean },
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
    // WARP-613: per-group phone-home flag. The egress reconciler enforces it.
    if (patch.blockPhoneHome !== undefined) data.blockPhoneHome = patch.blockPhoneHome;
    const result = await mapPrismaNotFound("Group", () =>
      prisma.deviceGroup.update({ where: { id }, data }),
    );
    // Group rename/recolor leaks into the embedded groups[] array on
    // every device row that references it — invalidate both prefixes.
    await Promise.all([
      cache.invalidatePrefix(DEVICE_LIST_PREFIX),
      cache.invalidatePrefix(GROUP_LIST_PREFIX),
    ]);
    return result;
  }

  async function deleteGroup(id: string) {
    // Prisma cascades the implicit join table; NetworkDevice rows stay.
    const result = await mapPrismaNotFound("Group", () =>
      prisma.deviceGroup.delete({ where: { id } }),
    );
    await Promise.all([
      cache.invalidatePrefix(DEVICE_LIST_PREFIX),
      cache.invalidatePrefix(GROUP_LIST_PREFIX),
    ]);
    return result;
  }

  async function forgetDevice(macRaw: string) {
    const mac = normalizeMac(macRaw);
    const result = await mapPrismaNotFound("Device", () =>
      prisma.networkDevice.delete({ where: { mac } }),
    );
    // Removing a device shrinks _count.devices on every group it belonged
    // to, so wipe both prefixes.
    await Promise.all([
      cache.invalidatePrefix(DEVICE_LIST_PREFIX),
      cache.invalidatePrefix(GROUP_LIST_PREFIX),
    ]);
    return result;
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
