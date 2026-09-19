import { describe, it, expect, vi } from "vitest";
import listSmartHomeDevices from "../../../src/handlers/smart-home/list-smart-home-devices.js";
import type { ToolContext } from "../../../src/types.js";

describe("list_smart_home_devices", () => {
  it("delegates to ctx.matter.listDevices()", async () => {
    const fake = { lights: [{ nodeId: "1", name: "Living Room" }], switches: [] };
    const matter = {
      listDevices: vi.fn().mockResolvedValue(fake),
      getDevice: vi.fn(),
      sendCommand: vi.fn(),
      discover: vi.fn(),
      commission: vi.fn(),
      decommission: vi.fn(),
      getAuditLog: vi.fn(),
    };
    const ctx: ToolContext = {
      matter,
      prisma: {} as ToolContext["prisma"],
      http: {} as ToolContext["http"],
      signal: new AbortController().signal,
    };
    const r = await listSmartHomeDevices.handler({}, ctx);
    expect(matter.listDevices).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(fake);
  });
});
