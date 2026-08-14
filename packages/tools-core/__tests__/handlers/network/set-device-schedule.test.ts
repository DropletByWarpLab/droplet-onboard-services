/**
 * WARP-1443 — `set_device_schedule` (set/clear are Tier 2 with the
 * handler-enforced two-step confirmation; list is a plain read).
 *
 * Semantics pinned here (verified against schedule.service.ts +
 * lib/schedule-window.ts): a schedule BLOCKS the device's internet
 * DURING each window and allows it at all other times, so the
 * confirmation echo must say "blocked during", never "outside".
 *
 * Wire shape: ScheduleWindow is { daysOfWeek, startMin, endMin } with a
 * 7-bit mask Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64 —
 * ["monday","friday"] → 2 + 32 = 34. endMin <= startMin wraps past
 * midnight and is valid. MACs are canonicalized to uppercase
 * colon-separated (lib/mac.ts parity).
 */
import { describe, it, expect, vi } from "vitest";
import setDeviceSchedule from "../../../src/handlers/network/set-device-schedule.js";
import { runApproved } from "../../helpers/approve.js";
import type { ToolContext } from "../../../src/types.js";

type Mocks = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

function ctxWith(mocks: Partial<Mocks> = {}): { ctx: ToolContext; mocks: Mocks } {
  const all: Mocks = {
    get: mocks.get ?? vi.fn(),
    post: mocks.post ?? vi.fn(),
    patch: mocks.patch ?? vi.fn(),
    del: mocks.del ?? vi.fn(),
  };
  const ctx: ToolContext = {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get: all.get, post: all.post, patch: all.patch, delete: all.del },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
  return { ctx, mocks: all };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const MAC = "AA:BB:CC:DD:EE:FF";
const WINDOW = { days: ["monday", "friday"], start: "16:00", end: "19:00" };
/** Existing schedule row as the orchestrator returns it (windows included). */
const EXISTING = {
  id: "s1",
  name: "Kids console",
  enabled: false,
  subjectType: "device",
  deviceMac: MAC,
  windows: [{ id: "w1", scheduleId: "s1", daysOfWeek: 34, startMin: 960, endMin: 1140 }],
};

function expectNoHttp(mocks: Mocks): void {
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.del).not.toHaveBeenCalled();
}

describe("set_device_schedule — tool metadata", () => {
  it("is named set_device_schedule and is Tier-2 (write + confirm)", () => {
    expect(setDeviceSchedule.name).toBe("set_device_schedule");
    expect(setDeviceSchedule.requiresWrite).toBe(true);
    expect(setDeviceSchedule.requiresConfirmation).toBe(true);
  });

  it("has an additionalProperties:false schema requiring operation + device_mac", () => {
    const schema = setDeviceSchedule.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["operation", "device_mac"]);
  });

  it("states the block-during-window direction in the description", () => {
    expect(setDeviceSchedule.description.toLowerCase()).toContain("blocked during");
  });
});

