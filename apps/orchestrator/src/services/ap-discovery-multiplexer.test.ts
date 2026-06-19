/**
 * ADR-024 Phase 2 — discovery multiplexer + pluggable discovery sources.
 *
 * Phase 1 wired a single mDNS discovery path that always created
 * DROPLET_IMAGE rows. Phase 2 makes discovery pluggable: each
 * `DiscoverySource` produces a snapshot of `DiscoveredApObservation`s,
 * every one tagged with an EXPLICIT `backend` (never inferred —
 * CLAUDE.md no-guessing rule), and the multiplexer fans out all ENABLED
 * sources, merges the snapshots, and reconciles them in one pass.
 *
 * These tests pin Phase-2's invariants:
 *   (1) the multiplexer fans out multiple sources and merges their
 *       observations into a single reconcile call;
 *   (2) an observation tagged EASYMESH (injected via a fake source)
 *       creates an ApDevice row with backend = EASYMESH — proving the
 *       create path honors the per-observation tag, not a hardcode;
 *   (3) the live MdnsDiscoverySource still yields DROPLET_IMAGE
 *       observations (zero behavior delta for the shipping path);
 *   (4) with DROPLET_AP_EASYMESH_ENABLED=0 the EasyMesh scaffold
 *       contributes nothing (and same for UniFi) — both default off,
 *       so a single-box with no extenders behaves byte-for-byte as
 *       Phase 1.
 *
 * Same mocking shape as ap-discovery-poller.test.ts: in-memory Prisma
 * stand-in for ApDevice, narrow source/client stubs, no real timers or
 * sockets.
 */

import { describe, it, expect, vi } from "vitest";
import {
  MdnsDiscoverySource,
  EasyMeshDiscoverySource,
  UniFiDiscoverySource,
  createDiscoveryMultiplexer,
  type DiscoverySource,
} from "./ap-discovery-multiplexer.js";
import type { DiscoveredApObservation } from "./ap-onboard.service.js";

// In-memory ApDevice stand-in — mirrors ap-discovery-poller.test.ts so the
// reconcile path (create honoring obs.backend, LRU eviction) is exercised
// against real ap-onboard.service code, not a stub.
function createPrismaMock() {
  const rows = new Map<string, any>();
  return {
    rows,
    apDevice: {
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.mac) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = rows.get(where.mac);
        if (existing) {
          const merged = { ...existing, ...update, updatedAt: new Date() };
          rows.set(where.mac, merged);
          return merged;
        }
        const row = {
          createdAt: new Date(),
          updatedAt: new Date(),
          firstSeen: new Date(),
          lastSeen: new Date(),
          status: "DISCOVERED",
          ...create,
        };
        rows.set(where.mac, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const existing = rows.get(where.mac);
        if (!existing) {
          const e: any = new Error("not found");
          e.code = "P2025";
          throw e;
        }
        const merged = { ...existing, ...data, updatedAt: new Date() };
        rows.set(where.mac, merged);
        return merged;
      }),
      count: vi.fn(async ({ where }: any = {}) => {
        const statusIn: string[] | undefined = where?.status?.in;
        let n = 0;
        for (const row of rows.values()) {
          if (!statusIn || statusIn.includes(row.status)) n += 1;
        }
        return n;
      }),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

/** A fake source that yields a fixed snapshot — used to inject a backend
 *  tag the live sources can't produce this phase (EASYMESH/UNIFI). */
function fakeSource(
  observations: DiscoveredApObservation[],
): DiscoverySource {
  return { discover: vi.fn(async () => observations) };
}

describe("createDiscoveryMultiplexer (ADR-024 Phase 2)", () => {
  it("fans out multiple sources and merges their observations into one reconcile pass", async () => {
    const prisma = createPrismaMock();
    const srcA = fakeSource([
      { mac: "B8:27:EB:00:00:01", backend: "DROPLET_IMAGE" },
    ]);
    const srcB = fakeSource([
      { mac: "AA:BB:CC:00:00:02", backend: "EASYMESH" },
    ]);

    const mux = createDiscoveryMultiplexer(prisma as any, [srcA, srcB]);
    const result = await mux.discoverAndReconcile();

    // Every enabled source was asked for its snapshot.
    expect(srcA.discover).toHaveBeenCalledTimes(1);
    expect(srcB.discover).toHaveBeenCalledTimes(1);
    // Both observations landed as ApDevice rows in a single reconcile.
    expect(result.created).toBe(2);
    expect(prisma.rows.get("B8:27:EB:00:00:01")).toBeDefined();
    expect(prisma.rows.get("AA:BB:CC:00:00:02")).toBeDefined();
  });

  it("creates an ApDevice row with backend = EASYMESH for an EASYMESH-tagged observation (create honors the tag, not a hardcode)", async () => {
    const prisma = createPrismaMock();
    const src = fakeSource([
      { mac: "AA:BB:CC:DD:EE:FF", backend: "EASYMESH", vendor: "TP-Link" },
    ]);

    const mux = createDiscoveryMultiplexer(prisma as any, [src]);
    await mux.discoverAndReconcile();

    const row = prisma.rows.get("AA:BB:CC:DD:EE:FF");
    expect(row).toBeDefined();
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.backend).toBe("EASYMESH");
  });

  it("the live mDNS source still yields DROPLET_IMAGE rows (zero behavior delta for the shipping path)", async () => {
    const prisma = createPrismaMock();
    const openwrt = {
      listDiscoveredAps: vi.fn(async () => [
        { mac: "B8:27:EB:00:00:42", model: "raspberrypi,5-model-b" },
      ]),
    };
    const mdns = new MdnsDiscoverySource(openwrt);

    const mux = createDiscoveryMultiplexer(prisma as any, [mdns]);
    await mux.discoverAndReconcile();

    const row = prisma.rows.get("B8:27:EB:00:00:42");
    expect(row).toBeDefined();
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.backend).toBe("DROPLET_IMAGE");
  });

  it("a snapshot mixing DROPLET_IMAGE + EASYMESH creates one row per backend tag", async () => {
    const prisma = createPrismaMock();
    const openwrt = {
      listDiscoveredAps: vi.fn(async () => [
        { mac: "B8:27:EB:00:00:01" },
      ]),
    };
    const mdns = new MdnsDiscoverySource(openwrt);
    const easymesh = fakeSource([
      { mac: "AA:BB:CC:00:00:02", backend: "EASYMESH" },
    ]);

    const mux = createDiscoveryMultiplexer(prisma as any, [mdns, easymesh]);
    await mux.discoverAndReconcile();

    expect(prisma.rows.get("B8:27:EB:00:00:01").backend).toBe("DROPLET_IMAGE");
    expect(prisma.rows.get("AA:BB:CC:00:00:02").backend).toBe("EASYMESH");
  });
});

