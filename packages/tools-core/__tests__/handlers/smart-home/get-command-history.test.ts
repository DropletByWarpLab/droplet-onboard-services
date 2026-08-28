import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getCommandHistory from "../../../src/handlers/smart-home/get-command-history.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(getAuditLog: Mock): ToolContext {
  return {
    matter: {
      listDevices: vi.fn(),
      getDevice: vi.fn(),
      sendCommand: vi.fn(),
      discover: vi.fn(),
      commission: vi.fn(),
      decommission: vi.fn(),
      getAuditLog,
    },
    prisma: {} as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    signal: new AbortController().signal,
  };
}

describe("get_command_history", () => {
  it("calls getAuditLog with empty opts when no args", async () => {
    const fn = vi.fn().mockResolvedValue({ entries: [] });
    await getCommandHistory.handler({}, ctxWith(fn));
    expect(fn).toHaveBeenCalledWith({});
  });

  it("prefixes node_id into entityId and clamps limit", async () => {
    const fn = vi.fn().mockResolvedValue({ entries: [] });
    await getCommandHistory.handler({ node_id: "1", limit: 9999 }, ctxWith(fn));
    expect(fn).toHaveBeenCalledWith({ entityId: "matter.1", limit: 200 });
  });
});
