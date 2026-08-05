/**
 * WARP-1761 — the `wifi.primary` converger (ADR-035 §1/§7).
 *
 * Two layers of coverage, same shape as `fabric-member-reconciler.test.ts`:
 *  1. `createWifiIntentConverger(prisma, routing).pollOnce()` — the unit:
 *     re-push on drift + `driftDetectedAt` stamp, no-op when the device
 *     already agrees, the role='ap' scope, the approval gate, and the
 *     degrade-to-logged-no-op paths.
 *  2. `startWifiIntentConverger(cronRuntime, ...)` — the wiring: the
 *     cadence + its OWN pg advisory lock key, and that the registered
 *     handler actually reaches the device read.
 *
 * The fixture MACs are the three members verified live on the lab box by
 * WARP-1731 (`GET /fabric/members`): the AP, the Pi router, and the GS1900.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createWifiIntentConverger,
  startWifiIntentConverger,
  type WifiIntentRoutingClient,
} from "./wifi-intent-converger.js";
import { WIFI_PRIMARY_INTENT_KEY } from "./network-intent.service.js";
import { RouterError } from "../types/router-error.js";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { ApWireless } from "./openwrt.client.js";

// Spy on the shared cold-start-aware log helper, same as the fabric
// reconciler's test — partial mock, every other export stays real.
const { logRouterError } = vi.hoisted(() => ({ logRouterError: vi.fn() }));
vi.mock("./openwrt.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openwrt.client.js")>();
  return { ...actual, logRouterError };
});

const AP_MAC = "80:EA:0B:39:AE:23";
const AP_MAC_B = "80:EA:0B:39:AE:24";
const ROUTER_MAC = "02:FC:58:E2:4E:02";
const SWITCH_MAC = "70:49:A2:77:64:1A";

function wireless(overrides: Partial<ApWireless> = {}): ApWireless {
  return {
    supported: true,
    ssid: "Droplet",
    key: "per-unit-psk",
    encryption: "psk2+ccmp",
    band_steering: true,
    five_ghz_ssid: "Droplet",
    primary_section: "default_radio0",
    radios: [],
    ...overrides,
  };
}

interface MockOpts {
  /** `null` = no intent row at all. */
  intent?: { ssid: string; generation: number } | null;
  members?: { anchorMac: string; role: string }[];
  aps?: { mac: string; status: string; backend: string }[];
}

function createPrismaMock(opts: MockOpts = {}) {
  const intentRows = new Map<string, any>();
  if (opts.intent) {
    intentRows.set(WIFI_PRIMARY_INTENT_KEY, {
      key: WIFI_PRIMARY_INTENT_KEY,
      value: { ssid: opts.intent.ssid },
      generation: opts.intent.generation,
      writtenBy: "user-1",
    });
  }
  const members = opts.members ?? [{ anchorMac: AP_MAC, role: "ap" }];
  const aps =
    opts.aps ?? [{ mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" }];
  /** (anchorMac, key) → DeviceIntentState row. */
  const stateRows = new Map<string, any>();

  return {
    intentRows,
    stateRows,
    networkIntent: {
      findUnique: vi.fn(async ({ where }: any) => intentRows.get(where.key) ?? null),
      upsert: vi.fn(async () => {
        throw new Error("the converger must never WRITE intent");
      }),
    },
    fabricMember: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        members.filter((m) => !where?.role || m.role === where.role),
      ),
      deleteMany: vi.fn(async () => {
        throw new Error("the converger must never delete a fabric member");
      }),
    },
    apDevice: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        aps.filter(
          (a) =>
            (!where?.status || a.status === where.status) &&
            (!where?.backend || a.backend === where.backend),
        ),
      ),
    },
    deviceIntentState: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const id = `${where.anchorMac_key.anchorMac}|${where.anchorMac_key.key}`;
        const existing = stateRows.get(id);
        const row = existing ? { ...existing, ...update } : { ...create };
        stateRows.set(id, row);
        return row;
      }),
      delete: vi.fn(async () => {
        throw new Error("the converger must never delete a device-intent row");
      }),
      deleteMany: vi.fn(async () => {
        throw new Error("the converger must never delete a device-intent row");
      }),
    },
  };
}

function makeRouting(
  overrides: Partial<WifiIntentRoutingClient> = {},
): WifiIntentRoutingClient {
  return {
    getApWireless: overrides.getApWireless ?? vi.fn(async () => wireless()),
    setApWireless:
      overrides.setApWireless ??
      vi.fn(async () => ({ operationId: "op-1", ssid: null, five_ghz_ssid: null })),
  };
}

const stateOf = (prisma: ReturnType<typeof createPrismaMock>, mac: string) =>
  prisma.stateRows.get(`${mac}|${WIFI_PRIMARY_INTENT_KEY}`);

