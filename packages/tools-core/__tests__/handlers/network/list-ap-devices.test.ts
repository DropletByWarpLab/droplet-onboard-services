import { describe, it, expect, vi } from "vitest";
import listApDevices from "../../../src/handlers/network/list-ap-devices.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(rows: unknown[]): ToolContext {
  return {
    prisma: {
      apDevice: {
        findMany: vi.fn().mockResolvedValue(rows),
      },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("list_ap_devices (WARP-446)", () => {
  it("metadata is a read-only tool (no write, no confirmation)", () => {
    expect(listApDevices.name).toBe("list_ap_devices");
    expect(listApDevices.requiresWrite).toBe(false);
    expect(listApDevices.requiresConfirmation).toBe(false);
  });

  it("returns the AP rows verbatim from the ApDevice table", async () => {
    const ctx = ctxWith([
      {
        mac: "B8:27:EB:00:00:01",
        displayName: "Upstairs",
        status: "ONLINE",
        model: "raspberrypi,5-model-b",
        lastIp: "192.168.50.42",
      },
      {
        mac: "B8:27:EB:00:00:02",
        displayName: null,
        status: "AWAITING_APPROVAL",
      },
    ]);
    const r = await listApDevices.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { aps: unknown[] }).aps).toHaveLength(2);
    }
  });
});
