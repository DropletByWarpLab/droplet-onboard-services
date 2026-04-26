import { describe, it, expect, vi } from "vitest";
import listNetworkDevices from "../../../src/handlers/network/list-network-devices.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    prisma: {
      networkDevice: {
        findMany: vi.fn().mockResolvedValue([
          { mac: "AA:BB:CC:DD:EE:FF", displayName: "Living Room TV", isBlocked: false },
        ]),
      },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("list_network_devices", () => {
  it("returns ok with the device list", async () => {
    const ctx = ctxWith();
    const r = await listNetworkDevices.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        devices: [
          { mac: "AA:BB:CC:DD:EE:FF", displayName: "Living Room TV", isBlocked: false },
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
