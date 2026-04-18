import { describe, it, expect, vi } from "vitest";
import { createScheduleTicker } from "./schedule-ticker.js";
import { RouterError } from "../types/router-error.js";

// Simple in-memory prisma mock. `lastAppliedBlocked` lives on each device
// row and is mutated via `networkDevice.update` (which the ticker now
// wraps in a $transaction alongside the schedule-event insert).
function makePrisma() {
  const devices = new Map<string, any>();
  const schedules: any[] = [];
  const overrides: any[] = [];
  const events: any[] = [];

  const networkDevice = {
    findMany: vi.fn(async () => {
      return Array.from(devices.values()).map((d) => ({
        ...d,
        groups: d.groups ?? [],
        lastAppliedBlocked: d.lastAppliedBlocked ?? null,
      }));
    }),
    update: vi.fn(async (q: any) => {
      const row = devices.get(q.where.mac);
      if (row) Object.assign(row, q.data);
      return row;
    }),
  };
  const schedule = { findMany: vi.fn(async () => schedules) };
  const scheduleOverride = {
    findMany: vi.fn(async (q: any) => {
      const now = q?.where?.AND?.[0]?.startAt?.lte ?? new Date();
      return overrides.filter((o) => o.startAt <= now && o.endAt > now);
    }),
  };
  const scheduleEvent = {
    create: vi.fn(async (q: any) => {
      events.push(q.data);
      return q.data;
    }),
  };

  // $transaction accepts an array of already-constructed Prisma promises
  // and simply awaits them in order (sufficient for tests — the real
  // client runs them in a single BEGIN/COMMIT).
  const $transaction = vi.fn(async (ops: any[]) => {
    const results: any[] = [];
    for (const op of ops) {
      results.push(await op);
    }
    return results;
  });

  return {
    _stores: { devices, schedules, overrides, events },
    networkDevice,
    schedule,
    scheduleOverride,
    scheduleEvent,
    $transaction,
  };
}

function makeFirewall() {
  return {
    block: vi.fn(async (_mac: string) => {}),
    unblock: vi.fn(async (_mac: string) => {}),
  };
}

