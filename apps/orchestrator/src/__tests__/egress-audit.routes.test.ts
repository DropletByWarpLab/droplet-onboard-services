/**
 * WARP-268 — POST /api/security/egress-anomaly.
 *
 * Same harness pattern as off-lan-network.routes.test.ts: config mocked,
 * req.user injected, router mounted under /api. The activity recorder is
 * injected (createEgressAuditRouter(record)) so no singleton wiring or
 * signing key is needed here.
 *
 * WARP-1062 (audit item E) adds:
 *   - exact-principal pinning: only `_service:egress-audit` is admitted;
 *     every OTHER service principal (a leaked voice/mcp/email/sampler/
 *     ai-gateway token) 403s AND emits the WARP-237 "Access denied" row;
 *   - a per-IP rate limit keyed on proxy-aware req.ip (WARP-579/WARP-1138
 *     standard) — a forged X-Forwarded-For must not mint fresh buckets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

// WARP-1062: the route's rate limiter reads/writes the Redis cache — mock it
// so tests control the bucket contents (same pattern as the device-clients
// rate-limit suites).
const { mockCacheGet, mockCacheSet } = vi.hoisted(() => ({
  mockCacheGet: vi.fn(),
  mockCacheSet: vi.fn(),
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: mockCacheGet,
  cacheSet: mockCacheSet,
}));

import { createEgressAuditRouter } from "../routes/egress-audit.js";
import type { AuthUser } from "../middleware/auth.js";

function mkUser(role: AuthUser["role"], id = `user-${role}`): AuthUser {
  return { id, username: id, displayName: id, role };
}

/** The one principal the route admits (middleware/auth.ts SERVICE_PRINCIPALS). */
const COLLECTOR = mkUser("service", "_service:egress-audit");

function buildApp(record: ReturnType<typeof vi.fn>, user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createEgressAuditRouter(record as never));
  return app;
}

const VALID_BODY = {
  schemaVersion: 1,
  kind: "unlisted_destination",
  service: "ai-gateway",
  dst: "104.18.6.192",
  dstName: "tracker.example",
  port: 443,
  protocol: "tcp",
  firstSeen: "2026-07-04T04:14:02Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCacheGet.mockResolvedValue(undefined);
  mockCacheSet.mockResolvedValue(undefined);
});

describe("POST /api/security/egress-anomaly", () => {
  it("records an unlisted_destination into the activity log and 202s", async () => {
    const record = vi.fn().mockResolvedValue({ id: 1n });
    const res = await request(buildApp(record, COLLECTOR))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ recorded: true });
    expect(record).toHaveBeenCalledTimes(1);
    const params = record.mock.calls[0][0];
    expect(params.kind).toBe("network");
    expect(params.severity).toBe("warn");
    expect(params.what).toBe("Egress anomaly: ai-gateway → tracker.example:443");
    expect(params.sub).toBe("unlisted_destination");
    expect(params.refs).toMatchObject({
      kind: "unlisted_destination",
      service: "ai-gateway",
      dst: "104.18.6.192",
      source: "egress-audit-collector",
    });
    // service principal → system actor (actorFromRequest contract)
    expect(params.actor).toEqual({ type: "system", id: null });
  });

  it("renders the allowlist_unavailable variant", async () => {
    const record = vi.fn().mockResolvedValue({ id: 2n });
    const res = await request(buildApp(record, COLLECTOR))
      .post("/api/security/egress-anomaly")
      .send({ schemaVersion: 1, kind: "allowlist_unavailable", service: "_collector" });
    expect(res.status).toBe(202);
    expect(record.mock.calls[0][0].what).toBe(
      "Egress audit: allowed-egress.yaml unavailable — flows unclassified",
    );
  });

  it("400s on schema violations without recording", async () => {
    const record = vi.fn();
    const app = buildApp(record, COLLECTOR);
    for (const bad of [
      { ...VALID_BODY, kind: "surprise_kind" },
      { ...VALID_BODY, schemaVersion: 2 },
      { ...VALID_BODY, port: 70000 },
      {},
    ]) {
      const res = await request(app).post("/api/security/egress-anomaly").send(bad);
      expect(res.status).toBe(400);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("403s non-service principals", async () => {
    const record = vi.fn();
    const res = await request(buildApp(record, mkUser("admin")))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    // Only the WARP-237 "Access denied" row — never an anomaly row.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].what).toBe("Access denied");
  });

  it("reports recorded:false when the recorder is degraded", async () => {
    const record = vi.fn().mockResolvedValue(null); // recordActivity's fail-soft
    const res = await request(buildApp(record, COLLECTOR))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ recorded: false });
  });
});

