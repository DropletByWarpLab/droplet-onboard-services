/**
 * WARP-2981 (ADR-059 P6) — the Security wall's reads in `@/lib/api`.
 *
 * `fetch` is the only thing mocked, so authFetch and securityFetch run for
 * real. Pinned: each read is a GET of its one path with a timeout signal (a
 * TV cannot afford a request that never answers — it would stall its SWR key
 * for good); route 17's counts are validated so the wall never draws a number
 * it was not given; `session.endsAt` is taken only when it is a real time;
 * the camera list is this viewer's, and a disconnected camera system is never
 * read as "no cameras"; and a camera's picture bypasses the HTTP cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  getSecurityIncidentCounts,
  getSecurityWallHealth,
  getSignInEndsAt,
  getWallCameraSnapshot,
  getWallCameras,
  getWallModules,
  signInEndsAtOf,
} from "@/lib/api";

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: new Headers() };
}

/** A request that never answers until its signal aborts. */
function hangsUntilAborted(_url?: string, init?: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
}

function lastCall(): [string, RequestInit] {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("getSecurityIncidentCounts (route 17)", () => {
  it("GETs the summary with a timeout, and returns only the two counts", async () => {
    mockFetch.mockResolvedValue(reply(200, { openAlerts: 2, openNotices: 1, latest: [{ id: "i1", zone: { name: "Stock room" } }], alertsReady: true }));
    await expect(getSecurityIncidentCounts()).resolves.toEqual({ openAlerts: 2, openNotices: 1 });
    const [url, init] = lastCall();
    expect(url).toBe("/api/security/incidents/summary");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a negative count", { openAlerts: -1, openNotices: 0 }],
    ["a string", { openAlerts: "2", openNotices: 0 }],
    ["a fraction", { openAlerts: 1.5, openNotices: 0 }],
    ["a missing count", { openAlerts: 1 }],
    ["nothing", {}],
    ["null", null],
  ])("throws on %s — never a 0 it was not given", async (_why, body) => {
    mockFetch.mockResolvedValue(reply(200, body));
    await expect(getSecurityIncidentCounts()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("a 503 throws with its status (never an empty answer)", async () => {
    mockFetch.mockResolvedValue(reply(503, { error: { code: "INCIDENTS_UNAVAILABLE", message: "Incidents can't be read right now." } }));
    await expect(getSecurityIncidentCounts()).rejects.toMatchObject({ status: 503, code: "INCIDENTS_UNAVAILABLE" });
  });
});

describe("getSecurityWallHealth", () => {
  it("GETs the health rows with a timeout", async () => {
    const sources = [{ id: "camera_ingest", state: "ok", detail: "Listening", lastSeenAt: null }];
    mockFetch.mockResolvedValue(reply(200, { sources }));
    await expect(getSecurityWallHealth()).resolves.toEqual({ sources });
    expect(lastCall()[0]).toBe("/api/security/health");
    expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("no rows array → throws; a 503 → throws with its status", async () => {
    mockFetch.mockResolvedValue(reply(200, { sources: null }));
    await expect(getSecurityWallHealth()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    mockFetch.mockResolvedValue(reply(503, { error: "SECURITY_HEALTH_UNAVAILABLE" }));
    await expect(getSecurityWallHealth()).rejects.toMatchObject({ status: 503 });
  });
});

describe("signInEndsAtOf / getSignInEndsAt (P6-A's session.endsAt)", () => {
  it("takes a real time", () => {
    expect(signInEndsAtOf({ session: { endsAt: "2026-09-25T22:00:00.000Z" } })).toBe("2026-09-25T22:00:00.000Z");
  });

  it.each([
    ["no session (a login response, an older orchestrator)", { id: "u1" }],
    ["session null (the box can't tell)", { session: null }],
    ["a number", { session: { endsAt: 123 } }],
    ["not a time", { session: { endsAt: "soon" } }],
    ["not an object", "session"],
    ["nothing", null],
  ])("null for %s", (_why, body) => {
    expect(signInEndsAtOf(body)).toBeNull();
  });

  it("reads /api/auth/me with a timeout", async () => {
    mockFetch.mockResolvedValue(reply(200, { id: "u1", session: { endsAt: "2026-09-25T22:00:00.000Z" } }));
    await expect(getSignInEndsAt()).resolves.toBe("2026-09-25T22:00:00.000Z");
    expect(lastCall()[0]).toBe("/api/auth/me");
    expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("getWallModules", () => {
  it("reads /api/modules WITH a timeout (the nav gate's own read has none)", async () => {
    const view = { modules: [{ id: "security", effective: true }] };
    mockFetch.mockResolvedValue(reply(200, view));
    await expect(getWallModules()).resolves.toEqual(view);
    expect(lastCall()[0]).toBe("/api/modules");
    expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("a hung read is given up (a TIMEOUT error), never left pending", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation(hangsUntilAborted);
      const pending = getWallModules();
      const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT", status: 0 });
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a body without the modules list throws", async () => {
    mockFetch.mockResolvedValue(reply(200, { effectiveForUser: [] }));
    await expect(getWallModules()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
});

describe("getWallCameras (GET /api/cameras, narrowed to this viewer's grants by the server)", () => {
  it("GETs the list with a timeout and returns it as given", async () => {
    const cameras = [{ name: "till", displayName: "Till", status: "recording", enabled: true }];
    mockFetch.mockResolvedValue(reply(200, { cameras }));
    await expect(getWallCameras()).resolves.toEqual(cameras);
    expect(lastCall()[0]).toBe("/api/cameras");
    expect(lastCall()[1].method ?? "GET").toBe("GET");
    expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("the camera system disconnected: its empty list throws — it does not mean 'no cameras'", async () => {
    mockFetch.mockResolvedValue(reply(200, { cameras: [], _status: "disconnected" }));
    await expect(getWallCameras()).rejects.toMatchObject({ code: "CAMERAS_DISCONNECTED" });
  });

  it.each([
    ["no list", {}],
    ["a list of the wrong shape", { cameras: [{ displayName: "Till" }] }],
    ["not an array", { cameras: "till" }],
  ])("%s throws", async (_why, body) => {
    mockFetch.mockResolvedValue(reply(200, body));
    await expect(getWallCameras()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("a 404 (Cameras not open to this viewer) throws with its status", async () => {
    mockFetch.mockResolvedValue(reply(404, { error: { code: "NOT_FOUND", message: "x" } }));
    await expect(getWallCameras()).rejects.toMatchObject({ status: 404 });
  });
});

describe("getWallCameraSnapshot", () => {
  it("GETs one camera's latest picture at 720 px, past the HTTP cache, with a timeout — and hands back the image", async () => {
    const jpeg = new Blob(["jpeg"], { type: "image/jpeg" });
    mockFetch.mockResolvedValue({ ok: true, status: 200, blob: () => Promise.resolve(jpeg), headers: new Headers() });
    await expect(getWallCameraSnapshot("back door")).resolves.toBe(jpeg);
    const [url, init] = lastCall();
    expect(url).toBe("/api/cameras/back%20door/snapshot?h=720");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("anything but 2xx rejects with its status — never an empty picture", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 502, blob: () => Promise.resolve(new Blob()), headers: new Headers() });
    await expect(getWallCameraSnapshot("till")).rejects.toMatchObject({ status: 502 });
  });

  it("a hung picture is given up after 20 s (a TIMEOUT error)", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation(hangsUntilAborted);
      const pending = getWallCameraSnapshot("till");
      const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT", status: 0 });
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