describe("schedule-ticker", () => {
  it("applies block when manualBlock=true on first tick (bootstrap)", async () => {
    const prisma = makePrisma() as any;
    const fw = makeFirewall();
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      lastAppliedBlocked: null,
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF");
    expect(prisma.scheduleEvent.create).toHaveBeenCalled();
    // The persisted state was flipped to true in the same txn.
    expect(prisma.networkDevice.update).toHaveBeenCalledWith({
      where: { mac: "AA:BB:CC:DD:EE:FF" },
      data: { lastAppliedBlocked: true },
    });
  });

  it("preserves prior state on RouterError and does NOT update lastAppliedBlocked", async () => {
    const prisma = makePrisma() as any;
    const fw = {
      block: vi.fn().mockRejectedValue(RouterError.unreachable("router down")),
      unblock: vi.fn(),
    };
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      lastAppliedBlocked: null,
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw as any);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalledTimes(1);
    // No event emitted because firewall call failed.
    expect(prisma.scheduleEvent.create).not.toHaveBeenCalled();
    // And the persisted state was NOT written — so the next tick re-attempts.
    expect(prisma.networkDevice.update).not.toHaveBeenCalled();

    // Second tick must RE-attempt (state was not poisoned by the failure).
    await ticker.tickOnce();
    expect(fw.block).toHaveBeenCalledTimes(2);
  });

  it("second tick with same desired state does NOT call firewall again", async () => {
    const prisma = makePrisma() as any;
    const fw = makeFirewall();
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      lastAppliedBlocked: null,
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();
    expect(fw.block).toHaveBeenCalledTimes(1);

    // Second tick: desired is still `true` (manualBlock hasn't changed),
    // and the DB now has lastAppliedBlocked=true (from the first tick's
    // $transaction) — no router call.
    await ticker.tickOnce();
    expect(fw.block).toHaveBeenCalledTimes(1);
    expect(fw.unblock).not.toHaveBeenCalled();
    // And no duplicate event row.
    expect(prisma.scheduleEvent.create).toHaveBeenCalledTimes(1);
  });

  it("transition triggers a new dispatch + event", async () => {
    const prisma = makePrisma() as any;
    const fw = makeFirewall();
    const device = {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      lastAppliedBlocked: null,
      groups: [],
    };
    prisma._stores.devices.set(device.mac, device);

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();
    expect(fw.block).toHaveBeenCalledTimes(1);

    // Flip the desired state.
    device.manualBlock = false;
    await ticker.tickOnce();
    expect(fw.unblock).toHaveBeenCalledTimes(1);
    expect(prisma.scheduleEvent.create).toHaveBeenCalledTimes(2);
  });

  it("no dispatch on first tick when desired matches default unblocked state", async () => {
    // First tick still needs to bootstrap state. For an unblocked device
    // with desired=false we should dispatch unblock once so the router's
    // state is authoritative, then subsequent ticks become no-ops.
    const prisma = makePrisma() as any;
    const fw = makeFirewall();
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: false,
      isBlocked: false,
      lastAppliedBlocked: null,
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();
    // Bootstrap: desired=false, previous=null → we dispatch once.
    expect(fw.unblock).toHaveBeenCalledTimes(1);

    await ticker.tickOnce();
    // Subsequent: DB hit says lastAppliedBlocked=false, no call.
    expect(fw.unblock).toHaveBeenCalledTimes(1);
  });

  // ── Critical fix #2: state persistence ──

  it("skips dispatch when lastAppliedBlocked matches desired (true === true)", async () => {
    // Seed a device that was ALREADY blocked by a previous ticker run —
    // after an orchestrator restart, the Map would be empty but the DB
    // still remembers. This test asserts the DB read drives the diff.
    const prisma = makePrisma() as any;
    const fw = makeFirewall();
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: true,
      lastAppliedBlocked: true, // already applied — no dispatch expected
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();

    expect(fw.block).not.toHaveBeenCalled();
    expect(fw.unblock).not.toHaveBeenCalled();
    expect(prisma.scheduleEvent.create).not.toHaveBeenCalled();
    expect(prisma.networkDevice.update).not.toHaveBeenCalled();
  });

  it("dispatches when lastAppliedBlocked is null (bootstrap / first-seen)", async () => {
    // desired=false, lastAppliedBlocked=null. Null !== false, so we dispatch.
    const prisma = makePrisma() as any;
    const fw = makeFirewall();
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: false,
      isBlocked: false,
      lastAppliedBlocked: null,
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();

    expect(fw.unblock).toHaveBeenCalledTimes(1);
    expect(prisma.networkDevice.update).toHaveBeenCalledWith({
      where: { mac: "AA:BB:CC:DD:EE:FF" },
      data: { lastAppliedBlocked: false },
    });
  });

  it("writes lastAppliedBlocked = desired on successful dispatch (true case)", async () => {
    const prisma = makePrisma() as any;
    const fw = makeFirewall();
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      lastAppliedBlocked: false, // prior state says unblocked; desired is now blocked
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalledTimes(1);
    // The event and the state update run in the SAME $transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.networkDevice.update).toHaveBeenCalledWith({
      where: { mac: "AA:BB:CC:DD:EE:FF" },
      data: { lastAppliedBlocked: true },
    });
  });

  it("does NOT update lastAppliedBlocked on RouterError (state preserved for retry)", async () => {
    const prisma = makePrisma() as any;
    const fw = {
      block: vi.fn().mockRejectedValue(RouterError.unreachable("router down")),
      unblock: vi.fn(),
    };
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      lastAppliedBlocked: false, // prior state: unblocked — should stay
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw as any);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalledTimes(1);
    expect(prisma.networkDevice.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // The row's lastAppliedBlocked in our fake store is still `false`
    // — verified by a second tick that re-attempts the block.
    fw.block.mockResolvedValueOnce(undefined);
    await ticker.tickOnce();
    expect(fw.block).toHaveBeenCalledTimes(2);
  });
});
