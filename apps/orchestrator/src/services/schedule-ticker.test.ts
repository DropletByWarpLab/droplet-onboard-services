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

function makeFirewall(initial: Record<string, boolean> = {}) {
  const state = new Map(Object.entries(initial));
  return {
    _state: state,
    block: vi.fn(async (mac: string) => {
      state.set(mac, true);
    }),
    unblock: vi.fn(async (mac: string) => {
      state.set(mac, false);
    }),
    isBlocked: (mac: string) => state.get(mac) ?? false,
  };
}

describe("schedule-ticker", () => {
  it("applies block when manualBlock=true and firewall not blocked yet", async () => {
    const prisma = makePrisma() as any;
    const fw = makeFirewall({ "AA:BB:CC:DD:EE:FF": false });
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

  it("preserves prior state on RouterError", async () => {
    const prisma = makePrisma() as any;
    const fw = {
      block: vi.fn().mockRejectedValue(RouterError.unreachable("router down")),
      unblock: vi.fn(),
      isBlocked: () => false,
    };
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw as any);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalled();
    // No event emitted because firewall call failed
    expect(prisma.scheduleEvent.create).not.toHaveBeenCalled();
  });

  it("no-op when desired matches actual firewall state", async () => {
    const prisma = makePrisma() as any;
    const fw = makeFirewall({ "AA:BB:CC:DD:EE:FF": false });
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: false,
      isBlocked: false,
      groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw as any);
    await ticker.tickOnce();

    expect(fw.block).not.toHaveBeenCalled();
    expect(fw.unblock).not.toHaveBeenCalled();
    expect(prisma.scheduleEvent.create).not.toHaveBeenCalled();
  });
});
