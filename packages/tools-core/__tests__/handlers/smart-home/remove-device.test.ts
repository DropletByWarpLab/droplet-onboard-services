/**
 * WARP-1447 — `remove_device` tool tests.
 *
 * Pins the handler-enforced two-step contract (confirmation first, no
 * side effects until a server-minted token is presented), resolution by name /
 * Matter name / exact node id, ambiguity and not-found behavior, and
 * the DEVICE_NOT_FOUND vs REMOVE_FAILED error mapping on the actual
 * decommission call.
 */
import { describe, it, expect, vi } from "vitest";
import removeDevice from "../../../src/handlers/smart-home/remove-device.js";
import type { ToolContext } from "../../../src/types.js";

/** Grouped body the way the orchestrator's /api/matter/devices returns
 *  it (only the fields the handler reads). */
const GROUPED = {
  lights: [
    {
      nodeId: "7",
      name: "Hue bulb",
      friendlyName: "kitchen strip",
      roomName: "Kitchen",
    },
    { nodeId: "8", name: "IKEA bulb", friendlyName: null, roomName: null },
  ],
  switches: [],
  sensors: [],
  climate: [],
  media: [],
  covers: [],
  locks: [],
  other: [],
  _status: "connected", // non-array envelope field must be skipped
};

function ctxWith(overrides: {
  listDevices?: ReturnType<typeof vi.fn>;
  decommission?: ReturnType<typeof vi.fn>;
}): { ctx: ToolContext; decommission: ReturnType<typeof vi.fn> } {
  const decommission = overrides.decommission ?? vi.fn();
  const ctx: ToolContext = {
    matter: {
      listDevices: overrides.listDevices ?? vi.fn().mockResolvedValue(GROUPED),
      getDevice: vi.fn(),
      sendCommand: vi.fn(),
      discover: vi.fn(),
      commission: vi.fn(),
      decommission,
      getAuditLog: vi.fn(),
    },
    prisma: {} as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    signal: new AbortController().signal,
  };
  return { ctx, decommission };
}

describe("remove_device metadata", () => {
  it("registers as a Tier-2 write tool", () => {
    expect(removeDevice.name).toBe("remove_device");
    expect(removeDevice.requiresWrite).toBe(true);
    expect(removeDevice.requiresConfirmation).toBe(true);
  });
});

/**
 * WARP-2002 — drive the real two-phase flow: the first call is inert and
 * carries a server-minted token in its confirmation prompt; only that exact
 * token executes. The model cannot mint one and never sees it (the
 * orchestrator redacts it from the tool reply it feeds back).
 */
async function approved(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const first = await removeDevice.handler(args, ctx);
  if (first.ok) throw new Error("expected confirmation_required on the first call");
  const details = first.error.details as { confirmationToken?: string };
  if (typeof details?.confirmationToken !== "string") {
    throw new Error("first call minted no confirmation token");
  }
  return { ...args, confirmation_token: details.confirmationToken };
}

