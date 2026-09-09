import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getSmartHomeDevice from "../../../src/handlers/smart-home/get-smart-home-device.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithMatter(getDevice: Mock): ToolContext {
  return {
    matter: {
      listDevices: vi.fn(),
      getDevice,
      sendCommand: vi.fn(),
      discover: vi.fn(),
      commission: vi.fn(),
      decommission: vi.fn(),
      getAuditLog: vi.fn(),
    },
    prisma: {} as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    signal: new AbortController().signal,
  };
}

describe("get_smart_home_device", () => {
  it("rejects missing node_id", async () => {
    const r = await getSmartHomeDevice.handler({}, ctxWithMatter(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("delegates to matter.getDevice", async () => {
    const fake = { nodeId: "1", name: "Lamp", state: { onOff: true } };
    const getDevice = vi.fn().mockResolvedValue(fake);
    const r = await getSmartHomeDevice.handler({ node_id: "1" }, ctxWithMatter(getDevice));
    expect(getDevice).toHaveBeenCalledWith("1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(fake);
  });
});
