/**
 * WARP-82: tests for the network-device service.
 *
 * Uses the in-memory-map Prisma mock pattern (same one that powers
 * device-registry.service.test.ts) so we can drive the service through
 * real CRUD semantics without a live Postgres. The `liveSnapshot`
 * callback is injected so tests control the wireless-signal overlay
 * that drives online classification.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import {
  createNetworkDeviceService,
  noopNetworkDeviceCache,
  type NetworkDeviceCache,
} from "./network-device.service.js";
import { DeviceRegistryError } from "../types/device-registry-error.js";

/**
 * Builds a realistic P2025 error the same way Prisma throws it internally
 * when `update` / `delete` can't find the target row. Kept in a helper so
 * every NOT_FOUND mapping test reads uniformly.
 */
function p2025(): Error {
  return new Prisma.PrismaClientKnownRequestError("Not found", {
    code: "P2025",
    clientVersion: "test",
  });
}

type DeviceRow = {
  mac: string;
  displayName: string | null;
  icon: string | null;
  notes: string | null;
  vendor: string | null;
  hostname: string | null;
  lastIp: string | null;
  firstSeen: Date;
  lastSeen: Date;
  isBlocked: boolean;
  groupIds: string[];
};

type GroupRow = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
};

type PresenceRow = {
  mac: string;
  date: Date;
  seenMinutes: number;
};

function makePrismaMock() {
  const devices = new Map<string, DeviceRow>();
  const groups = new Map<string, GroupRow>();
  const presence: PresenceRow[] = [];

  function hydrateDevice(row: DeviceRow, include?: any): any {
    const out: any = { ...row };
    if (include?.groups) {
      out.groups = row.groupIds
        .map((id) => groups.get(id))
        .filter((g): g is GroupRow => g !== undefined);
    }
    if (include?.presenceDays) {
      const opts = include.presenceDays;
      let rows = presence.filter((p) => p.mac === row.mac);
      if (opts.orderBy?.date === "desc") {
        rows = rows.slice().sort((a, b) => b.date.getTime() - a.date.getTime());
      }
      if (opts.take) rows = rows.slice(0, opts.take);
      out.presenceDays = rows;
    }
    return out;
  }

  const networkDevice = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(devices.values());
      if (args.where?.groups?.some?.id) {
        const id = args.where.groups.some.id;
        rows = rows.filter((r) => r.groupIds.includes(id));
      }
      return rows.map((r) => hydrateDevice(r, args.include));
    }),
    findUnique: vi.fn(async ({ where, include }: any) => {
      const row = devices.get(where.mac);
      if (!row) return null;
      return hydrateDevice(row, include);
    }),
    update: vi.fn(async ({ where, data, include }: any) => {
      const row = devices.get(where.mac);
      if (!row) throw new Error("not found");
      if (data.displayName !== undefined) row.displayName = data.displayName;
      if (data.icon !== undefined) row.icon = data.icon;
      if (data.notes !== undefined) row.notes = data.notes;
      if (data.groups?.set) {
        row.groupIds = data.groups.set.map((g: { id: string }) => g.id);
      }
      return hydrateDevice(row, include);
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = devices.get(where.mac);
      if (!row) throw new Error("not found");
      devices.delete(where.mac);
      return row;
    }),
  };

  let groupIdSeq = 0;
  const deviceGroup = {
    findMany: vi.fn(async (args: any = {}) => {
      return Array.from(groups.values()).map((g) => {
        const base: any = { ...g };
        if (args.include?._count?.select?.devices) {
          base._count = {
            devices: Array.from(devices.values()).filter((d) =>
              d.groupIds.includes(g.id),
            ).length,
          };
        }
        return base;
      });
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.name !== undefined) {
        for (const g of groups.values()) {
          if (g.name === where.name) return g;
        }
        return null;
      }
      if (where.id !== undefined) return groups.get(where.id) ?? null;
      return null;
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      for (const g of groups.values()) {
        if (where?.name !== undefined && g.name !== where.name) continue;
        if (where?.NOT?.id !== undefined && g.id === where.NOT.id) continue;
        return g;
      }
      return null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const id = data.id ?? `grp-${++groupIdSeq}`;
      const row: GroupRow = {
        id,
        name: data.name,
        color: data.color ?? null,
        icon: data.icon ?? null,
      };
      groups.set(id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = groups.get(where.id);
      if (!row) throw new Error("not found");
      if (data.name !== undefined) row.name = data.name;
      if (data.color !== undefined) row.color = data.color;
      if (data.icon !== undefined) row.icon = data.icon;
      return row;
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = groups.get(where.id);
      if (!row) throw new Error("not found");
      groups.delete(where.id);
      // Cascade: devices remain but their groupIds are filtered.
      for (const d of devices.values()) {
        d.groupIds = d.groupIds.filter((id) => id !== where.id);
      }
      return row;
    }),
  };

  return {
    prisma: { networkDevice, deviceGroup } as any,
    devices,
    groups,
    presence,
  };
}