// WARP-1062 (audit item E): requireRole("service") admitted every service
// principal — one leaked voice/mcp/email/sampler/ai-gateway token could forge
// network-kind rows into the signed chain. Only the collector's own principal
// may pass; every other service principal 403s AND is audited.
describe("POST /api/security/egress-anomaly — exact-principal pinning (WARP-1062)", () => {
  it.each([
    "_service:voice",
    "_service:mcp",
    "_service:email",
    "_service:sampler",
    "_service:ai-gateway",
  ])("403s the %s service principal and emits the Access denied row", async (principalId) => {
    const record = vi.fn().mockResolvedValue({ id: 3n });
    const res = await request(buildApp(record, mkUser("service", principalId)))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);

    expect(res.status).toBe(403);
    // Exactly one row: the WARP-237 policy violation — no anomaly row.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      kind: "auth",
      severity: "warn",
      what: "Access denied",
      refs: expect.objectContaining({
        principal: principalId,
        role: "service",
        reason: "service-principal-not-permitted",
      }),
      // service principals map to the system actor (actorFromRequest)
      actor: { type: "system", id: null },
    });
  });

  it("admits ONLY the _service:egress-audit principal", async () => {
    const record = vi.fn().mockResolvedValue({ id: 4n });
    const res = await request(buildApp(record, COLLECTOR))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);
    expect(res.status).toBe(202);
  });

  it("does not admit the egress-audit id without the service role", async () => {
    const record = vi.fn();
    const res = await request(buildApp(record, mkUser("family", "_service:egress-audit")))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });
});

// WARP-1062 (audit item E): server-side per-IP rate limit — the client-side
// AnomalyGate dedup is no defense against a token holder minting rows.
describe("POST /api/security/egress-anomaly — per-IP rate limit (WARP-1062)", () => {
  it("429s once the per-IP bucket is exhausted, without recording", async () => {
    mockCacheGet.mockImplementation(async (key: string) =>
      key === "ratelimit:egress-anomaly:::ffff:127.0.0.1" ? 60 : undefined,
    );
    const record = vi.fn();
    const res = await request(buildApp(record, COLLECTOR))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);

    expect(res.status).toBe(429);
    expect(record).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it("bumps the req.ip-keyed bucket on an accepted push", async () => {
    const record = vi.fn().mockResolvedValue({ id: 5n });
    await request(buildApp(record, COLLECTOR))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);

    const bumped = mockCacheSet.mock.calls.map((c) => c[0]);
    expect(bumped).toContain("ratelimit:egress-anomaly:::ffff:127.0.0.1");
  });

  it("fails open when Redis is unreachable (cache outage must not blind the box)", async () => {
    mockCacheGet.mockRejectedValue(new Error("redis down"));
    const record = vi.fn().mockResolvedValue({ id: 6n });
    const res = await request(buildApp(record, COLLECTOR))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);
    expect(res.status).toBe(202);
  });

  // WARP-579 / WARP-1138: the bucket key comes from proxy-aware req.ip, never
  // the raw client-controlled X-Forwarded-For — rotating that header must not
  // mint a fresh bucket per request and dodge the limit.
  it("still 429s an exhausted bucket under rotating forged X-Forwarded-For values", async () => {
    mockCacheGet.mockImplementation(async (key: string) =>
      key === "ratelimit:egress-anomaly:::ffff:127.0.0.1" ? 60 : undefined,
    );
    const record = vi.fn();
    const app = buildApp(record, COLLECTOR);
    for (const forged of ["6.6.6.6", "7.7.7.7", "8.8.8.8"]) {
      const res = await request(app)
        .post("/api/security/egress-anomaly")
        .set("X-Forwarded-For", forged)
        .send(VALID_BODY);
      expect(res.status).toBe(429);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("bumps the socket-derived bucket, never an attacker-named one", async () => {
    const record = vi.fn().mockResolvedValue({ id: 7n });
    await request(buildApp(record, COLLECTOR))
      .post("/api/security/egress-anomaly")
      .set("X-Forwarded-For", "6.6.6.6")
      .send(VALID_BODY);

    const bumped = mockCacheSet.mock.calls.map((c) => c[0]);
    expect(bumped).toContain("ratelimit:egress-anomaly:::ffff:127.0.0.1");
    expect(bumped.some((k) => String(k).includes("6.6.6.6"))).toBe(false);
  });
});
