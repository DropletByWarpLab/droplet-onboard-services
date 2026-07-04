/**
 * WARP-268 — POST /api/security/egress-anomaly.
 *
 * Same harness pattern as off-lan-network.routes.test.ts: config mocked,
 * req.user injected, router mounted under /api. The activity recorder is
 * injected (createEgressAuditRouter(record)) so no singleton wiring or
 * signing key is needed here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

import { createEgressAuditRouter } from "../routes/egress-audit.js";
import type { AuthUser } from "../middleware/auth.js";

function mkUser(role: AuthUser["role"], id = `user-${role}`): AuthUser {
  return { id, username: id, displayName: id, role };
}

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
});

describe("POST /api/security/egress-anomaly", () => {
  it("records an unlisted_destination into the activity log and 202s", async () => {
    const record = vi.fn().mockResolvedValue({ id: 1n });
    const res = await request(buildApp(record, mkUser("service")))
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
    const res = await request(buildApp(record, mkUser("service")))
      .post("/api/security/egress-anomaly")
      .send({ schemaVersion: 1, kind: "allowlist_unavailable", service: "_collector" });
    expect(res.status).toBe(202);
    expect(record.mock.calls[0][0].what).toBe(
      "Egress audit: allowed-egress.yaml unavailable — flows unclassified",
    );
  });

  it("400s on schema violations without recording", async () => {
    const record = vi.fn();
    const app = buildApp(record, mkUser("service"));
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
    expect(record).not.toHaveBeenCalled();
  });

  it("reports recorded:false when the recorder is degraded", async () => {
    const record = vi.fn().mockResolvedValue(null); // recordActivity's fail-soft
    const res = await request(buildApp(record, mkUser("service")))
      .post("/api/security/egress-anomaly")
      .send(VALID_BODY);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ recorded: false });
  });
});
