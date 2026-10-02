import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getBuildingDevices from "../../../src/handlers/smart-home/get-building-devices.js";
import setBuildingPoint, { coerce } from "../../../src/handlers/smart-home/set-building-point.js";
import type { ToolContext } from "../../../src/types.js";

// Both tools go through `ctx.http.orchestrator` (/api/building/*), never a
// direct service client.
function ctx(get: Mock, post: Mock = vi.fn()): ToolContext {
  return {
    http: {
      orchestrator: { get, post, patch: vi.fn(), delete: vi.fn() },
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const RTU = {
  id: "rtu-1", name: "Rooftop unit", protocol: "modbus", room: "Roof", address: "10.0.0.5",
  points: [
    { id: "setpoint", name: "Setpoint", kind: "number", unit: "°C", writable: true, min: 16, max: 28 },
    { id: "supply", name: "Supply temp", kind: "number", unit: "°C", writable: false },
    { id: "fan", name: "Fan", kind: "boolean", writable: true },
  ],
};

describe("get_building_devices", () => {
  it("is a read", () => {
    expect(getBuildingDevices.requiresWrite).toBe(false);
  });

  it("without a device, lists devices and points (no live reads, no addresses)", async () => {
    const get = vi.fn().mockResolvedValue(json({ devices: [RTU] }));
    const r = await getBuildingDevices.handler({}, ctx(get));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/building/devices");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const [d] = r.data as Array<Record<string, unknown>>;
      expect(d).not.toHaveProperty("address");
      expect(d.points).toEqual([
        { id: "setpoint", name: "Setpoint", unit: "°C", writable: true, min: 16, max: 28 },
        { id: "supply", name: "Supply temp", unit: "°C", writable: false },
        { id: "fan", name: "Fan", unit: undefined, writable: true },
      ]);
    }
  });

  it("with a device, joins point metadata with one live read", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(json(RTU))
      .mockResolvedValueOnce(json({
        device_id: "rtu-1", read_at: "2026-09-24T10:00:00Z",
        values: { setpoint: { value: 21, error: null }, supply: { value: null, error: "timeout" } },
      }));
    const r = await getBuildingDevices.handler({ device: "rtu-1" }, ctx(get));
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      "/api/building/devices/rtu-1",
      "/api/building/devices/rtu-1/values",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const points = (r.data as { points: Array<Record<string, unknown>> }).points;
      expect(points[0]).toMatchObject({ id: "setpoint", value: 21 });
      expect(points[1]).toMatchObject({ id: "supply", value: null, error: "timeout" });
      expect(points[2]).toMatchObject({ id: "fan", value: null });
    }
  });

  it("reports an unknown device", async () => {
    const r = await getBuildingDevices.handler({ device: "nope" }, ctx(vi.fn().mockResolvedValue(json({}, 404))));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DEVICE_NOT_FOUND");
  });
});

describe("set_building_point", () => {
  it("is a confirmed write owned by the interceptor, not the route", () => {
    expect(setBuildingPoint.requiresWrite).toBe(true);
    expect(setBuildingPoint.requiresConfirmation).toBe(true);
    expect(setBuildingPoint.handler.toString()).not.toContain("passThroughConfirmation");
  });

  it("coerces the string value to the point's kind and posts it", async () => {
    const get = vi.fn().mockResolvedValue(json(RTU));
    const post = vi.fn().mockResolvedValue(json({ applied: true, readback: { value: 21.5, error: null } }));
    const r = await setBuildingPoint.handler({ device: "rtu-1", point: "setpoint", value: "21.5" }, ctx(get, post));
    expect(get).toHaveBeenCalledWith("/api/building/devices/rtu-1");
    expect(post).toHaveBeenCalledWith("/api/building/devices/rtu-1/points/setpoint/write", { value: 21.5 });
    expect(r).toEqual({ ok: true, data: { applied: true, readback: { value: 21.5, error: null } } });
  });

  it("maps on/off to booleans", async () => {
    const post = vi.fn().mockResolvedValue(json({ applied: true }));
    await setBuildingPoint.handler({ device: "rtu-1", point: "fan", value: "off" }, ctx(vi.fn().mockResolvedValue(json(RTU)), post));
    expect(post.mock.calls[0][1]).toEqual({ value: false });
  });

  it("refuses read-only points and bad values before posting", async () => {
    const post = vi.fn();
    const get = () => vi.fn().mockResolvedValue(json(RTU));
    let r = await setBuildingPoint.handler({ device: "rtu-1", point: "supply", value: "20" }, ctx(get(), post));
    expect(!r.ok && r.error.code).toBe("READ_ONLY");
    r = await setBuildingPoint.handler({ device: "rtu-1", point: "setpoint", value: "warm" }, ctx(get(), post));
    expect(!r.ok && r.error.code).toBe("INVALID_VALUE");
    r = await setBuildingPoint.handler({ device: "rtu-1", point: "nope", value: "1" }, ctx(get(), post));
    expect(!r.ok && r.error.code).toBe("POINT_NOT_FOUND");
    expect(post).not.toHaveBeenCalled();
  });

  it("surfaces the gateway's bounds refusal", async () => {
    const post = vi.fn().mockResolvedValue(json({ error: "setpoint must be at most 28", code: "write_rejected" }, 422));
    const r = await setBuildingPoint.handler({ device: "rtu-1", point: "setpoint", value: "40" }, ctx(vi.fn().mockResolvedValue(json(RTU)), post));
    expect(r).toEqual({ ok: false, status: "error", error: { code: "WRITE_REJECTED", message: "setpoint must be at most 28" } });
  });

  it("says plainly when live writes are off", async () => {
    const post = vi.fn().mockResolvedValue(json({ applied: false, live_writes: false, plan: { value: 21 } }));
    const r = await setBuildingPoint.handler({ device: "rtu-1", point: "setpoint", value: "21" }, ctx(vi.fn().mockResolvedValue(json(RTU)), post));
    expect(r.ok && (r.data as { applied: boolean; note: string })).toMatchObject({ applied: false, note: expect.stringMatching(/nothing was sent/) });
  });

  it.each([
    ["number", "1e3", 1000],
    ["number", 7, 7],
    ["boolean", true, true],
    ["boolean", "ON", true],
    ["text", 12, "12"],
  ])("coerce(%s, %j) → %j", (kind, raw, value) => {
    expect(coerce(kind, raw)).toEqual({ ok: true, value });
  });

  it.each([["number", ""], ["number", true], ["number", "NaN"], ["boolean", "maybe"]])(
    "coerce(%s, %j) is refused",
    (kind, raw) => {
      expect(coerce(kind, raw).ok).toBe(false);
    },
  );
});
