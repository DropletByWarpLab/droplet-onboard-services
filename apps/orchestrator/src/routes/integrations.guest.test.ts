/**
 * WARP-3374 (Romain, 2026-09-30) — `GET /api/connectors` lists which business
 * systems are connected, which provider is which, when each last synced and
 * when a credential expires. That is the company's own topology: owner and admin
 * only (and the `service` role the route already admitted). A member and an
 * external guest are refused. What a member needs from it — "is the data fresh,
 * is anything broken" — is `GET /api/connectors/summary`: counts and the newest
 * sync time, with no provider, no per-provider status and no credential expiry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

const { list, getEaglesoft } = vi.hoisted(() => ({ list: vi.fn(), getEaglesoft: vi.fn() }));
vi.mock("../services/integrations.service.js", () => ({
  createIntegrationsService: () => ({ list, getEaglesoft }),
}));

import { createIntegrationsRouter } from "./integrations.js";

const HUB = [
  {
    provider: "eaglesoft",
    status: "CONNECTED",
    configured: true,
    writeEnabled: false,
    lastSyncedAt: "2026-09-30T00:00:00.000Z",
    credentialExpiry: { status: "expiring", daysRemaining: 6 },
  },
];

function appAs(role: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    if (role !== null) {
      (req as unknown as { user: unknown }).user = { id: `u-${role}`, username: role, displayName: role, role };
    }
    next();
  });
  app.use("/api", createIntegrationsRouter({} as never));
  return app;
}

describe("GET /api/connectors — the company's connected systems (WARP-3374)", () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue(HUB);
  });

  it.each(["guest", "family"])("a %s is refused, and nothing about a connection or its credential leaves", async (role) => {
    const res = await request(appAs(role)).get("/api/connectors");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/eaglesoft|credentialExpiry|daysRemaining/);
    expect(list).not.toHaveBeenCalled();
  });

  it("a request with no session role is refused", async () => {
    expect((await request(appAs(null)).get("/api/connectors")).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "service"])("a %s gets the list, unchanged", async (role) => {
    const res = await request(appAs(role)).get("/api/connectors");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(HUB);
  });
});

describe("GET /api/connectors/summary — what a member may know (WARP-3374)", () => {
  const MANY = [
    { provider: "eaglesoft", status: "CONNECTED", configured: true, writeEnabled: false, lastSyncedAt: "2026-09-30T00:00:00.000Z", credentialExpiry: { status: "expiring", daysRemaining: 6 } },
    { provider: "quickbooks", status: "NEEDS_RECONNECT", configured: true, writeEnabled: false, lastSyncedAt: "2026-09-29T00:00:00.000Z", credentialExpiry: null },
    { provider: "stripe", status: "DEGRADED", configured: true, writeEnabled: false, lastSyncedAt: null, credentialExpiry: null },
    { provider: "hubspot", status: "NOT_CONFIGURED", configured: false, writeEnabled: false, lastSyncedAt: null, credentialExpiry: null },
    { provider: "mailchimp", status: "DISABLED", configured: true, writeEnabled: false, lastSyncedAt: "2026-09-01T00:00:00.000Z", credentialExpiry: null },
  ];

  beforeEach(() => {
    list.mockReset().mockResolvedValue(MANY);
  });

  it.each(["owner", "admin", "family"])("a %s gets counts and the newest sync, and nothing else", async (role) => {
    const res = await request(appAs(role)).get("/api/connectors/summary");
    expect(res.status).toBe(200);
    // connected = in use (connected, degraded, needs-reconnect...); not "not configured" or "turned off"
    expect(res.body).toEqual({ connected: 3, needsAttention: 2, lastSyncedAt: "2026-09-30T00:00:00.000Z" });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/eaglesoft|quickbooks|stripe|hubspot|mailchimp|provider|credential|expir|daysRemaining/i);
  });

  it("with nothing connected it says zero and no sync time — never a guess", async () => {
    list.mockResolvedValue([MANY[3]]);
    const res = await request(appAs("family")).get("/api/connectors/summary");
    expect(res.body).toEqual({ connected: 0, needsAttention: 0, lastSyncedAt: null });
  });

  it.each(["guest", "service", null])("a %s is refused", async (role) => {
    const res = await request(appAs(role)).get("/api/connectors/summary");
    expect(res.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("GET /api/connectors/eaglesoft — the connection detail (WARP-3374)", () => {
  const DETAIL = {
    provider: "eaglesoft",
    status: "CONNECTED",
    host: "10.0.4.12",
    databaseName: "practice",
    account: "droplet_ro",
    schemaHash: "abc123",
    credentialExpiry: { status: "expiring", daysRemaining: 6 },
  };

  beforeEach(() => {
    getEaglesoft.mockReset().mockResolvedValue(DETAIL);
  });

  it.each(["owner", "admin"])("an %s gets the detail", async (role) => {
    const res = await request(appAs(role)).get("/api/connectors/eaglesoft");
    expect(res.status).toBe(200);
    expect(res.body.connection).toEqual(DETAIL);
  });

  it.each(["family", "guest", "service", null])("a %s is refused, and no host, account or expiry leaves", async (role) => {
    const res = await request(appAs(role)).get("/api/connectors/eaglesoft");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.4\.12|droplet_ro|abc123|daysRemaining/);
    expect(getEaglesoft).not.toHaveBeenCalled();
  });
});