describe("set_device_schedule — argument validation (no HTTP)", () => {
  it("rejects an unknown operation", async () => {
    const { ctx, mocks } = ctxWith();
    const r = await runApproved(setDeviceSchedule, 
      { operation: "toggle", device_mac: MAC },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expectNoHttp(mocks);
  });

  it("rejects an invalid MAC", async () => {
    const { ctx, mocks } = ctxWith();
    const r = await runApproved(setDeviceSchedule, 
      { operation: "set", device_mac: "not-a-mac", windows: [WINDOW] },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("MAC");
    }
    expectNoHttp(mocks);
  });

  it("rejects set without at least one window", async () => {
    const { ctx, mocks } = ctxWith();
    const r = await runApproved(setDeviceSchedule, { operation: "set", device_mac: MAC }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_SCHEDULE");
    expectNoHttp(mocks);
  });

  it("rejects more than 7 windows (service parity)", async () => {
    const { ctx, mocks } = ctxWith();
    const windows = Array.from({ length: 8 }, (_, i) => ({
      days: ["monday"],
      start: `0${i}:00`.slice(-5),
      end: `0${i}:30`.slice(-5),
    }));
    const r = await runApproved(setDeviceSchedule, 
      { operation: "set", device_mac: MAC, windows },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_SCHEDULE");
      expect(r.error.message).toContain("7");
    }
    expectNoHttp(mocks);
  });

  it("rejects an unknown day name", async () => {
    const { ctx, mocks } = ctxWith();
    const r = await runApproved(setDeviceSchedule, 
      {
        operation: "set",
        device_mac: MAC,
        windows: [{ days: ["funday"], start: "16:00", end: "19:00" }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_SCHEDULE");
      expect(r.error.message).toContain("funday");
    }
    expectNoHttp(mocks);
  });

  it("rejects a malformed time", async () => {
    const { ctx, mocks } = ctxWith();
    const r = await runApproved(setDeviceSchedule, 
      {
        operation: "set",
        device_mac: MAC,
        windows: [{ days: ["monday"], start: "25:00", end: "19:00" }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_SCHEDULE");
      expect(r.error.message).toContain("HH:MM");
    }
    expectNoHttp(mocks);
  });

  it("rejects a zero-length window (start === end, service parity)", async () => {
    const { ctx, mocks } = ctxWith();
    const r = await runApproved(setDeviceSchedule, 
      {
        operation: "set",
        device_mac: MAC,
        windows: [{ days: ["monday"], start: "16:00", end: "16:00" }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_SCHEDULE");
    expectNoHttp(mocks);
  });
});

describe("set_device_schedule — list (read, no confirmation)", () => {
  it("returns the device's schedules decoded to day names + HH:MM without confirmed:true", async () => {
    const other = { ...EXISTING, id: "s2", deviceMac: "11:22:33:44:55:66" };
    const { ctx, mocks } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [EXISTING, other] })),
    });
    const r = await runApproved(setDeviceSchedule, { operation: "list", device_mac: MAC }, ctx);
    expect(mocks.get).toHaveBeenCalledWith("/api/network/schedules");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        type: "set_device_schedule",
        operation: "list",
        device_mac: MAC,
        schedules: [
          {
            id: "s1",
            name: "Kids console",
            enabled: false,
            windows: [{ days: ["monday", "friday"], start: "16:00", end: "19:00" }],
          },
        ],
      });
    }
  });

  it("maps a failed list read to SCHEDULE_FAILED", async () => {
    const { ctx } = ctxWith({
      get: vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    });
    const r = await runApproved(setDeviceSchedule, { operation: "list", device_mac: MAC }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCHEDULE_FAILED");
  });
});

describe("set_device_schedule — handler-enforced confirmation", () => {
  it("set: first call returns confirmation_required summarizing the windows with the BLOCK-DURING direction, NO HTTP", async () => {
    const { ctx, mocks } = ctxWith();
    const r = await runApproved(setDeviceSchedule, 
      { operation: "set", device_mac: MAC, windows: [WINDOW] },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(r.error.message).toContain(MAC);
      // Direction: internet is BLOCKED during the window, allowed otherwise.
      expect(r.error.message.toLowerCase()).toContain("blocked during");
      expect(r.error.message.toLowerCase()).toContain("allowed at all other times");
      expect(r.error.message).toContain("Mon");
      expect(r.error.message).toContain("Fri");
      expect(r.error.message).toContain("16:00");
      expect(r.error.message).toContain("19:00");
      expect(r.error.details).toMatchObject({
        type: "set_device_schedule",
        operation: "set",
        device_mac: MAC,
      });
    }
    expectNoHttp(mocks);
  });

  it("clear: first call returns confirmation_required naming the device, NO HTTP", async () => {
    const { ctx, mocks } = ctxWith();
    const r = await runApproved(setDeviceSchedule, { operation: "clear", device_mac: MAC }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.message).toContain(MAC);
      expect(r.error.details).toMatchObject({
        type: "set_device_schedule",
        operation: "clear",
        device_mac: MAC,
      });
    }
    expectNoHttp(mocks);
  });
});

describe("set_device_schedule — confirmed set", () => {
  it("creates a schedule when the device has none, pinning the mask conversion (mon+fri → 34)", async () => {
    const { ctx, mocks } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [] })),
      post: vi.fn().mockResolvedValue(json({ schedule: { ...EXISTING, id: "s9" } }, 201)),
    });
    // Lowercase dashed input pins the MAC canonicalization too.
    const r = await runApproved(setDeviceSchedule, 
      {
        operation: "set",
        device_mac: "aa-bb-cc-dd-ee-ff",
        windows: [WINDOW],
        confirmed: true,
      },
      ctx,
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith("/api/network/schedules", {
      name: `Schedule for ${MAC}`,
      enabled: true,
      subjectType: "device",
      deviceMac: MAC,
      windows: [{ daysOfWeek: 34, startMin: 960, endMin: 1140 }],
    });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        type: "set_device_schedule",
        operation: "set",
        device_mac: MAC,
        scheduleId: "s9",
        replaced: false,
      });
    }
  });

  it("replaces via PATCH when a schedule already targets the device (re-enabling it)", async () => {
    const { ctx, mocks } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [EXISTING] })),
      patch: vi.fn().mockResolvedValue(json({ schedule: EXISTING })),
    });
    const r = await runApproved(setDeviceSchedule, 
      {
        operation: "set",
        device_mac: MAC,
        windows: [{ days: ["sunday"], start: "21:00", end: "07:00" }],
        confirmed: true,
      },
      ctx,
    );
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    // Wrap-past-midnight window (endMin <= startMin) goes through as-is.
    expect(mocks.patch).toHaveBeenCalledWith("/api/network/schedules/s1", {
      enabled: true,
      windows: [{ daysOfWeek: 1, startMin: 1260, endMin: 420 }],
    });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        type: "set_device_schedule",
        operation: "set",
        device_mac: MAC,
        scheduleId: "s1",
        replaced: true,
      });
    }
  });
});

