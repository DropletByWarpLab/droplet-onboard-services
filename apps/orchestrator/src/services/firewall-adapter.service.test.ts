import { describe, it, expect, vi } from "vitest";
import { createFirewallAdapter } from "./firewall-adapter.service.js";
import { createScheduleTicker } from "./schedule-ticker.js";

describe("createFirewallAdapter", () => {
  it("delegates block() to the openwrt client's blockDevice", async () => {
    const openwrt = {
      blockDevice: vi.fn(async () => ({ operationId: "op-1" })),
      unblockDevice: vi.fn(async () => ({ operationId: "op-2" })),
    };

    const adapter = createFirewallAdapter(openwrt);
    await adapter.block("AA:BB:CC:DD:EE:FF");

    expect(openwrt.blockDevice).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF");
    expect(openwrt.unblockDevice).not.toHaveBeenCalled();
  });

  it("delegates unblock() to the openwrt client's unblockDevice", async () => {
    const openwrt = {
      blockDevice: vi.fn(async () => ({ operationId: "op-1" })),
      unblockDevice: vi.fn(async () => ({ operationId: "op-2" })),
    };

    const adapter = createFirewallAdapter(openwrt);
    await adapter.unblock("AA:BB:CC:DD:EE:FF");

    expect(openwrt.unblockDevice).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF");
    expect(openwrt.blockDevice).not.toHaveBeenCalled();
  });

  it("resolves to void, discarding the openwrt WriteResult", async () => {
    const openwrt = {
      blockDevice: vi.fn(async () => ({ operationId: "op-1" })),
      unblockDevice: vi.fn(async () => ({ operationId: "op-2" })),
    };

    const adapter = createFirewallAdapter(openwrt);
    await expect(adapter.block("AA:BB:CC:DD:EE:FF")).resolves.toBeUndefined();
  });
});

// AC3 (the point of this ticket): the schedule ticker can now be exercised
// against the REAL adapter with a mocked openwrt client — no rebuilding the
// inline object literal that used to live in index.ts. This proves the
// adapter is reusable in integration-style tests.
describe("schedule-ticker with real firewall adapter (AC3)", () => {
  function makePrisma() {
    const devices = new Map<string, any>();
    const events: any[] = [];

    const networkDevice = {
      findMany: vi.fn(async () =>
        Array.from(devices.values()).map((d) => ({
          ...d,
          groups: d.groups ?? [],
          lastAppliedBlocked: d.lastAppliedBlocked ?? null,
        })),
      ),
      update: vi.fn(async (q: any) => {
        const row = devices.get(q.where.mac);
        if (row) Object.assign(row, q.data);
        return row;
      }),
    };
    const schedule = { findMany: vi.fn(async () => []) };
    const scheduleOverride = { findMany: vi.fn(async () => []) };
    const scheduleEvent = {
      create: vi.fn(async (q: any) => {
        events.push(q.data);
        return q.data;
      }),
    };
    const $transaction = vi.fn(async (ops: any[]) => {
      const results: any[] = [];
      for (const op of ops) results.push(await op);
      return results;
    });

    return {
      _stores: { devices, events },
      networkDevice,
      schedule,
      scheduleOverride,
      scheduleEvent,
      $transaction,
    };
  }

  it("drives a tick through the adapter, delegating to mocked openwrt.blockDevice", async () => {
    const prisma = makePrisma() as any;
    const openwrt = {
      blockDevice: vi.fn(async () => ({ operationId: "op-1" })),
      unblockDevice: vi.fn(async () => ({ operationId: "op-2" })),
    };
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      lastAppliedBlocked: null,
      groups: [],
    });

    // The real adapter — exactly what index.ts wires up — passed straight
    // into the ticker. No inline literal rebuilt in the test.
    const ticker = createScheduleTicker(prisma, createFirewallAdapter(openwrt));
    await ticker.tickOnce();

    expect(openwrt.blockDevice).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF");
    expect(openwrt.unblockDevice).not.toHaveBeenCalled();
    expect(prisma.networkDevice.update).toHaveBeenCalledWith({
      where: { mac: "AA:BB:CC:DD:EE:FF" },
      data: { lastAppliedBlocked: true },
    });
  });

  it("drives an unblock transition through the adapter to mocked openwrt.unblockDevice", async () => {
    const prisma = makePrisma() as any;
    const openwrt = {
      blockDevice: vi.fn(async () => ({ operationId: "op-1" })),
      unblockDevice: vi.fn(async () => ({ operationId: "op-2" })),
    };
    const device = {
      mac: "AA:BB:CC:DD:EE:FF",
      manualBlock: true,
      isBlocked: false,
      lastAppliedBlocked: true, // already blocked
      groups: [],
    };
    prisma._stores.devices.set(device.mac, device);

    const ticker = createScheduleTicker(prisma, createFirewallAdapter(openwrt));

    // Flip desired → unblock.
    device.manualBlock = false;
    await ticker.tickOnce();

    expect(openwrt.unblockDevice).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF");
    expect(openwrt.blockDevice).not.toHaveBeenCalled();
  });
});
