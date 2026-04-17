import { describe, it, expect, vi } from "vitest";
import { createScheduleTicker } from "./schedule-ticker.js";
import { RouterError } from "../types/router-error.js";

// Simple in-memory prisma mock
function makePrisma() {
  const devices = new Map<string, any>();
  const schedules: any[] = [];
  const overrides: any[] = [];
  const events: any[] = [];
  return {
    _stores: { devices, schedules, overrides, events },
    networkDevice: {
      findMany: vi.fn(async () => {
        return Array.from(devices.values()).map((d) => ({ ...d, groups: d.groups ?? [] }));
      }),
    },
    schedule: {
      findMany: vi.fn(async () => schedules),
    },
    scheduleOverride: {
      findMany: vi.fn(async (q: any) => {
        const now = q?.where?.AND?.[0]?.startAt?.lte ?? new Date();
        return overrides.filter((o) => o.startAt <= now && o.endAt > now);
      }),
    },
    scheduleEvent: {
      create: vi.fn(async (q: any) => {
        events.push(q.data);
        return q.data;
      }),
    },
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
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF");
    expect(prisma.scheduleEvent.create).toHaveBeenCalled();
  });

  it("preserves prior state on RouterError and does NOT cache it", async () => {
    const prisma = makePrisma() as any;
    const fw = {
      block: vi.fn().mockRejectedValue(RouterError.unreachable("router down")),
      unblock: vi.fn(),
    };
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw as any);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalledTimes(1);
    // No event emitted because firewall call failed.
    expect(prisma.scheduleEvent.create).not.toHaveBeenCalled();

    // Second tick must RE-attempt (cache was not poisoned by the failure).
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
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();
    expect(fw.block).toHaveBeenCalledTimes(1);

    // Second tick: desired is still `true` (manualBlock hasn't changed),
    // and the cache says we already dispatched true — no router call.
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
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();
    // Bootstrap: desired=false, previous=undefined → we dispatch once.
    expect(fw.unblock).toHaveBeenCalledTimes(1);

    await ticker.tickOnce();
    // Subsequent: cache hit, no call.
    expect(fw.unblock).toHaveBeenCalledTimes(1);
  });
});
