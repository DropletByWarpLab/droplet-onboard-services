/**
 * WARP-2981 (ADR-059 P6) — the Security wall's reads in `@/lib/api`.
 *
 * `fetch` is the only thing mocked, so authFetch and securityFetch run for
 * real. Pinned: each read is a GET of its one path with a timeout signal (a
 * TV cannot afford a request that never answers — it would stall its SWR key
 * for good); route 17's counts are validated so the wall never draws a number
 * it was not given; `session.endsAt` is taken only when it is a real time; and
 * the camera check is a GET that is aborted as soon as its status is read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  getBirdseyeStatus,
  getSecurityIncidentCounts,
  getSecurityWallHealth,
  getSignInEndsAt,
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

describe("getBirdseyeStatus", () => {
  it("a GET whose status is read off the headers, then aborted — never HEAD", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, headers: new Headers() });
    await expect(getBirdseyeStatus()).resolves.toBe(404);
    const [url, init] = lastCall();
    expect(url).toBe("/api/cameras/birdseye/live");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.signal!.aborted).toBe(true);
  });

  it("the caller's signal aborting abandons the check", async () => {
    mockFetch.mockImplementation(hangsUntilAborted);
    const ctrl = new AbortController();
    const pending = getBirdseyeStatus(ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toBeTruthy();
  });
});
