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
  // WARP-106: no `isBlocked` column. `manualBlock` (intent) +
  // `lastAppliedBlocked` (ticker-authored source of truth) are the only
  // block fields; the service computes `isBlocked` for the API boundary.
  manualBlock: boolean;
  lastAppliedBlocked: boolean | null;
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
  // WARP-1712: ApDevice rows, keyed by canonical MAC.
  const apDevices = new Map<
    string,
    { mac: string; backend: string; displayName?: string | null; model?: string | null }
  >();

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

  // WARP-1712: `listDevices` reads the AP table so our own flashed access
  // points are hidden from the client-devices grid (they belong to the
  // Coverage Extenders panel). Seed rows via `apDevices` in a test.
  const apDevice = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(apDevices.values());
      if (args.where?.backend) {
        rows = rows.filter((r) => r.backend === args.where.backend);
      }
      return rows.map((r) => ({
        displayName: null,
        model: null,
        ...r,
      }));
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
    prisma: { networkDevice, deviceGroup, apDevice } as any,
    devices,
    groups,
    presence,
    apDevices,
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
    manualBlock: partial.manualBlock ?? false,
    lastAppliedBlocked: partial.lastAppliedBlocked ?? null,
    groupIds: partial.groupIds ?? [],
  };
}

describe("network-device.service", () => {
  let prisma: ReturnType<typeof makePrismaMock>["prisma"];
  let devices: ReturnType<typeof makePrismaMock>["devices"];
  let groups: ReturnType<typeof makePrismaMock>["groups"];
  let presence: ReturnType<typeof makePrismaMock>["presence"];
  let apDevices: ReturnType<typeof makePrismaMock>["apDevices"];
  let svc: ReturnType<typeof createNetworkDeviceService>;
  let snapshot: {
    leases: Array<{ mac: string; ip: string; hostname?: string }>;
    wirelessClients: Array<{ mac: string; signal?: number; viaApMac?: string }>;
  };

  beforeEach(() => {
    const mock = makePrismaMock();
    prisma = mock.prisma;
    devices = mock.devices;
    groups = mock.groups;
    presence = mock.presence;
    apDevices = mock.apDevices;
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

    // WARP-106: the API boundary exposes a computed
    // `isBlocked = (lastAppliedBlocked ?? manualBlock)`.
    it("computes isBlocked from lastAppliedBlocked (ticker) falling back to manualBlock", async () => {
      devices.set("AA:BB:CC:DD:EE:01", makeDevice({
        mac: "AA:BB:CC:DD:EE:01",
        lastAppliedBlocked: true,
        manualBlock: false,
      }));
      devices.set("AA:BB:CC:DD:EE:02", makeDevice({
        mac: "AA:BB:CC:DD:EE:02",
        lastAppliedBlocked: null,
        manualBlock: true,
      }));
      devices.set("AA:BB:CC:DD:EE:03", makeDevice({
        mac: "AA:BB:CC:DD:EE:03",
        lastAppliedBlocked: false,
        manualBlock: true,
      }));

      const list = await svc.listDevices();
      const by = new Map<string, any>(list.map((d: any) => [d.mac as string, d]));
      expect(by.get("AA:BB:CC:DD:EE:01")!.isBlocked).toBe(true);
      expect(by.get("AA:BB:CC:DD:EE:02")!.isBlocked).toBe(true);
      // ticker is source of truth — applied=false overrides stale intent.
      expect(by.get("AA:BB:CC:DD:EE:03")!.isBlocked).toBe(false);
    });

    /**
     * WARP-1712 flagged our own flashed APs so they could be HIDDEN from the
     * devices grid — the same hardware in two places invites renaming it in
     * one and being confused by the other.
     *
     * WARP-1715 keeps the concern but not the remedy (founder call,
     * 2026-08-04): an AP IS part of the household network and belongs in this
     * list, so the row is kept and FLAGGED, and the dashboard renders it in a
     * separate "Network infrastructure" section instead of between two phones.
     */
    describe("access points as network infrastructure", () => {
      it("keeps a DROPLET_IMAGE access point in the list, flagged", async () => {
        devices.set("AA:BB:CC:DD:EE:01", makeDevice({ mac: "AA:BB:CC:DD:EE:01" }));
        devices.set("AA:BB:CC:DD:EE:A0", makeDevice({ mac: "AA:BB:CC:DD:EE:A0" }));
        apDevices.set("AA:BB:CC:DD:EE:A0", {
          mac: "AA:BB:CC:DD:EE:A0",
          backend: "DROPLET_IMAGE",
          displayName: "Living-room AP",
          model: "NWA50BE",
        });

        const list = await svc.listDevices();
        const by = new Map(list.map((d: any) => [d.mac, d]));
        expect(by.size).toBe(2);
        expect(by.get("AA:BB:CC:DD:EE:A0")!.isAccessPoint).toBe(true);
        expect(by.get("AA:BB:CC:DD:EE:A0")!.displayName).toBe("Living-room AP");
        expect(by.get("AA:BB:CC:DD:EE:A0")!.apModel).toBe("NWA50BE");
        expect(by.get("AA:BB:CC:DD:EE:01")!.isAccessPoint).toBe(false);
      });

      it("never overwrites a name the operator set on the AP", async () => {
        devices.set("AA:BB:CC:DD:EE:A0", makeDevice({
          mac: "AA:BB:CC:DD:EE:A0",
          displayName: "Upstairs",
        }));
        apDevices.set("AA:BB:CC:DD:EE:A0", {
          mac: "AA:BB:CC:DD:EE:A0",
          backend: "DROPLET_IMAGE",
          displayName: "Living-room AP",
        });

        const [ap] = await svc.listDevices();
        expect(ap.displayName).toBe("Upstairs");
        expect((ap as any).isAccessPoint).toBe(true);
      });

      it("falls back to the model, then a generic label, for an unnamed AP", async () => {
        devices.set("AA:BB:CC:DD:EE:A0", makeDevice({ mac: "AA:BB:CC:DD:EE:A0" }));
        apDevices.set("AA:BB:CC:DD:EE:A0", {
          mac: "AA:BB:CC:DD:EE:A0",
          backend: "DROPLET_IMAGE",
          model: "NWA50BE",
        });
        expect((await svc.listDevices())[0].displayName).toBe("NWA50BE");

        apDevices.set("AA:BB:CC:DD:EE:A0", {
          mac: "AA:BB:CC:DD:EE:A0",
          backend: "DROPLET_IMAGE",
        });
        expect((await svc.listDevices())[0].displayName).toBe("Access point");
      });

      it("normalises case and separators before matching", async () => {
        devices.set("AA:BB:CC:DD:EE:AB", makeDevice({ mac: "AA:BB:CC:DD:EE:AB" }));
        // A row written by a looser path — lowercase, dash-separated.
        apDevices.set("legacy", {
          mac: "aa-bb-cc-dd-ee-ab",
          backend: "DROPLET_IMAGE",
        });

        const [row] = await svc.listDevices();
        expect((row as any).isAccessPoint).toBe(true);
      });

      it("leaves third-party (UniFi / EasyMesh) APs as ordinary devices", async () => {
        // Not ours to fully control, so they stay client devices the operator
        // can see, block and group — the explicit backend filter is the gate.
        devices.set("AA:BB:CC:DD:EE:C1", makeDevice({ mac: "AA:BB:CC:DD:EE:C1" }));
        apDevices.set("AA:BB:CC:DD:EE:C1", {
          mac: "AA:BB:CC:DD:EE:C1",
          backend: "UNIFI",
        });

        const [row] = await svc.listDevices();
        expect((row as any).isAccessPoint).toBe(false);
      });

      it("keeps the AP under onlineOnly and groupId filters", async () => {
        devices.set("AA:BB:CC:DD:EE:A0", makeDevice({
          mac: "AA:BB:CC:DD:EE:A0",
          lastSeen: new Date(),
          groupIds: ["grp-a"],
        }));
        apDevices.set("AA:BB:CC:DD:EE:A0", {
          mac: "AA:BB:CC:DD:EE:A0",
          backend: "DROPLET_IMAGE",
        });

        expect(await svc.listDevices({ onlineOnly: true })).toHaveLength(1);
        expect(await svc.listDevices({ groupId: "grp-a" })).toHaveLength(1);
      });

      it("attributes a station to the AP it joined through", async () => {
        // WARP-1715: the router's assoclist doesn't contain stations on a
        // standalone AP's radios, so they used to read as wired with no signal.
        devices.set("AA:BB:CC:00:00:01", makeDevice({
          mac: "AA:BB:CC:00:00:01",
          lastSeen: new Date(),
        }));
        apDevices.set("AA:BB:CC:DD:EE:A0", {
          mac: "AA:BB:CC:DD:EE:A0",
          backend: "DROPLET_IMAGE",
          displayName: "Living-room AP",
        });
        snapshot.wirelessClients = [
          { mac: "aa:bb:cc:00:00:01", signal: -58, viaApMac: "aa-bb-cc-dd-ee-a0" },
        ];

        const [phone] = await svc.listDevices();
        expect(phone.signal).toBe(-58);
        expect((phone as any).viaAp).toBe("Living-room AP");
      });

      it("leaves viaAp null for a station on the router's own radio", async () => {
        devices.set("AA:BB:CC:00:00:01", makeDevice({
          mac: "AA:BB:CC:00:00:01",
          lastSeen: new Date(),
        }));
        snapshot.wirelessClients = [{ mac: "AA:BB:CC:00:00:01", signal: -40 }];

        const [phone] = await svc.listDevices();
        expect((phone as any).viaAp).toBeNull();
      });

      it("falls back to the MAC when the station names an AP we don't know", async () => {
        // Honest degradation: an unrecognised AP MAC is still better
        // attribution than silently calling the device wired.
        devices.set("AA:BB:CC:00:00:01", makeDevice({
          mac: "AA:BB:CC:00:00:01",
          lastSeen: new Date(),
        }));
        snapshot.wirelessClients = [
          { mac: "AA:BB:CC:00:00:01", signal: -58, viaApMac: "DE:AD:BE:EF:00:01" },
        ];

        const [phone] = await svc.listDevices();
        expect((phone as any).viaAp).toBe("DE:AD:BE:EF:00:01");
      });

      it("leaves the list untouched when no APs are onboarded", async () => {
        devices.set("AA:BB:CC:DD:EE:01", makeDevice({ mac: "AA:BB:CC:DD:EE:01" }));
        const list = await svc.listDevices();
        expect(list).toHaveLength(1);
        expect((list[0] as any).isAccessPoint).toBe(false);
      });

      it("degrades the FLAG, not the page, when the AP table is unreadable", async () => {
        // The join is cosmetic. Losing it means an AP renders as an ordinary
        // device; throwing would 500 the whole Devices page. That trade only
        // goes one way.
        devices.set("AA:BB:CC:DD:EE:01", makeDevice({ mac: "AA:BB:CC:DD:EE:01" }));
        prisma.apDevice.findMany = vi.fn().mockRejectedValue(new Error("db down"));

        const list = await svc.listDevices();
        expect(list.map((d: any) => d.mac)).toEqual(["AA:BB:CC:DD:EE:01"]);
        expect((list[0] as any).isAccessPoint).toBe(false);
      });

      it("degrades when the AP table is missing from the client entirely", async () => {
        devices.set("AA:BB:CC:DD:EE:01", makeDevice({ mac: "AA:BB:CC:DD:EE:01" }));
        // e.g. a generated Prisma client that predates the ApDevice model.
        (prisma as any).apDevice = undefined;

        const list = await svc.listDevices();
        expect(list).toHaveLength(1);
      });
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
      // WARP-106: computed display flag present on the single-device read.
      expect(result.device.isBlocked).toBe(false);
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

  /**
   * WARP-111: single-flight de-dupe. When Redis is down `withSwrCache`
   * degrades to passthrough (the noop cache here models that), so without
   * single-flight every concurrent SWR refresh would hit Prisma. The
   * service must collapse N concurrent identical reads into ONE underlying
   * query. Driven deterministically with a manually-resolved producer so
   * there is no timing flakiness.
   */
  describe("WARP-111 single-flight de-dupe", () => {
    /** A deferred whose Prisma `findMany` only resolves when we say so. */
    function deferredFindMany() {
      let resolveFn!: (rows: any[]) => void;
      const gate = new Promise<any[]>((resolve) => {
        resolveFn = resolve;
      });
      const findMany = vi.fn(async () => gate);
      return { findMany, resolve: () => resolveFn([]) };
    }

    it("collapses N concurrent identical listDevices reads into one Prisma call", async () => {
      const { findMany, resolve } = deferredFindMany();
      prisma.networkDevice.findMany = findMany;

      // Passthrough cache == Redis-down behavior (producer every time).
      const flightSvc = createNetworkDeviceService(
        prisma,
        async () => snapshot,
        noopNetworkDeviceCache,
      );

      // Fire 5 concurrent identical reads before the producer resolves.
      const calls = Array.from({ length: 5 }, () => flightSvc.listDevices());

      // All 5 share ONE in-flight Prisma query.
      expect(findMany).toHaveBeenCalledTimes(1);

      resolve();
      const results = await Promise.all(calls);

      // Every caller observed the same resolved value.
      expect(results).toHaveLength(5);
      for (const r of results) {
        expect(r).toEqual(results[0]);
      }
      // Still exactly one underlying query for the whole burst.
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("clears the in-flight entry once settled so a later read hits Prisma again", async () => {
      const { findMany, resolve } = deferredFindMany();
      prisma.networkDevice.findMany = findMany;

      const flightSvc = createNetworkDeviceService(
        prisma,
        async () => snapshot,
        noopNetworkDeviceCache,
      );

      const first = flightSvc.listDevices();
      expect(findMany).toHaveBeenCalledTimes(1);
      resolve();
      await first;

      // The flight map must have deleted the settled key, so the next read
      // is a fresh Prisma call rather than a stuck stale promise.
      const { findMany: findMany2, resolve: resolve2 } = deferredFindMany();
      prisma.networkDevice.findMany = findMany2;
      const second = flightSvc.listDevices();
      expect(findMany2).toHaveBeenCalledTimes(1);
      resolve2();
      await second;
    });

    it("distinct opts do NOT share a flight (different cache key)", async () => {
      const { findMany, resolve } = deferredFindMany();
      prisma.networkDevice.findMany = findMany;

      const flightSvc = createNetworkDeviceService(
        prisma,
        async () => snapshot,
        noopNetworkDeviceCache,
      );

      // onlineOnly:true and the default share neither key nor flight.
      const a = flightSvc.listDevices({ onlineOnly: true });
      const b = flightSvc.listDevices();
      expect(findMany).toHaveBeenCalledTimes(2);
      resolve();
      await Promise.all([a, b]);
    });

    it("removes the in-flight entry when the producer rejects (failures are not cached)", async () => {
      let rejectFn!: (e: Error) => void;
      const gate = new Promise<any[]>((_resolve, reject) => {
        rejectFn = reject;
      });
      const findMany = vi.fn(async () => gate);
      prisma.networkDevice.findMany = findMany;

      const flightSvc = createNetworkDeviceService(
        prisma,
        async () => snapshot,
        noopNetworkDeviceCache,
      );

      const failing = flightSvc.listDevices();
      expect(findMany).toHaveBeenCalledTimes(1);
      rejectFn(new Error("db down"));
      await expect(failing).rejects.toThrow("db down");

      // A rejected in-flight promise must be evicted — the retry hits Prisma
      // again instead of replaying the cached rejection.
      const findMany2 = vi.fn(async () => []);
      prisma.networkDevice.findMany = findMany2;
      await flightSvc.listDevices();
      expect(findMany2).toHaveBeenCalledTimes(1);
    });
  });
});