describe("remove_device argument validation", () => {
  it("rejects a missing device arg without touching the fabric", async () => {
    const { ctx, decommission } = ctxWith({});
    const r = await removeDevice.handler({}, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(decommission).not.toHaveBeenCalled();
  });
});

describe("remove_device confirmation-first contract", () => {
  it("returns confirmation_required naming the device, with NO side effects", async () => {
    const { ctx, decommission } = ctxWith({});
    const r = await removeDevice.handler({ device: "kitchen strip" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.message).toContain("kitchen strip");
      expect(r.error.message).toMatch(/unpaired/i);
      expect(r.error.details).toMatchObject({
        type: "remove_device",
        nodeId: "7",
        name: "kitchen strip",
      });
    }
    expect(decommission).not.toHaveBeenCalled();
  });

  // WARP-2002 — the model used to be able to self-approve by setting a boolean
  // it authored. These three cases are the regression guard for that.
  it("ignores a model-authored confirmed: true — self-attestation is dead", async () => {
    const { ctx, decommission } = ctxWith({});
    const r = await removeDevice.handler(
      { device: "kitchen strip", confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(decommission).not.toHaveBeenCalled();
  });

  it("refuses a fabricated confirmation_token", async () => {
    const { ctx, decommission } = ctxWith({});
    const r = await removeDevice.handler(
      { device: "kitchen strip", confirmation_token: "f".repeat(64) },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(decommission).not.toHaveBeenCalled();
  });

  it("refuses a token minted for a DIFFERENT device", async () => {
    const { ctx, decommission } = ctxWith({});
    // Approve removing node 8, then try to spend that approval on node 7.
    const forNode8 = await approved({ device: "8" }, ctx);
    const r = await removeDevice.handler(
      { device: "kitchen strip", confirmation_token: forNode8.confirmation_token },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(decommission).not.toHaveBeenCalled();
  });

  it("is single-use — replaying an approved token is refused", async () => {
    const decommission = vi.fn().mockResolvedValue({ status: "decommissioned" });
    const { ctx } = ctxWith({ decommission });
    const args = await approved({ device: "kitchen strip" }, ctx);
    expect((await removeDevice.handler(args, ctx)).ok).toBe(true);
    const replay = await removeDevice.handler(args, ctx);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.status).toBe("confirmation_required");
    expect(decommission).toHaveBeenCalledTimes(1);
  });
});

describe("remove_device confirmed happy path", () => {
  it("decommissions the resolved nodeId and reports removed: true", async () => {
    const decommission = vi
      .fn()
      .mockResolvedValue({ status: "decommissioned", nodeId: "7" });
    const { ctx } = ctxWith({ decommission });
    const r = await removeDevice.handler(
      await approved({ device: "kitchen strip" }, ctx),
      ctx,
    );
    expect(decommission).toHaveBeenCalledWith("7");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        type: "remove_device",
        nodeId: "7",
        name: "kitchen strip",
        removed: true,
      });
    }
  });
});

describe("remove_device resolution", () => {
  it("resolves by exact node id", async () => {
    const decommission = vi.fn().mockResolvedValue({});
    const { ctx } = ctxWith({ decommission });
    const r = await removeDevice.handler(await approved({ device: "8" }, ctx), ctx);
    expect(decommission).toHaveBeenCalledWith("8");
    expect(r.ok).toBe(true);
  });

  it("resolves by Matter-reported name, case-insensitively", async () => {
    const decommission = vi.fn().mockResolvedValue({});
    const { ctx } = ctxWith({ decommission });
    const r = await removeDevice.handler(
      await approved({ device: "hue BULB" }, ctx),
      ctx,
    );
    expect(decommission).toHaveBeenCalledWith("7");
    expect(r.ok).toBe(true);
  });

  it("returns AMBIGUOUS_DEVICE with candidates and no side effects", async () => {
    const listDevices = vi.fn().mockResolvedValue({
      lights: [
        { nodeId: "1", name: "Bulb A", friendlyName: "lamp" },
        { nodeId: "2", name: "Bulb B", friendlyName: "Lamp" },
      ],
    });
    const { ctx, decommission } = ctxWith({ listDevices });
    const r = await removeDevice.handler({ device: "lamp" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AMBIGUOUS_DEVICE");
      const details = r.error.details as { candidates: Array<{ nodeId: string }> };
      expect(details.candidates).toHaveLength(2);
      expect(details.candidates.map((c) => c.nodeId)).toEqual(["1", "2"]);
    }
    expect(decommission).not.toHaveBeenCalled();
  });

  it("returns DEVICE_NOT_FOUND for an unknown name, with no side effects", async () => {
    const { ctx, decommission } = ctxWith({});
    const r = await removeDevice.handler({ device: "toaster" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DEVICE_NOT_FOUND");
    expect(decommission).not.toHaveBeenCalled();
  });
});

describe("remove_device failure mapping", () => {
  it("maps the proxy's 404-shaped throw to DEVICE_NOT_FOUND", async () => {
    const decommission = vi
      .fn()
      .mockRejectedValue(new Error("decommission: no device with node ID 7"));
    const { ctx } = ctxWith({ decommission });
    const r = await removeDevice.handler(
      await approved({ device: "kitchen strip" }, ctx),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DEVICE_NOT_FOUND");
  });

  it("maps other decommission failures to REMOVE_FAILED", async () => {
    const decommission = vi
      .fn()
      .mockRejectedValue(
        new Error("decommission: orchestrator returned HTTP 503: Matter controller not started"),
      );
    const { ctx } = ctxWith({ decommission });
    const r = await removeDevice.handler(
      await approved({ device: "kitchen strip" }, ctx),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REMOVE_FAILED");
      expect(r.error.message).toContain("HTTP 503");
    }
  });

  it("maps a listDevices failure to REMOVE_FAILED without calling decommission", async () => {
    const listDevices = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { ctx, decommission } = ctxWith({ listDevices });
    // No approval flow here: resolution fails before the gate is reached, so
    // the caller never gets a prompt to approve.
    const r = await removeDevice.handler({ device: "kitchen strip" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("REMOVE_FAILED");
    expect(decommission).not.toHaveBeenCalled();
  });
});
