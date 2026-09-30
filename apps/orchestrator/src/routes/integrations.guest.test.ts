/**
 * WARP-3374 (Romain, 2026-09-30: an external guest gets nothing of the
 * company's data unless it is shared with them) — `GET /api/integrations`
 * lists which business systems are connected, when each last synced and when a
 * credential expires. That is the company's own topology; a guest is refused.
 * Owner, admin and member keep the read (the Reports tiles use it), as does the
 * `service` role the route already admitted.
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

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../services/integrations.service.js", () => ({
  createIntegrationsService: () => ({ list }),
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

describe("GET /api/integrations — the company's connected systems (WARP-3374)", () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue(HUB);
  });

  it("an external guest is refused, and nothing about a connection or its credential leaves", async () => {
    const res = await request(appAs("guest")).get("/api/integrations");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/eaglesoft|credentialExpiry|daysRemaining/);
    expect(list).not.toHaveBeenCalled();
  });

  it("a request with no session role is refused", async () => {
    expect((await request(appAs(null)).get("/api/integrations")).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "family", "service"])("a %s gets the list, unchanged", async (role) => {
    const res = await request(appAs(role)).get("/api/integrations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(HUB);
  });
});
