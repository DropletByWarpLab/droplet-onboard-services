/**
 * WARP-3511 — how the dashboard's camera calls treat a camera service that is
 * unreachable or restarting.
 *
 * The box answers a Frigate outage with 503 and `X-Droplet-Degraded:
 * frigate-unavailable` (WARP-3105's marker). That has to read as "the camera
 * service is down, ask again" — the existing `CamerasUnavailableError` the
 * Events page already branches on — and not as a generic failure whose SWR
 * retries run forever against a restarting box.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  disableCamera,
  enableCamera,
  fetchCameraSettings,
  fetchPtzCapabilities,
  fetchRetentionBackfillPlan,
  patchCameraSettings,
  runRetentionBackfill,
} from "./api";
import { authFetch } from "./auth";
import { isCamerasUnavailableError } from "./files-unavailable";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const DOWN = { "X-Droplet-Degraded": "frigate-unavailable" };

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("fetchCameraSettings", () => {
  it("returns the settings", async () => {
    authFetchMock.mockResolvedValue(res(200, { settings: { detectFps: 5 } }));
    await expect(fetchCameraSettings("front_door")).resolves.toEqual({ detectFps: 5 });
  });

  it("a 503 with the camera-service marker is 'cameras unavailable', not a failure", async () => {
    authFetchMock.mockResolvedValue(res(503, { error: "frigate_unavailable", degraded: true }, DOWN));
    const err = await fetchCameraSettings("front_door").catch((e) => e);
    expect(isCamerasUnavailableError(err)).toBe(true);
  });

  it("a 503 WITHOUT the marker is an ordinary failure", async () => {
    authFetchMock.mockResolvedValue(res(503, { error: "something else" }));
    const err = await fetchCameraSettings("front_door").catch((e) => e);
    expect(isCamerasUnavailableError(err)).toBe(false);
    expect((err as Error).message).toBe("something else");
  });

  it("keeps the server's message for a real error", async () => {
    authFetchMock.mockResolvedValue(res(404, { error: "camera ghost not found" }));
    await expect(fetchCameraSettings("ghost")).rejects.toThrow("camera ghost not found");
  });
});

describe("patchCameraSettings", () => {
  it("a 503 with the marker is 'cameras unavailable'", async () => {
    authFetchMock.mockResolvedValue(res(503, { degraded: true }, DOWN));
    const err = await patchCameraSettings("front_door", { detectFps: 5 }).catch((e) => e);
    expect(isCamerasUnavailableError(err)).toBe(true);
  });

  it("a rejected value keeps its message so the form can show it", async () => {
    authFetchMock.mockResolvedValue(res(400, { error: "detectFps must be between 1 and 30" }));
    await expect(patchCameraSettings("front_door", { detectFps: 99 })).rejects.toThrow(
      "detectFps must be between 1 and 30",
    );
  });
});

describe("fetchPtzCapabilities — a camera with nothing to control is not an error", () => {
  it("returns the capabilities", async () => {
    const caps = { supported: true, supportsPanTilt: true, supportsZoom: false, presets: ["door"] };
    authFetchMock.mockResolvedValue(res(200, caps));
    await expect(fetchPtzCapabilities("front_door")).resolves.toEqual(caps);
  });

  it("passes the degraded flag through so a caller can ask again", async () => {
    authFetchMock.mockResolvedValue(
      res(200, { supported: false, supportsPanTilt: false, supportsZoom: false, presets: [], degraded: true }, DOWN),
    );
    const caps = await fetchPtzCapabilities("front_door");
    expect(caps.degraded).toBe(true);
  });

  it.each([401, 403, 404, 500, 503])("a %i is 'no PTZ' — never a thrown error SWR would retry", async (status) => {
    authFetchMock.mockResolvedValue(res(status, {}));
    await expect(fetchPtzCapabilities("front_door")).resolves.toEqual({
      supported: false,
      supportsPanTilt: false,
      supportsZoom: false,
      presets: [],
    });
  });
});

describe("enableCamera / disableCamera — a failure says why", () => {
  it("enable: the server's own message reaches the caller", async () => {
    authFetchMock.mockResolvedValue(res(404, { error: "camera ghost not found" }));
    await expect(enableCamera("ghost")).rejects.toThrow("camera ghost not found");
  });

  it("enable: an unreachable camera service is 'cameras unavailable'", async () => {
    authFetchMock.mockResolvedValue(res(503, { degraded: true }, DOWN));
    const err = await enableCamera("front_door").catch((e) => e);
    expect(isCamerasUnavailableError(err)).toBe(true);
  });

  it("enable: falls back to a status line when the body says nothing", async () => {
    authFetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(enableCamera("front_door")).rejects.toThrow("Failed to enable camera: 500");
  });

  it("disable: a blocked command surfaces the reason", async () => {
    authFetchMock.mockResolvedValue(res(429, { error: "Too many camera changes. Wait a minute.", blocked: true }));
    await expect(disableCamera("front_door")).rejects.toThrow("Too many camera changes. Wait a minute.");
  });

  it("disable: still completes the Tier-2 handshake when the route answers 202", async () => {
    authFetchMock
      .mockResolvedValueOnce(res(202, { status: "confirmation_required", confirmationToken: "tok-1" }))
      .mockResolvedValueOnce(res(200, { status: "ok" }));
    await expect(disableCamera("front_door")).resolves.toBeUndefined();
    expect(authFetchMock).toHaveBeenCalledTimes(2);
    const [, confirmInit] = authFetchMock.mock.calls[1];
    expect(JSON.parse(String((confirmInit as RequestInit).body))).toEqual({
      confirmationToken: "tok-1",
      operation: "disable_camera",
    });
  });
});

describe("disable — the confirm step is where the write happens", () => {
  const tier2 = () => res(202, { status: "confirmation_required", confirmationToken: "tok-1" });

  it("an unreachable camera service at the confirm step is 'cameras unavailable'", async () => {
    authFetchMock.mockResolvedValueOnce(tier2()).mockResolvedValueOnce(res(503, { degraded: true }, DOWN));
    const err = await disableCamera("front_door").catch((e) => e);
    expect(isCamerasUnavailableError(err)).toBe(true);
  });

  it("a refused confirm keeps its reason", async () => {
    authFetchMock
      .mockResolvedValueOnce(tier2())
      .mockResolvedValueOnce(res(400, { error: "That confirmation has expired.", code: "TOKEN_EXPIRED" }));
    await expect(disableCamera("front_door")).rejects.toThrow("That confirmation has expired.");
  });

  it("falls back to a status line when the confirm says nothing", async () => {
    authFetchMock.mockResolvedValueOnce(tier2()).mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(disableCamera("front_door")).rejects.toThrow("Confirm failed: 500");
  });
});

describe("retention repair", () => {
  it("reads the dry-run plan and the windows the repair would write", async () => {
    const plan = [{ camera: "front_door", reason: "no_retention_authored", willWrite: true }];
    const defaults = { continuousDays: 13, motionDays: 17, alertsRetainDays: 23, detectionsRetainDays: 29 };
    authFetchMock.mockResolvedValue(res(200, { plan, defaults }));
    await expect(fetchRetentionBackfillPlan()).resolves.toEqual({ plan, defaults });
    expect(String(authFetchMock.mock.calls[0][0])).toContain("/api/cameras/retention/backfill");
  });

  it("a box that sends no defaults still gives the plan, and says nothing about figures", async () => {
    const plan = [{ camera: "front_door", reason: "no_retention_authored", willWrite: true }];
    authFetchMock.mockResolvedValue(res(200, { plan }));
    await expect(fetchRetentionBackfillPlan()).resolves.toEqual({ plan, defaults: undefined });
  });

  it("a body with no plan is an empty plan", async () => {
    authFetchMock.mockResolvedValue(res(200, {}));
    await expect(fetchRetentionBackfillPlan()).resolves.toEqual({ plan: [], defaults: undefined });
  });

  it("applies it with a POST and returns what was written", async () => {
    const result = { planned: [], written: ["front_door"], noop: false };
    authFetchMock.mockResolvedValue(res(200, result));
    await expect(runRetentionBackfill()).resolves.toEqual(result);
    const [, init] = authFetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
  });

  it("surfaces a refusal with the server's message", async () => {
    authFetchMock.mockResolvedValue(res(403, { error: "Forbidden" }));
    await expect(runRetentionBackfill()).rejects.toThrow("Forbidden");
  });

  it("an unreachable camera service is 'cameras unavailable' for the plan as well", async () => {
    authFetchMock.mockResolvedValue(res(503, { degraded: true }, DOWN));
    const err = await fetchRetentionBackfillPlan().catch((e) => e);
    expect(isCamerasUnavailableError(err)).toBe(true);
  });
});
