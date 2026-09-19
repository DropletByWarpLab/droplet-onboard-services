import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import commissionDevice from "../../../src/handlers/smart-home/commission-device.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(commission: Mock): ToolContext {
  return {
    matter: {
      listDevices: vi.fn(),
      getDevice: vi.fn(),
      sendCommand: vi.fn(),
      discover: vi.fn(),
      commission,
      decommission: vi.fn(),
      getAuditLog: vi.fn(),
    },
    prisma: {} as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    signal: new AbortController().signal,
  };
}

describe("commission_device", () => {
  it("flags write+confirmation", () => {
    // Pairing is a meaningful state change; the dashboard's Tier 2 modal
    // is the trust anchor for human approval per spec §7. Reviewer-flagged
    // follow-up from WARP-102.
    expect(commissionDevice.requiresWrite).toBe(true);
    expect(commissionDevice.requiresConfirmation).toBe(true);
  });

  it("rejects missing pairing_code", async () => {
    const r = await commissionDevice.handler({}, ctxWith(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("delegates to matter.commission", async () => {
    const commission = vi.fn().mockResolvedValue({ nodeId: "5" });
    const r = await commissionDevice.handler({ pairing_code: "MT:Y.K9" }, ctxWith(commission));
    expect(commission).toHaveBeenCalledWith("MT:Y.K9");
    expect(r.ok).toBe(true);
  });

  it("propagates errors as COMMISSION_FAILED", async () => {
    const commission = vi.fn().mockRejectedValue(new Error("invalid code"));
    const r = await commissionDevice.handler(
      { pairing_code: "12345" },
      ctxWith(commission),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("COMMISSION_FAILED");
  });
});