function makeDevice(partial: Partial<DeviceRow> & { mac: string }): DeviceRow {
  return {
    mac: partial.mac,
    displayName: partial.displayName ?? null,
    icon: partial.icon ?? null,
    notes: partial.notes ?? null,
    vendor: partial.vendor ?? null,
    hostname: partial.hostname ?? null,
    lastIp: partial.lastIp ?? null,
    firstSeen: partial.firstSeen ?? new Date(),
    lastSeen: partial.lastSeen ?? new Date(),
    isBlocked: partial.isBlocked ?? false,
    groupIds: partial.groupIds ?? [],
  };
}

describe("network-device.service", () => {
  let prisma: ReturnType<typeof makePrismaMock>["prisma"];
  let devices: ReturnType<typeof makePrismaMock>["devices"];
  let groups: ReturnType<typeof makePrismaMock>["groups"];
  let presence: ReturnType<typeof makePrismaMock>["presence"];
  let svc: ReturnType<typeof createNetworkDeviceService>;
  let snapshot: {
    leases: Array<{ mac: string; ip: string; hostname?: string }>;
    wirelessClients: Array<{ mac: string; signal?: number }>;
  };

  beforeEach(() => {
    const mock = makePrismaMock();
    prisma = mock.prisma;
    devices = mock.devices;
    groups = mock.groups;
    presence = mock.presence;
    snapshot = { leases: [], wirelessClients: [] };
    // Pass the no-op cache explicitly so these tests keep observing the
    // direct Prisma-backed behavior they were written against. The
    // default Redis-backed cache degrades to passthrough in the test
    // environment anyway (REDIS_URL unset), but being explicit keeps the
    // test intent obvious.
    svc = createNetworkDeviceService(
      prisma,
      async () => snapshot,
      noopNetworkDeviceCache,
    );
  });

  describe("listDevices", () => {
    it("enriches devices with live signals and classifies online correctly", async () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 30_000); // 30s ago -> online
      const stale = new Date(now.getTime() - 10 * 60_000); // 10min ago -> offline

      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        lastSeen: recent,
      }));
      devices.set("AA:BB:CC:DD:EE:02", makeDevice({
        mac: "AA:BB:CC:DD:EE:02",
        lastSeen: stale,
      }));

      snapshot.wirelessClients = [
        { mac: "aa:bb:cc:dd:ee:01", signal: -55 },
      ];

      const list = await svc.listDevices();
      const by = new Map<string, any>(list.map((d: any) => [d.mac as string, d]));
      expect(by.get("AA:BB:CC:DD:EE:01")!.online).toBe(true);
      expect(by.get("AA:BB:CC:DD:EE:01")!.signal).toBe(-55);
      expect(by.get("AA:BB:CC:DD:EE:02")!.online).toBe(false);
      expect(by.get("AA:BB:CC:DD:EE:02")!.signal).toBeUndefined();
    });

    it("filters offline rows when onlineOnly=true", async () => {
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        lastSeen: new Date(),
      }));
      devices.set("AA:BB:CC:DD:EE:02", makeDevice({
        mac: "AA:BB:CC:DD:EE:02",
        lastSeen: new Date(Date.now() - 10 * 60_000),
      }));

      const list = await svc.listDevices({ onlineOnly: true });
      expect(list).toHaveLength(1);
      expect(list[0].mac).toBe("AA:BB:CC:DD:EE:01");
    });

    it("returns only group members when groupId is provided", async () => {
      groups.set("grp-living", { id: "grp-living", name: "Living", color: null, icon: null });
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        groupIds: ["grp-living"],
      }));
      devices.set("AA:BB:CC:DD:EE:02", makeDevice({
        mac: "AA:BB:CC:DD:EE:02",
        groupIds: [],
      }));

      const list = await svc.listDevices({ groupId: "grp-living" });
      expect(list).toHaveLength(1);
      expect(list[0].mac).toBe("AA:BB:CC:DD:EE:01");
    });
  });

  describe("getDevice", () => {
    it("returns device + last 30 presence rows (desc)", async () => {
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({ mac: "AA:BB:CC:DD:EE:01" }));
      // seed 35 presence rows, newest first after desc ordering
      const day = 86_400_000;
      const now = Date.now();
      for (let i = 0; i < 35; i++) {
        presence.push({
          mac: "AA:BB:CC:DD:EE:01",
          date: new Date(now - i * day),
          seenMinutes: 5,
        });
      }

      const result = await svc.getDevice("aa:bb:cc:dd:ee:01");
      expect(result.device.mac).toBe("AA:BB:CC:DD:EE:01");
      expect(result.presence).toHaveLength(30);
      // newest first
      expect(result.presence[0].date.getTime()).toBeGreaterThan(
        result.presence[1].date.getTime(),
      );
    });

    it("throws NOT_FOUND when the device is missing", async () => {
      await expect(svc.getDevice("AA:BB:CC:DD:EE:99")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });

  describe("updateDevice", () => {
    it("persists a valid icon from the allowlist", async () => {
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({ mac: "AA:BB:CC:DD:EE:01" }));
      await svc.updateDevice("aa:bb:cc:dd:ee:01", {
        displayName: "Living TV",
        icon: "Tv",
        notes: "65 inch",
      });
      const row = devices.get("AA:BB:CC:DD:EE:01")!;
      expect(row.displayName).toBe("Living TV");
      expect(row.icon).toBe("Tv");
      expect(row.notes).toBe("65 inch");
    });

    it("throws INVALID_ICON when icon is not in the allowlist", async () => {
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({ mac: "AA:BB:CC:DD:EE:01" }));
      await expect(
        svc.updateDevice("aa:bb:cc:dd:ee:01", { icon: "BogusIcon" }),
      ).rejects.toBeInstanceOf(DeviceRegistryError);
      await expect(
        svc.updateDevice("aa:bb:cc:dd:ee:01", { icon: "BogusIcon" }),
      ).rejects.toMatchObject({ code: "INVALID_ICON" });
    });
  });

  describe("assignDeviceGroups", () => {
    it("replaces the group set on the device", async () => {
      groups.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      groups.set("grp-b", { id: "grp-b", name: "B", color: null, icon: null });
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        groupIds: ["grp-a"],
      }));

      await svc.assignDeviceGroups("aa:bb:cc:dd:ee:01", ["grp-b"]);
      const row = devices.get("AA:BB:CC:DD:EE:01")!;
      expect(row.groupIds).toEqual(["grp-b"]);
    });
  });

  describe("createGroup", () => {
    it("throws DUPLICATE_GROUP_NAME when the name is taken", async () => {
      groups.set("grp-living", {
        id: "grp-living",
        name: "Living Room",
        color: null,
        icon: null,
      });
      await expect(svc.createGroup("Living Room")).rejects.toMatchObject({
        code: "DUPLICATE_GROUP_NAME",
      });
    });

    it("creates a new group when the name is unique", async () => {
      const g = await svc.createGroup("Office", "#336699", "Laptop");
      expect(g.name).toBe("Office");
      expect(g.color).toBe("#336699");
      expect(g.icon).toBe("Laptop");
    });
  });

  describe("renameGroup", () => {
    it("throws DUPLICATE_GROUP_NAME when another group already uses the new name", async () => {
      groups.set("grp-a", { id: "grp-a", name: "Living Room", color: null, icon: null });
      groups.set("grp-b", { id: "grp-b", name: "Bedroom", color: null, icon: null });

      await expect(
        svc.renameGroup("grp-b", { name: "Living Room" }),
      ).rejects.toMatchObject({ code: "DUPLICATE_GROUP_NAME" });
    });
  });

  describe("deleteGroup", () => {
    it("deletes the group; devices remain intact (just ungrouped)", async () => {
      groups.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        groupIds: ["grp-a"],
      }));

      await svc.deleteGroup("grp-a");
      expect(groups.has("grp-a")).toBe(false);
      expect(devices.has("AA:BB:CC:DD:EE:01")).toBe(true);
      expect(devices.get("AA:BB:CC:DD:EE:01")!.groupIds).toEqual([]);
    });
  });

  describe("forgetDevice", () => {
    it("deletes the device row", async () => {
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({ mac: "AA:BB:CC:DD:EE:01" }));
      await svc.forgetDevice("aa:bb:cc:dd:ee:01");
      expect(devices.has("AA:BB:CC:DD:EE:01")).toBe(false);
    });
  });

  /**
   * P2025 → DeviceRegistryError(NOT_FOUND) mapping. Without the service
   * layer helper these would bubble out as 500s through Express — the
   * route layer only branches on `DeviceRegistryError`.
   */
  describe("Prisma P2025 → NOT_FOUND mapping", () => {
    async function expectNotFound(promise: Promise<unknown>): Promise<void> {
      try {
        await promise;
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DeviceRegistryError);
        expect((e as DeviceRegistryError).code).toBe("NOT_FOUND");
      }
    }

    it("updateDevice on missing MAC throws DeviceRegistryError NOT_FOUND", async () => {
      prisma.networkDevice.update = vi.fn().mockRejectedValue(p2025());
      await expectNotFound(
        svc.updateDevice("AA:BB:CC:DD:EE:FF", { displayName: "x" }),
      );
    });

    it("assignDeviceGroups on missing MAC throws DeviceRegistryError NOT_FOUND", async () => {
      prisma.networkDevice.update = vi.fn().mockRejectedValue(p2025());
      await expectNotFound(
        svc.assignDeviceGroups("AA:BB:CC:DD:EE:FF", ["grp-a"]),
      );
    });

    it("forgetDevice on missing MAC throws DeviceRegistryError NOT_FOUND", async () => {
      prisma.networkDevice.delete = vi.fn().mockRejectedValue(p2025());
      await expectNotFound(svc.forgetDevice("AA:BB:CC:DD:EE:FF"));
    });

    it("renameGroup on missing id throws DeviceRegistryError NOT_FOUND", async () => {
      prisma.deviceGroup.update = vi.fn().mockRejectedValue(p2025());
      await expectNotFound(svc.renameGroup("grp-missing", { name: "Fresh" }));
    });

    it("deleteGroup on missing id throws DeviceRegistryError NOT_FOUND", async () => {
      prisma.deviceGroup.delete = vi.fn().mockRejectedValue(p2025());
      await expectNotFound(svc.deleteGroup("grp-missing"));
    });
  });

  describe("listGroups", () => {
    it("includes _count.devices", async () => {
      groups.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        groupIds: ["grp-a"],
      }));
      devices.set("AA:BB:CC:DD:EE:02", makeDevice({
        mac: "AA:BB:CC:DD:EE:02",
        groupIds: ["grp-a"],
      }));

      const list = (await svc.listGroups()) as any[];
      expect(list).toHaveLength(1);
      expect(list[0]._count.devices).toBe(2);
    });
  });

  /**
   * WARP-90: read → write → read cycle. Verifies that the cache layer is
   * actually wired in (producer hit on miss, served on hit) AND that
   * write-through invalidation forces the next read to re-run the
   * producer rather than serve a 10s-stale payload.
   */
  describe("WARP-90 SWR cache integration", () => {
    function makeFakeCache(): NetworkDeviceCache & {
      store: Map<string, string>;
    } {
      const store = new Map<string, string>();
      return {
        store,
        withSwrCache: async (key, _ttl, producer) => {
          const hit = store.get(key);
          if (hit !== undefined) {
            return JSON.parse(hit);
          }
          const value = await producer();
          store.set(key, JSON.stringify(value));
          return value;
        },
        invalidatePrefix: async (prefix) => {
          let n = 0;
          for (const k of Array.from(store.keys())) {
            if (k.startsWith(prefix)) {
              store.delete(k);
              n++;
            }
          }
          return n;
        },
      };
    }

    it("serves from cache on repeat reads and refreshes after a write", async () => {
      const cache = makeFakeCache();
      const findMany = prisma.networkDevice.findMany as unknown as ReturnType<
        typeof vi.fn
      >;
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        lastSeen: new Date(),
      }));

      const cached = createNetworkDeviceService(
        prisma,
        async () => snapshot,
        cache,
      );

      const beforeCalls = findMany.mock.calls.length;

      // 1st call — producer runs, result cached.
      await cached.listDevices();
      expect(findMany.mock.calls.length).toBe(beforeCalls + 1);

      // 2nd call with identical opts — served from cache, no Prisma hit.
      await cached.listDevices();
      expect(findMany.mock.calls.length).toBe(beforeCalls + 1);

      // Write path invalidates the devices prefix.
      await cached.updateDevice("aa:bb:cc:dd:ee:01", { displayName: "Fresh" });

      // 3rd call — producer runs again, surfaces the new displayName.
      const fresh = await cached.listDevices();
      expect(findMany.mock.calls.length).toBe(beforeCalls + 2);
      expect(fresh[0].displayName).toBe("Fresh");
    });

    it("invalidates both prefixes on group-membership mutations", async () => {
      const cache = makeFakeCache();
      groups.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        groupIds: [],
      }));

      const cached = createNetworkDeviceService(
        prisma,
        async () => snapshot,
        cache,
      );

      await cached.listDevices();
      await cached.listGroups();
      expect(
        Array.from(cache.store.keys()).some((k) =>
          k.startsWith("network:devices:"),
        ),
      ).toBe(true);
      expect(
        Array.from(cache.store.keys()).some((k) =>
          k.startsWith("network:groups:"),
        ),
      ).toBe(true);

      await cached.assignDeviceGroups("aa:bb:cc:dd:ee:01", ["grp-a"]);

      // Both prefixes wiped — next reads will re-run their producers.
      expect(
        Array.from(cache.store.keys()).some((k) =>
          k.startsWith("network:devices:"),
        ),
      ).toBe(false);
      expect(
        Array.from(cache.store.keys()).some((k) =>
          k.startsWith("network:groups:"),
        ),
      ).toBe(false);
    });
  });
});
