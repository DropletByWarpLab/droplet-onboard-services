/**
 * WARP-1732 — fabric-member reconciler (ADR-035 §2/§5/§6).
 *
 * Two layers of coverage, same shape as `ap-discovery-poller.test.ts`:
 *  1. `createFabricMemberReconciler(prisma, routing).pollOnce()` — the unit:
 *     insert-on-first-sight, refresh-without-duplicate on re-poll, the
 *     NEVER-DELETE invariant when a member stops announcing, MAC
 *     normalization, PoE coercion, and the degrade-to-logged-no-op path.
 *  2. `startFabricMemberReconciler(cronRuntime, ...)` — the wiring: the
 *     cadence + the pg advisory lock key, and that the registered handler
 *     actually reaches the upsert.
 *
 * The fixture rows are the three members verified live on the lab box by
 * WARP-1731 (`GET /fabric/members` on the routing service): the AP, the
 * synthesized Pi router, and the GS1900 switch with its PoE TXT keys.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFabricMemberReconciler,
  startFabricMemberReconciler,
  type FabricMemberRoutingClient,
} from "./fabric-member-reconciler.js";
import { RouterError } from "../types/router-error.js";
import type { CronRuntime } from "./cron-runtime.service.js";

// Spy on the shared cold-start-aware log helper so we can assert the
// reconciler's catch routes failures through it rather than logging at a
// hardcoded `warn` on every boot. Partial mock — every other export stays real.
const { logRouterError } = vi.hoisted(() => ({ logRouterError: vi.fn() }));
vi.mock("./openwrt.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openwrt.client.js")>();
  return { ...actual, logRouterError };
});

/**
 * The three members the routing service returned on the lab box, verbatim
 * shape (snake_case, `extra` values as TXT strings).
 */
const LIVE_MEMBERS = [
  {
    role: "ap",
    mac: "80:ea:0b:39:ae:23",
    model: "Qualcomm Technologies, Inc. IPQ5332/AP-MI01.6",
    version: "1.0",
    last_ip: "192.168.9.180",
    hostname: "droplet-ap",
    extra: {},
  },
  {
    role: "router",
    mac: "02:fc:58:e2:4e:02",
    model: "Raspberry Pi 5 Model B",
    version: "OpenWrt 25.12",
    last_ip: "192.168.9.1",
    hostname: "droplet-edge",
    extra: {},
  },
  {
    role: "switch",
    mac: "70:49:a2:77:64:1a",
    model: "Zyxel GS1900-10HP",
    version: "24.10.0",
    last_ip: "192.168.9.2",
    hostname: "droplet-switch",
    extra: { poe_ports: "8", poe_budget: "77" },
  },
];

function createPrismaMock() {
  const rows = new Map<string, any>();
  const fabricMember = {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = rows.get(where.anchorMac);
      if (existing) {
        const merged = { ...existing, ...update };
        rows.set(where.anchorMac, merged);
        return merged;
      }
      const row = { ...create };
      rows.set(where.anchorMac, row);
      return row;
    }),
    findMany: vi.fn(async () => [...rows.values()]),
    // Present ONLY so the never-delete invariant is assertable. Production
    // code must never reach either of these.
    delete: vi.fn(async () => {
      throw new Error("fabric reconciler must never delete a member row");
    }),
    deleteMany: vi.fn(async () => {
      throw new Error("fabric reconciler must never delete a member row");
    }),
  };
  return { rows, fabricMember };
}

function makeRouting(
  overrides: Partial<FabricMemberRoutingClient> = {},
): FabricMemberRoutingClient {
  return {
    listFabricMembers: overrides.listFabricMembers ?? (async () => []),
  };
}

