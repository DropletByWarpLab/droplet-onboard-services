/**
 * WARP-2978 (ADR-059 P3 §7 routes 16–22) — the dashboard's client for
 * incidents, acknowledgement and who is told about alerts.
 *
 * Every helper goes through `securityFetch` (authFetch: the session cookie and
 * a token refresh) and throws the typed error — `.code` is the server's
 * `error.code`, `.status` the HTTP status — so the page can render
 * `translateError(err, "security")` and never the server's own message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  acknowledgeSecurityIncident,
  getAlertRouting,
  getSecurityIncident,
  getSecurityIncidentSummary,
  getSecurityIncidents,
  putAlertRouting,
  resolveSecurityIncident,
  securityIncidentsPath,
  setSecurityIncidentVerdict,
} from "@/lib/api";

const ID = "7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f";

function ok(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body), headers: new Headers() };
}

function failing(status: number, code: string) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code, message: "raw server text" } }),
    headers: new Headers(),
  };
}

function lastCall(): [string, RequestInit] {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
}

beforeEach(() => mockFetch.mockReset());

describe("route 16 — the incident list", () => {
  it("GETs /api/security/incidents with only the options given", async () => {
    mockFetch.mockResolvedValueOnce(ok({ incidents: [], nextCursor: null }));
    const page = await getSecurityIncidents();
    const [url, init] = lastCall();
    expect(url).toBe("/api/security/incidents");
    expect(init).toMatchObject({ credentials: "same-origin" });
    expect(page).toEqual({ incidents: [], nextCursor: null });
  });

  it("passes state, severity, zone, limit and cursor as query parameters", () => {
    const url = securityIncidentsPath({ state: "attention", severity: "alert", zone: ID, limit: 30, cursor: `1790000000000.${ID}` });
    const q = new URL(url, "https://box.local").searchParams;
    expect(new URL(url, "https://box.local").pathname).toBe("/api/security/incidents");
    expect(Object.fromEntries(q)).toEqual({ state: "attention", severity: "alert", zone: ID, limit: "30", cursor: `1790000000000.${ID}` });
  });

  it("throws the typed error on a 503 — an outage is never an empty list", async () => {
    mockFetch.mockResolvedValueOnce(failing(503, "INCIDENTS_UNAVAILABLE"));
    await expect(getSecurityIncidents()).rejects.toMatchObject({ code: "INCIDENTS_UNAVAILABLE", status: 503 });
  });
});

describe("route 17 — the summary", () => {
  it("GETs /api/security/incidents/summary", async () => {
    const body = { openAlerts: 2, openNotices: 1, latest: [], alertsReady: true };
    mockFetch.mockResolvedValueOnce(ok(body));
    await expect(getSecurityIncidentSummary()).resolves.toEqual(body);
    expect(lastCall()[0]).toBe("/api/security/incidents/summary");
  });
});

describe("route 18 — one incident", () => {
  it("GETs the incident by its (encoded) id", async () => {
    mockFetch.mockResolvedValueOnce(ok({ id: ID }));
    await getSecurityIncident(ID);
    expect(lastCall()[0]).toBe(`/api/security/incidents/${ID}`);
  });

  it("a 404 carries INCIDENT_NOT_FOUND — the same for a missing and a hidden incident", async () => {
    mockFetch.mockResolvedValueOnce(failing(404, "INCIDENT_NOT_FOUND"));
    await expect(getSecurityIncident(ID)).rejects.toMatchObject({ code: "INCIDENT_NOT_FOUND", status: 404 });
  });
});

describe("routes 19–20 — acknowledge and resolve", () => {
  it("acknowledge POSTs {} without a notification, and {notificationId} with one", async () => {
    mockFetch.mockResolvedValue(ok({ incident: { id: ID }, changed: true }));
    await acknowledgeSecurityIncident(ID);
    let [url, init] = lastCall();
    expect(url).toBe(`/api/security/incidents/${ID}/acknowledge`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});

    await acknowledgeSecurityIncident(ID, { notificationId: "clx9abc" });
    [url, init] = lastCall();
    expect(JSON.parse(String(init.body))).toEqual({ notificationId: "clx9abc" });
  });

  it("resolve POSTs the note only when there is one (the body is strict on the box)", async () => {
    mockFetch.mockResolvedValue(ok({ incident: { id: ID }, changed: true }));
    await resolveSecurityIncident(ID, { note: "It was the cleaner." });
    let [url, init] = lastCall();
    expect(url).toBe(`/api/security/incidents/${ID}/resolve`);
    expect(JSON.parse(String(init.body))).toEqual({ note: "It was the cleaner." });

    await resolveSecurityIncident(ID, { note: "   " });
    [, init] = lastCall();
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  // WARP-2980 (P5 PR-C) — route 35: Expected / Not expected.
  it("verdict POSTs exactly {verdict} to …/verdict (the body is strict on the box)", async () => {
    mockFetch.mockResolvedValue(ok({ incident: { id: ID }, changed: true }));
    await expect(setSecurityIncidentVerdict(ID, "expected")).resolves.toEqual({ incident: { id: ID }, changed: true });
    let [url, init] = lastCall();
    expect(url).toBe(`/api/security/incidents/${ID}/verdict`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ verdict: "expected" });

    await setSecurityIncidentVerdict(ID, "not_expected");
    [, init] = lastCall();
    expect(JSON.parse(String(init.body))).toEqual({ verdict: "not_expected" });
  });

  it("a verdict with nothing to judge throws NOT_JUDGEABLE with its status", async () => {
    mockFetch.mockResolvedValueOnce(failing(409, "NOT_JUDGEABLE"));
    await expect(setSecurityIncidentVerdict(ID, "expected")).rejects.toMatchObject({ code: "NOT_JUDGEABLE", status: 409 });
  });

  it("a lost race throws INCIDENT_CONFLICT with its status", async () => {
    mockFetch.mockResolvedValueOnce(failing(409, "INCIDENT_CONFLICT"));
    await expect(acknowledgeSecurityIncident(ID)).rejects.toMatchObject({ code: "INCIDENT_CONFLICT", status: 409 });
  });
});

describe("routes 21–22 — who is told about alerts", () => {
  it("GETs /api/security/alert-routing", async () => {
    mockFetch.mockResolvedValueOnce(ok({ level: "act", self: { state: "receiving", eligible: true } }));
    await expect(getAlertRouting()).resolves.toEqual({ level: "act", self: { state: "receiving", eligible: true } });
    expect(lastCall()[0]).toBe("/api/security/alert-routing");
  });

  it("PUTs the state with the version it read (null creates the row)", async () => {
    mockFetch.mockResolvedValue(ok({ person: { userId: ID } }));
    await putAlertRouting(ID, { state: "receiving", expectedVersion: null });
    const [url, init] = lastCall();
    expect(url).toBe(`/api/security/alert-routing/${ID}`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ state: "receiving", expectedVersion: null });
  });

  it("the last receiver switched off throws NO_RECIPIENT", async () => {
    mockFetch.mockResolvedValueOnce(failing(409, "NO_RECIPIENT"));
    await expect(putAlertRouting(ID, { state: "not_receiving", expectedVersion: 3 })).rejects.toMatchObject({
      code: "NO_RECIPIENT",
      status: 409,
    });
  });
});
