import { describe, it, expect, vi } from "vitest";
import discover from "../../../src/handlers/smart-home/discover-matter-devices.js";
import type { ToolContext } from "../../../src/types.js";

describe("discover_matter_devices", () => {
  it("delegates to matter.discover()", async () => {
    const fake = { discovered: [{ discriminator: 1234, vendorId: 1 }] };
    const ctx: ToolContext = {
      matter: {
        listDevices: vi.fn(),
        getDevice: vi.fn(),
        sendCommand: vi.fn(),
        discover: vi.fn().mockResolvedValue(fake),
        commission: vi.fn(),
        decommission: vi.fn(),
        getAuditLog: vi.fn(),
      },
      prisma: {} as ToolContext["prisma"],
      http: {} as ToolContext["http"],
      signal: new AbortController().signal,
    };
    const r = await discover.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(fake);
  });
});
