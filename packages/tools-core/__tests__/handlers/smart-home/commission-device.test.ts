import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import commissionDevice from "../../../src/handlers/smart-home/commission-device.js";
import {
  createToolCallInterceptor,
  interceptOutcomeToToolResult,
} from "../../../src/interceptor.js";
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
    // Pairing is a meaningful state change. The gate is the WARP-2305
    // interceptor, which challenges on this flag before the handler runs
    // (there is no separate "Tier 2 modal"; WARP-2008).
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

describe("commission_device — gated at dispatch (WARP-2008)", () => {
  const CODE = "34970112332";

  it("the first call is challenged and never reaches the Matter controller", async () => {
    const interceptor = createToolCallInterceptor();
    const commission = vi.fn();
    const outcome = interceptor.intercept(commissionDevice, { pairing_code: CODE });

    // Dispatch as mcp-server does: the handler runs only on `proceed`.
    if (outcome.kind === "proceed") await commissionDevice.handler(outcome.args, ctxWith(commission));

    expect(outcome.kind).toBe("confirmation_required");
    expect(commission).not.toHaveBeenCalled();
  });

  it("the challenge never echoes the pairing code (credential material)", () => {
    const interceptor = createToolCallInterceptor();
    const outcome = interceptor.intercept(commissionDevice, { pairing_code: CODE });
    const serialized = JSON.stringify(interceptOutcomeToToolResult(commissionDevice, outcome));
    expect(serialized).not.toContain(CODE);
  });
});