describe("wifi.primary converger (WARP-1761)", () => {
  beforeEach(() => {
    logRouterError.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-pushes and stamps driftDetectedAt when the device disagrees with intent", async () => {
    const prisma = createPrismaMock({ intent: { ssid: "Droplet", generation: 7 } });
    // Somebody renamed the network in LuCI. Today that drift is read back and
    // displayed as correct; ADR-035 §7 says it is repaired, visibly.
    const routing = makeRouting({
      getApWireless: vi.fn(async () => wireless({ ssid: "hacked-in-luci" })),
    });

    const result = await createWifiIntentConverger(prisma as any, routing).pollOnce();

    expect(routing.setApWireless).toHaveBeenCalledTimes(1);
    expect(routing.setApWireless).toHaveBeenCalledWith({
      mac: AP_MAC,
      ssid: "Droplet",
    });
    expect(result).toMatchObject({ candidates: 1, repushed: 1, converged: 0 });

    const state = stateOf(prisma, AP_MAC);
    expect(state.driftDetectedAt).toBeInstanceOf(Date);
    expect(state.appliedGeneration).toBe(7);
    expect(state.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("no-ops when the device already matches intent — no write, no drift stamp", async () => {
    const prisma = createPrismaMock({ intent: { ssid: "Droplet", generation: 7 } });
    const routing = makeRouting();

    const result = await createWifiIntentConverger(prisma as any, routing).pollOnce();

    expect(routing.setApWireless).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 1, converged: 1, repushed: 0 });

    const state = stateOf(prisma, AP_MAC);
    expect(state.appliedGeneration).toBe(7);
    expect(state.lastVerifiedAt).toBeInstanceOf(Date);
    expect(state.driftDetectedAt ?? null).toBeNull();
  });

  it("stamps drift even when the repair push FAILS — drift is never silent", async () => {
    const prisma = createPrismaMock({ intent: { ssid: "Droplet", generation: 2 } });
    const routing = makeRouting({
      getApWireless: vi.fn(async () => wireless({ ssid: "wrong" })),
      setApWireless: vi.fn(async () => {
        throw RouterError.unreachable("AP wireless write: fetch failed");
      }),
    });

    const result = await createWifiIntentConverger(prisma as any, routing).pollOnce();

    expect(result).toMatchObject({ candidates: 1, repushed: 0, failed: 1 });
    const state = stateOf(prisma, AP_MAC);
    expect(state.driftDetectedAt).toBeInstanceOf(Date);
    // The repair did not land, so nothing may claim the generation applied.
    expect(state.appliedGeneration ?? null).toBeNull();
  });

  it("touches ONLY role='ap' members — the router and switch are never written", async () => {
    const prisma = createPrismaMock({
      intent: { ssid: "Droplet", generation: 1 },
      members: [
        { anchorMac: AP_MAC, role: "ap" },
        { anchorMac: ROUTER_MAC, role: "router" },
        { anchorMac: SWITCH_MAC, role: "switch" },
      ],
      aps: [
        { mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
        // Even if the router/switch somehow held approved AP rows, they are
        // not role='ap' members and must never be dialed.
        { mac: ROUTER_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
        { mac: SWITCH_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ],
    });
    const routing = makeRouting({
      getApWireless: vi.fn(async () => wireless({ ssid: "wrong" })),
    });

    await createWifiIntentConverger(prisma as any, routing).pollOnce();

    expect(prisma.fabricMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "ap" } }),
    );
    expect(routing.getApWireless).toHaveBeenCalledTimes(1);
    expect(routing.getApWireless).toHaveBeenCalledWith({ mac: AP_MAC });
    expect(routing.setApWireless).toHaveBeenCalledTimes(1);
    expect(routing.setApWireless).toHaveBeenCalledWith({
      mac: AP_MAC,
      ssid: "Droplet",
    });
  });

  it("never pushes to an AP that has not been approved through ADR-005", async () => {
    const prisma = createPrismaMock({
      intent: { ssid: "Droplet", generation: 1 },
      members: [{ anchorMac: AP_MAC, role: "ap" }],
      aps: [{ mac: AP_MAC, status: "AWAITING_APPROVAL", backend: "DROPLET_IMAGE" }],
    });
    const routing = makeRouting();

    const result = await createWifiIntentConverger(prisma as any, routing).pollOnce();

    // Broadcasting the household SSID from an unapproved radio would route
    // straight around the ADR-005 approval gate.
    expect(routing.getApWireless).not.toHaveBeenCalled();
    expect(routing.setApWireless).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 0, skipped: 1 });
  });

  it("never pushes uci wireless at a vendor-controller AP", async () => {
    const prisma = createPrismaMock({
      intent: { ssid: "Droplet", generation: 1 },
      members: [{ anchorMac: AP_MAC, role: "ap" }],
      aps: [{ mac: AP_MAC, status: "ONLINE", backend: "UNIFI" }],
    });
    const routing = makeRouting();

    await createWifiIntentConverger(prisma as any, routing).pollOnce();

    expect(routing.getApWireless).not.toHaveBeenCalled();
    expect(routing.setApWireless).not.toHaveBeenCalled();
  });

  it("does nothing at all when no intent has ever been written", async () => {
    const prisma = createPrismaMock({ intent: null });
    const routing = makeRouting();

    const result = await createWifiIntentConverger(prisma as any, routing).pollOnce();

    expect(prisma.fabricMember.findMany).not.toHaveBeenCalled();
    expect(routing.getApWireless).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 0, converged: 0, repushed: 0 });
  });

  it("skips an AP that cannot report its wireless — an unjudgeable device is not drifted", async () => {
    const prisma = createPrismaMock({ intent: { ssid: "Droplet", generation: 1 } });
    const routing = makeRouting({
      getApWireless: vi.fn(async () => ({ supported: false, radios: [] }) as ApWireless),
    });

    const result = await createWifiIntentConverger(prisma as any, routing).pollOnce();

    expect(routing.setApWireless).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, converged: 0, repushed: 0 });
    expect(stateOf(prisma, AP_MAC)).toBeUndefined();
  });

  it("an unreachable AP degrades to a logged no-op and never aborts the sweep", async () => {
    const prisma = createPrismaMock({
      intent: { ssid: "Droplet", generation: 1 },
      members: [
        { anchorMac: AP_MAC, role: "ap" },
        { anchorMac: AP_MAC_B, role: "ap" },
      ],
      aps: [
        { mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
        { mac: AP_MAC_B, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ],
    });
    const err = RouterError.unreachable("AP wireless: fetch failed");
    const getApWireless = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(wireless({ ssid: "wrong" }));
    const routing = makeRouting({ getApWireless });

    const result = await createWifiIntentConverger(prisma as any, routing).pollOnce();

    // The second AP still converged.
    expect(routing.setApWireless).toHaveBeenCalledTimes(1);
    expect(routing.setApWireless).toHaveBeenCalledWith({
      mac: AP_MAC_B,
      ssid: "Droplet",
    });
    expect(result).toMatchObject({ candidates: 2, repushed: 1, failed: 1 });
    expect(logRouterError).toHaveBeenCalledWith(
      expect.anything(),
      err,
      expect.stringContaining("wifi-intent"),
    );
  });

  it("never deletes a row, and never writes intent (ADR-035 §6)", async () => {
    const prisma = createPrismaMock({ intent: { ssid: "Droplet", generation: 3 } });
    const routing = makeRouting({
      getApWireless: vi.fn(async () => wireless({ ssid: "drifted" })),
    });

    await createWifiIntentConverger(prisma as any, routing).pollOnce();

    expect(prisma.deviceIntentState.delete).not.toHaveBeenCalled();
    expect(prisma.deviceIntentState.deleteMany).not.toHaveBeenCalled();
    expect(prisma.fabricMember.deleteMany).not.toHaveBeenCalled();
    expect(prisma.networkIntent.upsert).not.toHaveBeenCalled();
  });

  it("NEVER pushes a passphrase — it holds none, so it can leak none", async () => {
    const prisma = createPrismaMock({ intent: { ssid: "Droplet", generation: 1 } });
    const routing = makeRouting({
      getApWireless: vi.fn(async () => wireless({ ssid: "drifted" })),
    });

    await createWifiIntentConverger(prisma as any, routing).pollOnce();

    const pushed = (routing.setApWireless as any).mock.calls[0][0];
    expect(pushed).not.toHaveProperty("key");
    expect(Object.keys(pushed).sort()).toEqual(["mac", "ssid"]);
  });

  it("startWifiIntentConverger registers the cadence + its OWN advisory lock key", async () => {
    const prisma = createPrismaMock({ intent: { ssid: "Droplet", generation: 1 } });
    const routing = makeRouting({
      getApWireless: vi.fn(async () => wireless({ ssid: "drifted" })),
    });

    let capturedHandler: (() => void | Promise<void>) | null = null;
    let capturedIntervalMs: number | null = null;
    let capturedLockKey: string | null = null;
    const cronRuntime: CronRuntime = {
      scheduleInterval: (ms, handler, opts) => {
        capturedIntervalMs = ms;
        capturedHandler = handler;
        capturedLockKey = opts?.lockKey ?? null;
      },
      scheduleCron: () => {},
      stop: () => {},
    };

    startWifiIntentConverger(cronRuntime, prisma as any, routing, 30_000);

    expect(capturedIntervalMs).toBe(30_000);
    // Distinct from the fabric-member reconciler's key: two schedulers must
    // not serialise behind one another's lock.
    expect(capturedLockKey).toBe("droplet:wifi-intent-converger");
    expect(capturedLockKey).not.toBe("droplet:fabric-member-reconciler");

    await capturedHandler!();
    expect(routing.getApWireless).toHaveBeenCalledWith({ mac: AP_MAC });
    expect(routing.setApWireless).toHaveBeenCalledTimes(1);
  });
});
