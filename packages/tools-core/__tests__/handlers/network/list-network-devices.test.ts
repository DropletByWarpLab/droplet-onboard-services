import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listNetworkDevices from "../../../src/handlers/network/list-network-devices.js";
import type { ToolContext } from "../../../src/types.js";

/**
 * WARP-106: `isBlocked` is no longer a stored column. The handler selects
 * the two authored block fields — `manualBlock` (user intent) and
 * `lastAppliedBlocked` (ticker-authored source of truth) — and computes a
 * display `isBlocked = (lastAppliedBlocked ?? manualBlock)` in its output.
 */

function ctxWith(rows: unknown[], findMany = vi.fn().mockResolvedValue(rows)): {
  ctx: ToolContext;
  findMany: Mock;
} {
  const ctx = {
    prisma: {
      networkDevice: { findMany },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  } as ToolContext;
  return { ctx, findMany };
}

const baseRow = {
  mac: "AA:BB:CC:DD:EE:FF",
  displayName: "Living Room TV",
  vendor: null,
  hostname: null,
  lastIp: null,
  firstSeen: "2026-01-01T00:00:00.000Z",
  lastSeen: "2026-01-02T00:00:00.000Z",
};

describe("list_network_devices", () => {
  it("computes isBlocked = lastAppliedBlocked ?? manualBlock", async () => {
    const { ctx } = ctxWith([
      // ticker has applied a block → blocked regardless of intent
      { ...baseRow, mac: "AA:BB:CC:DD:EE:01", lastAppliedBlocked: true, manualBlock: false },
      // ticker never touched it → fall back to user intent (blocked)
      { ...baseRow, mac: "AA:BB:CC:DD:EE:02", lastAppliedBlocked: null, manualBlock: true },
      // ticker is source of truth: applied=false overrides stale intent=true
      { ...baseRow, mac: "AA:BB:CC:DD:EE:03", lastAppliedBlocked: false, manualBlock: true },
    ]);

    const r = await listNetworkDevices.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const devices = (r.data as { devices: Array<{ mac: string; isBlocked: boolean }> }).devices;
      const byMac = new Map(devices.map((d) => [d.mac, d.isBlocked]));
      expect(byMac.get("AA:BB:CC:DD:EE:01")).toBe(true);
      expect(byMac.get("AA:BB:CC:DD:EE:02")).toBe(true);
      expect(byMac.get("AA:BB:CC:DD:EE:03")).toBe(false);
      // The raw authored fields are NOT leaked to the LLM-facing tool output.
      expect(devices[0]).not.toHaveProperty("lastAppliedBlocked");
      expect(devices[0]).not.toHaveProperty("manualBlock");
    }
  });

  it("selects the authored block fields and no longer selects isBlocked", async () => {
    const { ctx, findMany } = ctxWith([
      { ...baseRow, lastAppliedBlocked: null, manualBlock: false },
    ]);

    const r = await listNetworkDevices.handler({}, ctx);
    expect(r.ok).toBe(true);
    const select = findMany.mock.calls[0][0].select;
    expect(select.lastAppliedBlocked).toBe(true);
    expect(select.manualBlock).toBe(true);
    expect(select.isBlocked).toBeUndefined();
  });

  it("returns the mapped device shape with a boolean isBlocked", async () => {
    const { ctx } = ctxWith([
      { ...baseRow, lastAppliedBlocked: null, manualBlock: false },
    ]);
    const r = await listNetworkDevices.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        devices: [
          {
            mac: "AA:BB:CC:DD:EE:FF",
            displayName: "Living Room TV",
            vendor: null,
            hostname: null,
            lastIp: null,
            firstSeen: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-02T00:00:00.000Z",
            isBlocked: false,
          },
        ],
      });
    }
  });

  it("metadata exposes name and write/confirmation flags", () => {
    expect(listNetworkDevices.name).toBe("list_network_devices");
    expect(listNetworkDevices.requiresWrite).toBe(false);
    expect(listNetworkDevices.requiresConfirmation).toBe(false);
  });
});
