/**
 * device-gateway.client.ts — the bearer it presents and how gateway answers
 * become DeviceGatewayError statuses the routes can pass through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    DEVICE_GATEWAY_URL: "http://gw.test:8084",
    SERVICE_TOKEN_DEVICE_GATEWAY: "gw-token",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../config.js", () => ({ config: mockConfig }));

import { DeviceGatewayError, listDevices, writePoint, deleteDevice } from "../services/device-gateway.client.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

async function failure(p: Promise<unknown>): Promise<DeviceGatewayError> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(DeviceGatewayError);
  return err as DeviceGatewayError;
}

describe("device-gateway client", () => {
  it("sends the dedicated bearer and the JSON body", async () => {
    fetchSpy.mockResolvedValue(json(200, { applied: false }));
    await writePoint("rtu-1", "setpoint", 21.5);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://gw.test:8084/devices/rtu-1/points/setpoint/write");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer gw-token");
    expect(JSON.parse(init.body)).toEqual({ value: 21.5 });
  });

  it("unwraps the device list", async () => {
    fetchSpy.mockResolvedValue(json(200, { devices: [{ id: "a" }] }));
    expect(await listDevices()).toEqual([{ id: "a" }]);
  });

  it("treats 204 as success", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deleteDevice("a")).resolves.toBeUndefined();
  });

  it("maps the gateway's fail-closed 403 to 503 gateway_auth", async () => {
    fetchSpy.mockResolvedValue(json(403, { error: "Invalid or missing service token" }));
    const e = await failure(listDevices());
    expect([e.status, e.code]).toEqual([503, "gateway_auth"]);
  });

  it("maps a connection failure to 503 gateway_unreachable", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    const e = await failure(listDevices());
    expect([e.status, e.code]).toEqual([503, "gateway_unreachable"]);
  });

  it("passes 4xx and 502 through with the gateway's detail", async () => {
    fetchSpy.mockResolvedValue(json(422, { detail: { error: "write_rejected", detail: "setpoint must be at most 28" } }));
    let e = await failure(writePoint("rtu-1", "setpoint", 40));
    expect([e.status, e.code, e.message]).toEqual([422, "write_rejected", "setpoint must be at most 28"]);

    fetchSpy.mockResolvedValue(json(404, { detail: "no device rtu-9" }));
    e = await failure(writePoint("rtu-9", "setpoint", 20));
    expect([e.status, e.message]).toEqual([404, "no device rtu-9"]);

    fetchSpy.mockResolvedValue(json(502, { detail: { error: "unreachable", detail: "rtu-1: timeout" } }));
    e = await failure(writePoint("rtu-1", "setpoint", 20));
    expect([e.status, e.code]).toEqual([502, "unreachable"]);
  });

  it("flattens pydantic validation errors into one message", async () => {
    fetchSpy.mockResolvedValue(json(422, { detail: [{ loc: ["points", 0, "min"], msg: "needs min" }] }));
    const e = await failure(writePoint("a", "b", 1));
    expect([e.code, e.message]).toEqual(["invalid_device", "points.0.min: needs min"]);
  });

  it("reports any other 5xx as the gateway failing (503)", async () => {
    fetchSpy.mockResolvedValue(json(500, {}));
    expect((await failure(listDevices())).status).toBe(503);
  });
});