describe("MdnsDiscoverySource (ADR-024 Phase 2 — live source)", () => {
  it("tags every observation DROPLET_IMAGE and maps the snake_case routing fields", async () => {
    const openwrt = {
      listDiscoveredAps: vi.fn(async () => [
        {
          mac: "B8:27:EB:00:00:01",
          model: "raspberrypi,5-model-b",
          serial: "AP-12345",
          version: "1.0",
          last_ip: "192.168.50.42",
          hostname: "droplet-extender-1",
        },
      ]),
    };
    const mdns = new MdnsDiscoverySource(openwrt);
    const observed = await mdns.discover();

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      mac: "B8:27:EB:00:00:01",
      backend: "DROPLET_IMAGE",
      model: "raspberrypi,5-model-b",
      serial: "AP-12345",
      version: "1.0",
      lastIp: "192.168.50.42",
      hostname: "droplet-extender-1",
    });
  });

  it("returns [] when nothing is announcing (no throw, common steady state)", async () => {
    const openwrt = { listDiscoveredAps: vi.fn(async () => []) };
    const mdns = new MdnsDiscoverySource(openwrt);
    expect(await mdns.discover()).toEqual([]);
  });
});

describe("UniFiDiscoverySource (ADR-024 Phase 3 — live source)", () => {
  /** Mock of the typed UniFi client — Phase 3 tests the source/handler
   *  against this, never a real controller (there is none on the laptop). */
  function fakeUniFiClient(pending: any[]) {
    return {
      listPendingDevices: vi.fn(async () => pending),
      adoptDevice: vi.fn(),
      pushWlanConfig: vi.fn(),
      getDeviceStatus: vi.fn(),
      forgetDevice: vi.fn(),
    };
  }

  it("maps the controller pending-adoption list to UNIFI/Ubiquiti observations when enabled", async () => {
    const client = fakeUniFiClient([
      { mac: "aa:bb:cc:00:00:01", deviceId: "u-1", model: "U6-Lite", ip: "192.168.20.50" },
      { mac: "aa:bb:cc:00:00:02", deviceId: "u-2" },
    ]);
    const src = new UniFiDiscoverySource({ enabled: true }, client as any);
    const observed = await src.discover();

    expect(client.listPendingDevices).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({
      mac: "aa:bb:cc:00:00:01",
      backend: "UNIFI",
      vendor: "Ubiquiti",
      backendRef: "u-1",
      model: "U6-Lite",
      lastIp: "192.168.20.50",
    });
    expect(observed[1]).toMatchObject({ mac: "aa:bb:cc:00:00:02", backend: "UNIFI", vendor: "Ubiquiti" });
  });

  it("returns [] when the controller has no pending devices (steady state)", async () => {
    const client = fakeUniFiClient([]);
    const src = new UniFiDiscoverySource({ enabled: true }, client as any);
    expect(await src.discover()).toEqual([]);
  });

  it("an enabled source with no client wired returns [] (defensive — never throws on discover)", async () => {
    const src = new UniFiDiscoverySource({ enabled: true });
    expect(await src.discover()).toEqual([]);
  });
});

describe("EasyMesh + UniFi scaffolds (ADR-024 Phase 2 — gated off)", () => {
  it("EasyMeshDiscoverySource contributes nothing when DROPLET_AP_EASYMESH_ENABLED=0 (default off)", async () => {
    const src = new EasyMeshDiscoverySource({ enabled: false });
    expect(await src.discover()).toEqual([]);
  });

  it("UniFiDiscoverySource contributes nothing when DROPLET_AP_UNIFI_ENABLED=0 (default off)", async () => {
    const src = new UniFiDiscoverySource({ enabled: false });
    expect(await src.discover()).toEqual([]);
  });

  it("an off EasyMesh scaffold inside the multiplexer adds zero rows (live path unchanged)", async () => {
    const prisma = createPrismaMock();
    const openwrt = {
      listDiscoveredAps: vi.fn(async () => [{ mac: "B8:27:EB:00:00:01" }]),
    };
    const mux = createDiscoveryMultiplexer(prisma as any, [
      new MdnsDiscoverySource(openwrt),
      new EasyMeshDiscoverySource({ enabled: false }),
      new UniFiDiscoverySource({ enabled: false }),
    ]);
    const result = await mux.discoverAndReconcile();

    // Only the one mDNS row — both scaffolds returned [].
    expect(result.created).toBe(1);
    expect(prisma.rows.get("B8:27:EB:00:00:01").backend).toBe("DROPLET_IMAGE");
  });
});