describe("fabric-member reconciler (WARP-1732)", () => {
  beforeEach(() => {
    logRouterError.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("inserts every observed member, keyed by the NORMALIZED anchor MAC", async () => {
    const prisma = createPrismaMock();
    const routing = makeRouting({ listFabricMembers: async () => LIVE_MEMBERS });

    const reconciler = createFabricMemberReconciler(prisma as any, routing);
    const result = await reconciler.pollOnce();

    expect(prisma.fabricMember.upsert).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ observed: 3, upserted: 3, skipped: 0 });

    // ADR-035 §2: the anchor MAC is the primary key, and it goes through the
    // EXISTING lib/mac.ts normalizer — uppercase, colon-separated.
    expect([...prisma.rows.keys()].sort()).toEqual([
      "02:FC:58:E2:4E:02",
      "70:49:A2:77:64:1A",
      "80:EA:0B:39:AE:23",
    ]);

    const ap = prisma.rows.get("80:EA:0B:39:AE:23");
    expect(ap).toMatchObject({
      anchorMac: "80:EA:0B:39:AE:23",
      role: "ap",
      model: "Qualcomm Technologies, Inc. IPQ5332/AP-MI01.6",
      lastIp: "192.168.9.180",
      hostname: "droplet-ap",
    });
    expect(ap.firstSeen).toBeInstanceOf(Date);
    expect(ap.lastSeen).toBeInstanceOf(Date);

    // Role is a free-form String, not an enum — roles will grow (ADR-035 §5).
    expect(prisma.rows.get("02:FC:58:E2:4E:02").role).toBe("router");
  });

  it("coerces the switch's PoE TXT strings into poePorts / poeBudget integers", async () => {
    const prisma = createPrismaMock();
    const routing = makeRouting({ listFabricMembers: async () => LIVE_MEMBERS });

    await createFabricMemberReconciler(prisma as any, routing).pollOnce();

    const sw = prisma.rows.get("70:49:A2:77:64:1A");
    expect(sw.poePorts).toBe(8);
    expect(sw.poeBudget).toBe(77);

    // A member with no PoE advertisement carries nulls, never 0 — absence is
    // absence, not "a switch with zero ports".
    expect(prisma.rows.get("80:EA:0B:39:AE:23").poePorts).toBeNull();
    expect(prisma.rows.get("80:EA:0B:39:AE:23").poeBudget).toBeNull();
  });

  it("ignores non-numeric PoE TXT values rather than writing NaN", async () => {
    const prisma = createPrismaMock();
    const routing = makeRouting({
      listFabricMembers: async () => [
        {
          role: "switch",
          mac: "70:49:a2:77:64:1a",
          extra: { poe_ports: "eight", poe_budget: "" },
        },
      ],
    });

    await createFabricMemberReconciler(prisma as any, routing).pollOnce();

    const sw = prisma.rows.get("70:49:A2:77:64:1A");
    expect(sw.poePorts).toBeNull();
    expect(sw.poeBudget).toBeNull();
  });

  it("re-poll refreshes lastSeen and does NOT duplicate the row", async () => {
    const prisma = createPrismaMock();
    const routing = makeRouting({ listFabricMembers: async () => LIVE_MEMBERS });
    const reconciler = createFabricMemberReconciler(prisma as any, routing);

    await reconciler.pollOnce();
    const firstSeen = prisma.rows.get("70:49:A2:77:64:1A").firstSeen;
    const lastSeenAfterFirst = prisma.rows.get("70:49:A2:77:64:1A").lastSeen;

    vi.setSystemTime(new Date("2026-08-05T10:00:30.000Z"));
    await reconciler.pollOnce();

    // Still exactly three rows — the upsert keys on the anchor MAC.
    expect(prisma.rows.size).toBe(3);
    const sw = prisma.rows.get("70:49:A2:77:64:1A");
    expect(sw.lastSeen.getTime()).toBeGreaterThan(lastSeenAfterFirst.getTime());
    // firstSeen is write-once: it is set on create and never touched again.
    expect(sw.firstSeen.getTime()).toBe(firstSeen.getTime());

    const updatePayload = prisma.fabricMember.upsert.mock.calls.at(-1)![0].update;
    expect(updatePayload).not.toHaveProperty("firstSeen");
    expect(updatePayload.lastSeen).toBeInstanceOf(Date);
  });

  it("a member missing from a poll is NOT deleted — it goes stale via lastSeen (ADR-035 §6)", async () => {
    const prisma = createPrismaMock();
    let members = [...LIVE_MEMBERS];
    const routing = makeRouting({ listFabricMembers: async () => members });
    const reconciler = createFabricMemberReconciler(prisma as any, routing);

    await reconciler.pollOnce();
    expect(prisma.rows.size).toBe(3);
    const switchLastSeen = prisma.rows.get("70:49:A2:77:64:1A").lastSeen;

    // The switch stops announcing (unplugged, umdns restart, PoE blip…).
    vi.setSystemTime(new Date("2026-08-05T10:05:00.000Z"));
    members = LIVE_MEMBERS.filter((m) => m.role !== "switch");
    await reconciler.pollOnce();

    // Observations only: the row survives untouched, its lastSeen frozen at
    // the last real observation so staleness is READABLE rather than a
    // vanished row.
    expect(prisma.rows.size).toBe(3);
    expect(prisma.rows.get("70:49:A2:77:64:1A")).toBeDefined();
    expect(prisma.rows.get("70:49:A2:77:64:1A").lastSeen.getTime()).toBe(
      switchLastSeen.getTime(),
    );
    expect(prisma.fabricMember.delete).not.toHaveBeenCalled();
    expect(prisma.fabricMember.deleteMany).not.toHaveBeenCalled();
  });

  it("an empty inventory writes nothing and deletes nothing", async () => {
    const prisma = createPrismaMock();
    const reconciler = createFabricMemberReconciler(prisma as any, makeRouting());

    const result = await reconciler.pollOnce();

    expect(prisma.fabricMember.upsert).not.toHaveBeenCalled();
    expect(prisma.fabricMember.deleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ observed: 0, upserted: 0 });
  });

  it("a member whose MAC will not normalize is skipped; its siblings still land", async () => {
    const prisma = createPrismaMock();
    const routing = makeRouting({
      listFabricMembers: async () => [
        { role: "switch", mac: "not-a-mac" },
        { role: "ap", mac: "80:ea:0b:39:ae:23" },
      ],
    });

    const result = await createFabricMemberReconciler(
      prisma as any,
      routing,
    ).pollOnce();

    expect(prisma.rows.size).toBe(1);
    expect(prisma.rows.get("80:EA:0B:39:AE:23")).toBeDefined();
    expect(result).toMatchObject({ observed: 2, upserted: 1, skipped: 1 });
  });

  it("a member with no MAC at all is skipped — never invent an identity", async () => {
    const prisma = createPrismaMock();
    const routing = makeRouting({
      listFabricMembers: async () => [{ role: "switch" } as never],
    });

    const result = await createFabricMemberReconciler(
      prisma as any,
      routing,
    ).pollOnce();

    expect(prisma.fabricMember.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ observed: 1, upserted: 0, skipped: 1 });
  });

  it("a fact that stops being announced is NOT erased from the row", async () => {
    const prisma = createPrismaMock();
    let members: any[] = [
      {
        role: "ap",
        mac: "80:ea:0b:39:ae:23",
        model: "IPQ5332",
        version: "1.0",
        last_ip: "192.168.9.180",
        hostname: "droplet-ap",
      },
    ];
    const routing = makeRouting({ listFabricMembers: async () => members });
    const reconciler = createFabricMemberReconciler(prisma as any, routing);

    await reconciler.pollOnce();

    // Next announce carries only the mandatory keys plus a NEW address.
    members = [{ role: "ap", mac: "80:ea:0b:39:ae:23", last_ip: "192.168.9.181" }];
    await reconciler.pollOnce();

    const ap = prisma.rows.get("80:EA:0B:39:AE:23");
    expect(ap.lastIp).toBe("192.168.9.181");
    expect(ap.model).toBe("IPQ5332");
    expect(ap.hostname).toBe("droplet-ap");
    expect(ap.version).toBe("1.0");
  });

  it("routing-service failure degrades to a logged no-op — never throws", async () => {
    const prisma = createPrismaMock();
    const err = RouterError.unreachable("routing down");
    const routing = makeRouting({
      listFabricMembers: async () => {
        throw err;
      },
    });

    const reconciler = createFabricMemberReconciler(prisma as any, routing);
    await expect(reconciler.pollOnce()).resolves.toBeDefined();

    expect(prisma.fabricMember.upsert).not.toHaveBeenCalled();
    expect(prisma.fabricMember.deleteMany).not.toHaveBeenCalled();
    expect(logRouterError).toHaveBeenCalledWith(
      expect.anything(),
      err,
      expect.stringContaining("fabric-member"),
    );
  });

  it("one row's write failure does not abort the rest of the sweep", async () => {
    const prisma = createPrismaMock();
    prisma.fabricMember.upsert.mockImplementationOnce(async () => {
      throw new Error("deadlock detected");
    });
    const routing = makeRouting({ listFabricMembers: async () => LIVE_MEMBERS });

    const result = await createFabricMemberReconciler(
      prisma as any,
      routing,
    ).pollOnce();

    expect(prisma.fabricMember.upsert).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ observed: 3, upserted: 2, failed: 1 });
  });

  it("startFabricMemberReconciler registers the cadence + pg advisory lock, and its tick reaches the upsert", async () => {
    const prisma = createPrismaMock();
    const routing = makeRouting({
      listFabricMembers: vi.fn(async () => [
        { role: "switch", mac: "70:49:a2:77:64:1a", extra: { poe_ports: "8" } },
      ]),
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
      scheduleCron: vi.fn(),
      stop: vi.fn(),
    };

    startFabricMemberReconciler(cronRuntime, prisma as any, routing, 10_000);

    expect(capturedIntervalMs).toBe(10_000);
    expect(capturedLockKey).toBe("droplet:fabric-member-reconciler");
    expect(capturedHandler).toBeTypeOf("function");

    await capturedHandler!();
    expect(routing.listFabricMembers).toHaveBeenCalledTimes(1);
    expect(prisma.rows.get("70:49:A2:77:64:1A")?.poePorts).toBe(8);
  });

  // The behavioural test above proves this poll path doesn't delete. This
  // static one proves there IS no delete path — a second layer, in the same
  // spirit as department-reconciler's "never-delete-outside-archiving"
  // invariant and rbac-census.guard.test.ts's file-text bans. A future
  // "prune members we haven't seen in N days" helper would be caught here
  // even if no test happened to exercise it.
  it("the reconciler source contains NO delete path at all (ADR-035 §6)", () => {
    const src = readFileSync(
      join(__dirname, "fabric-member-reconciler.ts"),
      "utf8",
    );
    const deletes = [
      ...src.matchAll(/\.(delete|deleteMany)\s*\(/g),
      ...src.matchAll(/\$executeRaw|\bDELETE\s+FROM\b/gi),
    ].map((m) => m[0]);
    expect(
      deletes,
      "ADR-035 §6: a member that stops announcing goes stale via lastSeen. " +
        "Removing inventory on a missed poll makes a umdns restart or a PoE " +
        "blip indistinguishable from a device that was never there.",
    ).toEqual([]);
  });
});
