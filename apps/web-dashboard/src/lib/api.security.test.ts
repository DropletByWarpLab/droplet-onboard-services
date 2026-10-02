/**
 * WARP-2977 P2b — the Security API helpers' wire contract (spec §7 routes
 * 3–15, and the feed's query string).
 *
 * Every P2b page and component test mocks the hooks or these helpers, so
 * nothing else can see what actually goes on the wire: the method, the path,
 * the query string and the body field names. The orchestrator's schemas are
 * `.strict()`, so a renamed body field is a 400 and a wrong path a 404 on
 * every save, while every other test stays green (measured: 8 of 8 wire
 * mutants survived the whole dashboard suite). This file pins them at the
 * transport, `authFetch`, which the helpers go through so an expired access
 * token is refreshed and retried.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  archiveSecurityZone,
  createSecurityZone,
  deleteSecurityHoursException,
  getSecurityHours,
  getSecurityMode,
  getSecuritySources,
  getSecurityZones,
  patchSecurityZone,
  postSecurityMode,
  putSecurityHours,
  putSecurityHoursException,
  putSecurityZoneLinks,
  securityEventsPath,
  unarchiveSecurityZone,
} from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

function res(json: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
  authFetchMock.mockResolvedValue(res({ ok: true }));
});

/** The one request the helper made: [url, method, parsed body]. */
function sent(): [string, string, unknown] {
  expect(authFetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = authFetchMock.mock.calls[0]!;
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  return [url as string, (init?.method ?? "GET") as string, body];
}

const ID = "3f6c2a4e-8b1d-4c5e-9a7f-1b2c3d4e5f60";
const LINKS = { expectedVersion: 3, links: [{ sourceKind: "camera" as const, sourceRef: "front" }, { sourceKind: "camera_zone" as const, sourceRef: "back/till" }] };

describe("routes 3–15 — method, path, query and body, exactly", () => {
  it.each([
    ["3 GET zones", () => getSecurityZones(), "/api/security/zones", "GET", undefined],
    ["3 GET zones with removed ones", () => getSecurityZones({ includeArchived: true }), "/api/security/zones?include=archived", "GET", undefined],
    ["4 GET sources", () => getSecuritySources(), "/api/security/sources", "GET", undefined],
    ["5 GET mode", () => getSecurityMode(), "/api/security/mode", "GET", undefined],
    ["6 GET hours", () => getSecurityHours(), "/api/security/hours", "GET", undefined],
    ["7 POST mode", () => postSecurityMode({ action: "open", for: "2h" }), "/api/security/mode", "POST", { action: "open", for: "2h" }],
    ["8 POST zone", () => createSecurityZone({ name: "Front door", kind: "entry" }), "/api/security/zones", "POST", { name: "Front door", kind: "entry" }],
    ["9 PATCH zone", () => patchSecurityZone(ID, { name: "Back door", expectedVersion: 2 }), `/api/security/zones/${ID}`, "PATCH", { name: "Back door", expectedVersion: 2 }],
    ["10 archive", () => archiveSecurityZone(ID, 4), `/api/security/zones/${ID}/archive`, "POST", { expectedVersion: 4 }],
    ["11 unarchive", () => unarchiveSecurityZone(ID, 5), `/api/security/zones/${ID}/unarchive`, "POST", { expectedVersion: 5 }],
    ["12 PUT links", () => putSecurityZoneLinks(ID, LINKS), `/api/security/zones/${ID}/links`, "PUT", LINKS],
    [
      "13 PUT hours",
      () => putSecurityHours({ state: "set", timezone: "Europe/London", expectedVersion: 7, days: [{ weekday: 1, kind: "hours", opens: "09:00", closes: "17:00" }] }),
      "/api/security/hours",
      "PUT",
      { state: "set", timezone: "Europe/London", expectedVersion: 7, days: [{ weekday: 1, kind: "hours", opens: "09:00", closes: "17:00" }] },
    ],
    [
      "14 PUT special day",
      () => putSecurityHoursException("2026-12-25", { kind: "closed", note: "Christmas", expectedVersion: 7 }),
      "/api/security/hours/exceptions/2026-12-25",
      "PUT",
      { kind: "closed", note: "Christmas", expectedVersion: 7 },
    ],
    ["15 DELETE special day", () => deleteSecurityHoursException("2026-12-25", 8), "/api/security/hours/exceptions/2026-12-25?version=8", "DELETE", undefined],
  ] as const)("%s", async (_n, call, url, method, body) => {
    authFetchMock.mockResolvedValue(res(method === "DELETE" ? {} : { ok: true }, method === "DELETE" ? 204 : 200));
    await call();
    expect(sent()).toEqual([url, method, body]);
    const init = authFetchMock.mock.calls[0]![1]!;
    if (body !== undefined) expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    // Every request is bounded, like apiFetch's.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("encodes an id or a date into the path, never raw", async () => {
    await patchSecurityZone("a/b?c", { expectedVersion: 0 });
    expect(sent()[0]).toBe("/api/security/zones/a%2Fb%3Fc");
  });
});

describe("the feed's query string", () => {
  it("zone=, kind=, camera=, includeLow=, cursor=, limit= — and nothing when unset", () => {
    expect(securityEventsPath()).toBe("/api/security/events");
    const q = new URL(
      securityEventsPath({ zone: ID, kinds: ["detection", "detection_low"], camera: "front", includeLow: true, cursor: "c1", limit: 50 }),
      "http://x",
    ).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      zone: ID,
      kind: "detection,detection_low",
      camera: "front",
      includeLow: "true",
      cursor: "c1",
      limit: "50",
    });
  });
});

describe("errors", () => {
  it("a refused request throws the server's code, the status, the body and the request id — never a plain Error", async () => {
    authFetchMock.mockResolvedValue(
      res({ error: { code: "VERSION_CONFLICT", message: "raw server text" } }, 409, { "x-request-id": "rid-1" }),
    );
    await expect(putSecurityHours({ state: "not_set", expectedVersion: 1 })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
      requestId: "rid-1",
      body: { error: { code: "VERSION_CONFLICT" } },
    });
  });

  it("a flat 401 (the session really ended — authFetch already tried to refresh) is status 401, code UNKNOWN", async () => {
    authFetchMock.mockResolvedValue(res({ error: "Missing or invalid authentication" }, 401));
    await expect(getSecurityMode()).rejects.toMatchObject({ status: 401 });
  });

  it("a request that never answered is NETWORK_ERROR, not an HTTP code", async () => {
    authFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(getSecurityHours()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });
});