describe("set_device_schedule — confirmed clear", () => {
  it("deletes the device's schedule", async () => {
    const { ctx, mocks } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [EXISTING] })),
      del: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    });
    const r = await runApproved(setDeviceSchedule, 
      { operation: "clear", device_mac: MAC, confirmed: true },
      ctx,
    );
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith("/api/network/schedules/s1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        type: "set_device_schedule",
        operation: "clear",
        device_mac: MAC,
        cleared: 1,
      });
    }
  });

  it("returns SCHEDULE_NOT_FOUND when the device has no schedule to clear", async () => {
    const { ctx, mocks } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [] })),
    });
    const r = await runApproved(setDeviceSchedule, 
      { operation: "clear", device_mac: MAC, confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCHEDULE_NOT_FOUND");
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

describe("set_device_schedule — error mapping", () => {
  it("passes a server 400 through as INVALID_SCHEDULE with the server message", async () => {
    const { ctx } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [] })),
      post: vi.fn().mockResolvedValue(
        json(
          {
            error: {
              code: "SCHEDULE_INVALID_WINDOW",
              message: "Invalid schedule window: duplicate window",
              status: 400,
            },
          },
          400,
        ),
      ),
    });
    const r = await runApproved(setDeviceSchedule, 
      { operation: "set", device_mac: MAC, windows: [WINDOW], confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_SCHEDULE");
      expect(r.error.message).toContain("duplicate window");
    }
  });

  it("maps a 404 SCHEDULE_NOT_FOUND (schedule vanished mid-flight) to SCHEDULE_NOT_FOUND", async () => {
    const { ctx } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [EXISTING] })),
      patch: vi.fn().mockResolvedValue(
        json(
          { error: { code: "SCHEDULE_NOT_FOUND", message: "Schedule s1 not found", status: 404 } },
          404,
        ),
      ),
    });
    const r = await runApproved(setDeviceSchedule, 
      { operation: "set", device_mac: MAC, windows: [WINDOW], confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCHEDULE_NOT_FOUND");
  });

  it("maps a 404 NOT_FOUND (unknown device) to DEVICE_NOT_FOUND", async () => {
    const { ctx } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [] })),
      post: vi.fn().mockResolvedValue(
        json(
          { error: { code: "NOT_FOUND", message: `Device ${MAC} not found`, status: 404 } },
          404,
        ),
      ),
    });
    const r = await runApproved(setDeviceSchedule, 
      { operation: "set", device_mac: MAC, windows: [WINDOW], confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DEVICE_NOT_FOUND");
  });

  it("maps any other failure to SCHEDULE_FAILED", async () => {
    const { ctx } = ctxWith({
      get: vi.fn().mockResolvedValue(json({ schedules: [] })),
      post: vi.fn().mockResolvedValue(new Response("boom", { status: 502 })),
    });
    const r = await runApproved(setDeviceSchedule, 
      { operation: "set", device_mac: MAC, windows: [WINDOW], confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCHEDULE_FAILED");
  });
});
