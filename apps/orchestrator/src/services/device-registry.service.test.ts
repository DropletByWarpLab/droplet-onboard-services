/**
 * WARP-81: tests for the DHCP/wireless reconciler.
 *
 * Follows the in-memory-map + vi.fn() Prisma mock pattern used in
 * src/__tests__/device-clients.test.ts. The reconciler is constructed
 * with an injected OUI lookup so we can assert vendor resolution
 * without touching the real CSV.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDeviceRegistry } from "./device-registry.service.js";
import type { OuiLookup } from "./oui-lookup.service.js";
import { RouterError } from "../types/router-error.js";

type DeviceRow = {
  mac: string;
  vendor: string | null;
  hostname: string | null;
  lastIp: string | null;
  firstSeen: Date;
  lastSeen: Date;
  isBlocked: boolean;
};

type PresenceRow = {
  mac: string;
  date: Date;
  seenMinutes: number;
};

function makePrismaMock() {
  const devices = new Map<string, DeviceRow>();
  const presence = new Map<string, PresenceRow>();

  const presenceKey = (mac: string, date: Date) =>
    `${mac}|${date.toISOString().slice(0, 10)}`;

  const networkDevice = {
    findUnique: vi.fn(async ({ where }: any) => devices.get(where.mac) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = devices.get(where.mac);
      if (existing) {
        // Build new row: copy existing, overlay only defined fields from update.
        const merged: DeviceRow = { ...existing };
        for (const [k, v] of Object.entries(update)) {
          if (v !== undefined) (merged as any)[k] = v;
        }
        devices.set(where.mac, merged);
        return merged;
      }
      const row: DeviceRow = {
        mac: create.mac,
        vendor: create.vendor ?? null,
        hostname: create.hostname ?? null,
        lastIp: create.lastIp ?? null,
        firstSeen: create.firstSeen,
        lastSeen: create.lastSeen,
        isBlocked: create.isBlocked ?? false,
      };
      devices.set(create.mac, row);
      return row;
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = devices.get(where.mac);
      if (!row) throw new Error("not found");
      devices.delete(where.mac);
      // Cascade presence rows.
      for (const k of Array.from(presence.keys())) {
        if (presence.get(k)!.mac === where.mac) presence.delete(k);
      }
      return row;
    }),
  };

  const devicePresenceDay = {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const { mac, date } = where.mac_date;
      const k = presenceKey(mac, date);
      const existing = presence.get(k);
      if (existing) {
        const inc = update.seenMinutes?.increment ?? 0;
        existing.seenMinutes += inc;
        return existing;
      }
      const row: PresenceRow = {
        mac: create.mac,
        date: create.date,
        seenMinutes: create.seenMinutes ?? 0,
      };
      presence.set(k, row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const cutoff: Date = where.date.lt;
      let count = 0;
      for (const [k, row] of Array.from(presence.entries())) {
        if (row.date.getTime() < cutoff.getTime()) {
          presence.delete(k);
          count++;
        }
      }
      return { count };
    }),
  };

  return {
    prisma: { networkDevice, devicePresenceDay } as any,
    devices,
    presence,
  };
}

function makeOuiLookup(table: Record<string, string>): OuiLookup {
  return {
    lookup(mac: string): string | null {
      const prefix = mac.replace(/[:\-.]/g, "").slice(0, 6).toUpperCase();
      return table[prefix] ?? null;
    },
  };
}

describe("device-registry.service", () => {
  let prisma: ReturnType<typeof makePrismaMock>["prisma"];
  let devices: ReturnType<typeof makePrismaMock>["devices"];
  let presence: ReturnType<typeof makePrismaMock>["presence"];
  let reg: ReturnType<typeof createDeviceRegistry>;

  beforeEach(() => {
    const mock = makePrismaMock();
    prisma = mock.prisma;
    devices = mock.devices;
    presence = mock.presence;
    reg = createDeviceRegistry(prisma, makeOuiLookup({ F81EDF: "Apple Inc" }));
  });

  it("first-sight: upserts a new MAC with vendor resolved + firstSeen set", async () => {
    await reg.reconcile({
      leases: [{ mac: "f8:1e:df:aa:bb:cc", ip: "10.0.0.42", hostname: "mbp" }],
      wirelessClients: [],
      firewallRules: [],
      pollIntervalMs: 10_000,
    });

    const row = devices.get("F8:1E:DF:AA:BB:CC");
    expect(row).toBeDefined();
    expect(row!.vendor).toBe("Apple Inc");
    expect(row!.lastIp).toBe("10.0.0.42");
    expect(row!.hostname).toBe("mbp");
    expect(row!.firstSeen).toBeInstanceOf(Date);
    expect(row!.lastSeen).toBeInstanceOf(Date);
    expect(row!.isBlocked).toBe(false);
  });

  it("existing device: updates lastSeen + lastIp, preserves firstSeen", async () => {
    const originalFirstSeen = new Date("2026-01-01T00:00:00Z");
    devices.set("F8:1E:DF:AA:BB:CC", {
      mac: "F8:1E:DF:AA:BB:CC",
      vendor: "Apple Inc",
      hostname: "old-name",
      lastIp: "10.0.0.1",
      firstSeen: originalFirstSeen,
      lastSeen: originalFirstSeen,
      isBlocked: false,
    });

    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.99", hostname: "new-name" }],
      wirelessClients: [],
      firewallRules: [],
      pollIntervalMs: 10_000,
    });

    const row = devices.get("F8:1E:DF:AA:BB:CC")!;
    expect(row.firstSeen.getTime()).toBe(originalFirstSeen.getTime());
    expect(row.lastIp).toBe("10.0.0.99");
    expect(row.hostname).toBe("new-name");
    expect(row.lastSeen.getTime()).toBeGreaterThan(originalFirstSeen.getTime());
  });

  it("block-state cascade: an active REJECT rule sets isBlocked = true", async () => {
    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" }],
      wirelessClients: [],
      firewallRules: [{ srcMac: "f8:1e:df:aa:bb:cc" }],
      pollIntervalMs: 10_000,
    });
    expect(devices.get("F8:1E:DF:AA:BB:CC")!.isBlocked).toBe(true);
  });

  it("block-state preserved when firewall fetch returns a RouterError", async () => {
    devices.set("F8:1E:DF:AA:BB:CC", {
      mac: "F8:1E:DF:AA:BB:CC",
      vendor: "Apple Inc",
      hostname: null,
      lastIp: "10.0.0.1",
      firstSeen: new Date("2026-01-01"),
      lastSeen: new Date("2026-01-01"),
      isBlocked: true,
    });

    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" }],
      wirelessClients: [],
      firewallRules: RouterError.unreachable("firewall down", { label: "firewall" }),
      pollIntervalMs: 10_000,
    });

    // Prior block state must NOT be silently cleared.
    expect(devices.get("F8:1E:DF:AA:BB:CC")!.isBlocked).toBe(true);
  });

  it("presence increment: seenMinutes grows by poll-delta", async () => {
    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" }],
      wirelessClients: [],
      firewallRules: [],
      pollIntervalMs: 60_000, // 1 minute
    });
    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" }],
      wirelessClients: [],
      firewallRules: [],
      pollIntervalMs: 60_000,
    });

    const rows = Array.from(presence.values()).filter(
      (r) => r.mac === "F8:1E:DF:AA:BB:CC"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].seenMinutes).toBe(2);
  });

  it("dedupes multiple observations of the same MAC in one reconcile call", async () => {
    await reg.reconcile({
      leases: [
        { mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" },
        { mac: "f8-1e-df-aa-bb-cc", ip: "10.0.0.1" },
      ],
      wirelessClients: [{ mac: "F81EDF.AABBCC" }],
      firewallRules: [],
      pollIntervalMs: 10_000,
    });

    expect(prisma.networkDevice.upsert).toHaveBeenCalledTimes(1);
    expect(devices.size).toBe(1);
  });

  it("skips multicast/broadcast MACs", async () => {
    await reg.reconcile({
      leases: [{ mac: "FF:FF:FF:FF:FF:FF", ip: "10.0.0.1" }],
      wirelessClients: [{ mac: "01:00:5E:00:00:FB" }],
      firewallRules: [],
      pollIntervalMs: 10_000,
    });
    expect(prisma.networkDevice.upsert).not.toHaveBeenCalled();
    expect(devices.size).toBe(0);
  });

  it("forgetDevice(mac) deletes the row", async () => {
    devices.set("F8:1E:DF:AA:BB:CC", {
      mac: "F8:1E:DF:AA:BB:CC",
      vendor: "Apple Inc",
      hostname: null,
      lastIp: "10.0.0.1",
      firstSeen: new Date(),
      lastSeen: new Date(),
      isBlocked: false,
    });

    await reg.forgetDevice("f8:1e:df:aa:bb:cc");
    expect(devices.has("F8:1E:DF:AA:BB:CC")).toBe(false);
  });

  it("purgePresenceRows(30) deletes rows older than 30 days, keeps newer", async () => {
    const now = Date.now();
    const day = 86_400_000;
    presence.set("MAC1|2026-01-01", {
      mac: "MAC1",
      date: new Date(now - 40 * day),
      seenMinutes: 5,
    });
    presence.set("MAC2|2026-04-15", {
      mac: "MAC2",
      date: new Date(now - 1 * day),
      seenMinutes: 10,
    });

    const result = await reg.purgePresenceRows(30);
    expect(result.count).toBe(1);
    expect(presence.has("MAC2|2026-04-15")).toBe(true);
    expect(presence.has("MAC1|2026-01-01")).toBe(false);
  });
});
