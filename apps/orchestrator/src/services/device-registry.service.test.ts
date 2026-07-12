/**
 * WARP-81 / WARP-106: tests for the DHCP/wireless reconciler.
 *
 * Follows the in-memory-map + vi.fn() Prisma mock pattern used in
 * src/__tests__/device-clients.test.ts. The reconciler is constructed
 * with an injected OUI lookup so we can assert vendor resolution
 * without touching the real CSV, and (WARP-106) an injected logger so we
 * can assert drift-detection warnings without a real pino sink.
 *
 * WARP-106: the reconciler no longer authors any block state. The dropped
 * `isBlocked` column is gone; `manualBlock` (user intent) and
 * `lastAppliedBlocked` (ticker-authored source of truth) are the only block
 * fields, and the ticker is the single writer of `lastAppliedBlocked`. The
 * reconciler is a pure DRIFT DETECTOR — it logs when the live firewall
 * disagrees with the ticker's desired state but never writes block state, so
 * it can never clobber ticker intent (no reconciler-vs-ticker race).
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
  manualBlock: boolean;
  lastAppliedBlocked: boolean | null;
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
        manualBlock: create.manualBlock ?? false,
        lastAppliedBlocked: create.lastAppliedBlocked ?? null,
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

/** Minimal drift-detection logger spy injected into the reconciler. */
function makeLoggerSpy() {
  return { warn: vi.fn(), debug: vi.fn() };
}

describe("device-registry.service", () => {
  let prisma: ReturnType<typeof makePrismaMock>["prisma"];
  let devices: ReturnType<typeof makePrismaMock>["devices"];
  let presence: ReturnType<typeof makePrismaMock>["presence"];
  let logger: ReturnType<typeof makeLoggerSpy>;
  let reg: ReturnType<typeof createDeviceRegistry>;

  beforeEach(() => {
    const mock = makePrismaMock();
    prisma = mock.prisma;
    devices = mock.devices;
    presence = mock.presence;
    logger = makeLoggerSpy();
    reg = createDeviceRegistry(prisma, makeOuiLookup({ F81EDF: "Apple Inc" }), logger);
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
    // Reconciler never authors block state — it defaults from the column.
    expect(row!.manualBlock).toBe(false);
    expect(row!.lastAppliedBlocked).toBeNull();
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
      manualBlock: false,
      lastAppliedBlocked: null,
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

  // ── WARP-106: drift detection (reconciler never authors block state) ──

  it("drift detected: live firewall REJECT vs ticker lastAppliedBlocked=false → warns, does NOT clobber", async () => {
    devices.set("F8:1E:DF:AA:BB:CC", {
      mac: "F8:1E:DF:AA:BB:CC",
      vendor: "Apple Inc",
      hostname: null,
      lastIp: "10.0.0.1",
      firstSeen: new Date("2026-01-01"),
      lastSeen: new Date("2026-01-01"),
      manualBlock: false,
      lastAppliedBlocked: false, // ticker's desired effective state = unblocked
    });

    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" }],
      wirelessClients: [],
      // Live firewall says this MAC IS blocked — disagrees with the ticker.
      firewallRules: [{ srcMac: "f8:1e:df:aa:bb:cc" }],
      pollIntervalMs: 10_000,
    });

    // (a) No clobber — the ticker owns lastAppliedBlocked; reconciler left it.
    expect(devices.get("F8:1E:DF:AA:BB:CC")!.lastAppliedBlocked).toBe(false);
    // (b) Drift was logged with the observed-vs-desired context.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        mac: "F8:1E:DF:AA:BB:CC",
        firewallBlocked: true,
        lastAppliedBlocked: false,
      }),
      expect.stringMatching(/drift/i),
    );
  });

  it("no drift: live firewall agrees with ticker lastAppliedBlocked → silent, no write", async () => {
    devices.set("F8:1E:DF:AA:BB:CC", {
      mac: "F8:1E:DF:AA:BB:CC",
      vendor: "Apple Inc",
      hostname: null,
      lastIp: "10.0.0.1",
      firstSeen: new Date("2026-01-01"),
      lastSeen: new Date("2026-01-01"),
      manualBlock: true,
      lastAppliedBlocked: true, // ticker already applied the block
    });

    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" }],
      wirelessClients: [],
      firewallRules: [{ srcMac: "f8:1e:df:aa:bb:cc" }],
      pollIntervalMs: 10_000,
    });

    expect(devices.get("F8:1E:DF:AA:BB:CC")!.lastAppliedBlocked).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("bootstrap: lastAppliedBlocked=null (ticker never ran) → no drift warning", async () => {
    devices.set("F8:1E:DF:AA:BB:CC", {
      mac: "F8:1E:DF:AA:BB:CC",
      vendor: "Apple Inc",
      hostname: null,
      lastIp: "10.0.0.1",
      firstSeen: new Date("2026-01-01"),
      lastSeen: new Date("2026-01-01"),
      manualBlock: false,
      lastAppliedBlocked: null,
    });

    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" }],
      wirelessClients: [],
      firewallRules: [{ srcMac: "f8:1e:df:aa:bb:cc" }],
      pollIntervalMs: 10_000,
    });

    // Nothing to compare against — ticker hasn't authored a desired state yet.
    expect(devices.get("F8:1E:DF:AA:BB:CC")!.lastAppliedBlocked).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("firewall fetch fails (RouterError): no drift detection, no block write, no throw", async () => {
    devices.set("F8:1E:DF:AA:BB:CC", {
      mac: "F8:1E:DF:AA:BB:CC",
      vendor: "Apple Inc",
      hostname: null,
      lastIp: "10.0.0.1",
      firstSeen: new Date("2026-01-01"),
      lastSeen: new Date("2026-01-01"),
      manualBlock: true,
      lastAppliedBlocked: true,
    });

    await reg.reconcile({
      leases: [{ mac: "F8:1E:DF:AA:BB:CC", ip: "10.0.0.1" }],
      wirelessClients: [],
      firewallRules: RouterError.unreachable("firewall down", { label: "firewall" }),
      pollIntervalMs: 10_000,
    });

    // We can't observe live firewall state, so we can't detect drift and we
    // never touch the ticker-owned field.
    expect(devices.get("F8:1E:DF:AA:BB:CC")!.lastAppliedBlocked).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
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
      manualBlock: false,
      lastAppliedBlocked: null,
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
