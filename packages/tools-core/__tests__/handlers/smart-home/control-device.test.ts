import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import controlDevice from "../../../src/handlers/smart-home/control-device.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithMatter(sendCommand: Mock): ToolContext {
  return {
    matter: {
      listDevices: vi.fn(),
      getDevice: vi.fn(),
      sendCommand,
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

describe("control_device", () => {
  it("flags write+confirmation", () => {
    expect(controlDevice.requiresWrite).toBe(true);
    expect(controlDevice.requiresConfirmation).toBe(true);
  });

  it("rejects missing node_id or command", async () => {
    const r = await controlDevice.handler({ node_id: "1" }, ctxWithMatter(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("delegates to matter.sendCommand and returns its result", async () => {
    const sendCommand = vi.fn().mockResolvedValue({ ok: true, applied: true });
    const r = await controlDevice.handler(
      { node_id: "1", command: "turn_on" },
      ctxWithMatter(sendCommand),
    );
    expect(sendCommand).toHaveBeenCalledWith("1", "turn_on", undefined);
    expect(r.ok).toBe(true);
  });

  it("forwards data argument", async () => {
    const sendCommand = vi.fn().mockResolvedValue({ ok: true });
    await controlDevice.handler(
      { node_id: "1", command: "set_brightness", data: { brightness: 75 } },
      ctxWithMatter(sendCommand),
    );
    expect(sendCommand).toHaveBeenCalledWith("1", "set_brightness", { brightness: 75 });
  });

  it("translates safety-tier confirmation_required result into a ToolResult", async () => {
    const sendCommand = vi.fn().mockResolvedValue({
      status: "confirmation_required",
      reason: "Lock unlock requires confirmation",
    });
    const r = await controlDevice.handler(
      { node_id: "1", command: "unlock" },
      ctxWithMatter(sendCommand),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.message).toMatch(/confirmation/);
    }
  });

  it("propagates matter exceptions as MATTER_COMMAND_FAILED", async () => {
    const sendCommand = vi.fn().mockRejectedValue(new Error("nope"));
    const r = await controlDevice.handler(
      { node_id: "1", command: "turn_on" },
      ctxWithMatter(sendCommand),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MATTER_COMMAND_FAILED");
  });
});
