/**
 * WARP-1530 (RBAC v2 T6) — the O-2 connector floors on /api/erp/*.
 *
 * ADR-032 §8 O-2 (resolved 2026-07-24): ERP reads become **family-and-up
 * WITH an `AccessRoleConnectorGrant`** — that is what makes a "Reception"
 * role useful; writes stay **admin-tier only** plus the unchanged
 * `IntegrationConnection.writeEnabled` + staged `ErpWriteRequest` outbox +
 * human confirm above it. §3 adds the other half: only `owner` bypasses
 * layer 2, so an **Admin-based custom role can be narrowed** — an admin
 * whose role carries no ERP connector grant loses ERP reach.
 *
 * The behaviour CHANGE this file pins (today's 403 → 200):
 *   family user WITH a connector grant can read ERP.
 * Everything else is a PIN of existing behaviour, above all:
 *   a person with NO accessRole behaves EXACTLY as today.
 *
 * The route layer is the subject here; `erp.service.test.ts` covers the
 * defence-in-depth assertion that sits under it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { resolveEffectiveAccessMock, recordAccessDeniedMock } = vi.hoisted(() => ({
  resolveEffectiveAccessMock: vi.fn(),
  recordAccessDeniedMock: vi.fn(),
}));

vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: resolveEffectiveAccessMock,
}));

// The REAL requireRole contract (403 + its exact body + the access-denied
// audit hook) — the O-2 wiring must not change what a below-floor caller
// sees, so the stub has to behave like the middleware it stands in for.
vi.mock("../middleware/auth.js", () => ({
  requireRole:
    (...allowed: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as unknown as { user?: { role?: string } }).user?.role;
      if (typeof role !== "string" || role.length === 0) {
        recordAccessDeniedMock(req, "no-role");
        res.status(403).json({ error: "Forbidden: no role on session" });
        return;
      }
      if (!allowed.includes(role)) {
        recordAccessDeniedMock(req, "role-not-permitted");
        res.status(403).json({ error: "Forbidden: role not permitted" });
        return;
      }
      next();
    },
  recordAccessDenied: recordAccessDeniedMock,
}));

const svcMock = {
  getSchedule: vi.fn(),
  searchPatients: vi.fn(),
  getPatient: vi.fn(),
  getArSummary: vi.fn(),
  getRecallDue: vi.fn(),
  createWriteRequest: vi.fn(),
  getWriteRequest: vi.fn(),
  confirmWriteRequest: vi.fn(),
};
vi.mock("../services/erp.service.js", () => ({
  createErpService: () => svcMock,
}));

import { createErpRouter } from "./erp.js";
import { EAGLESOFT_PROVIDER } from "../services/erp-provider.js";

/** Prisma surface the route's connector gate needs (the connection probe). */
function createPrismaMock(opts: { connectionConfigured: boolean }) {
  return {
    integrationConnection: {
      findFirst: vi.fn(async () =>
        opts.connectionConfigured ? { id: "conn-1" } : null,
      ),
    },
  };
}

function buildApp(
  user: { id?: string; role?: string } | undefined,
  opts: { connectionConfigured?: boolean } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use(
    "/api",
    createErpRouter(
      createPrismaMock({
        connectionConfigured: opts.connectionConfigured ?? true,
      }) as never,
    ),
  );
  return app;
}

/** Resolver output carrying only what the ERP gate reads. */
function access(tier: string, connectors: Record<string, "read" | "read_write">) {
  return { tier, connectors, cloud: false, features: [], toolDomains: [] };
}

const OK_READ = { connected: false, reason: "NOT_CONFIGURED", date: "2026-07-25", items: [] };

beforeEach(() => {
  resolveEffectiveAccessMock.mockReset();
  recordAccessDeniedMock.mockReset();
  for (const fn of Object.values(svcMock)) fn.mockReset();
  svcMock.getSchedule.mockResolvedValue(OK_READ);
  svcMock.getArSummary.mockResolvedValue({ connected: false, totalBalance: null, accountCount: null });
  svcMock.createWriteRequest.mockResolvedValue({ id: "wr-1", status: "PENDING_CONFIRMATION" });
  svcMock.confirmWriteRequest.mockResolvedValue({ id: "wr-1", status: "FAILED" });
  svcMock.getWriteRequest.mockResolvedValue({ id: "wr-1", status: "PENDING_CONFIRMATION" });
});

describe("ERP reads — the O-2 floor (WARP-1530)", () => {
  it("BEHAVIOUR CHANGE: a family person WITH an ERP connector grant can read (today: 403)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("family", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-reception", role: "family" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(svcMock.getSchedule).toHaveBeenCalled();
    // The service is told the resolved reach so its own assertion can admit
    // this person without widening the tier set (defence in depth).
    expect(svcMock.getSchedule.mock.calls.at(-1)![1]).toMatchObject({
      id: "u-reception",
      role: "family",
      connectorLevel: "read",
    });
  });

  it("a family person WITHOUT a grant is denied — today's exact 403 (body + audit hook)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(access("family", {}));
    const app = buildApp({ id: "u-family", role: "family" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
    expect(recordAccessDeniedMock).toHaveBeenCalledWith(
      expect.anything(),
      "role-not-permitted",
    );
    expect(svcMock.getSchedule).not.toHaveBeenCalled();
  });

  it("a guest is denied exactly as today, without a resolver read", async () => {
    const app = buildApp({ id: "u-guest", role: "guest" });

    const res = await request(app).get("/api/erp/patients?query=sm");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("an Admin-based custom role with NO ERP grant loses reach (§3 — admins do not bypass layer 2)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(access("admin", {}));
    const app = buildApp({ id: "u-narrowed-admin", role: "admin" });

    const res = await request(app).get("/api/erp/ar-summary");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(svcMock.getArSummary).not.toHaveBeenCalled();
  });

  it("an owner bypasses layer 2 entirely — never resolved, never narrowed", async () => {
    const app = buildApp({ id: "u-owner", role: "owner" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });
});

describe("ERP reads — a person with NO accessRole behaves exactly as today", () => {
  it("a role-less admin reads (the resolver hands back the tier's full connector reach)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("admin", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-admin", role: "admin" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(svcMock.getSchedule).toHaveBeenCalled();
  });

  it("a role-less admin still gets the honest not-configured read when NOTHING is connected", async () => {
    // With no IntegrationConnection row the resolver hands back {} for
    // EVERYONE (no connection = no reach). "Nothing is connected" is not an
    // authorization answer — the service's honest NOT_CONFIGURED must win,
    // exactly as it does today.
    resolveEffectiveAccessMock.mockResolvedValue(access("admin", {}));
    const app = buildApp({ id: "u-admin", role: "admin" }, { connectionConfigured: false });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("NOT_CONFIGURED");
  });

  it("a role-less family person is STILL denied when nothing is connected (today's 403)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(access("family", {}));
    const app = buildApp({ id: "u-family", role: "family" }, { connectionConfigured: false });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
  });

  it("falls back to today's floor when the resolver is unavailable — no reach is invented, none is lost", async () => {
    resolveEffectiveAccessMock.mockRejectedValue(new Error("db down"));

    // admin keeps today's access…
    const adminRes = await request(
      buildApp({ id: "u-admin", role: "admin" }),
    ).get("/api/erp/schedule");
    expect(adminRes.status).toBe(200);

    // …and family does not get the O-2 widening on a broken resolver.
    const familyRes = await request(
      buildApp({ id: "u-reception", role: "family" }),
    ).get("/api/erp/schedule");
    expect(familyRes.status).toBe(403);
  });
});

describe("ERP writes — admin-tier only, unchanged above that (WARP-1530)", () => {
  it("a family person WITH a read grant still cannot stage a write", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("family", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-reception", role: "family" });

    const res = await request(app)
      .post("/api/erp/write-requests")
      .send({ command: "reschedule_appointment", params: {} });

    expect(res.status).toBe(403);
    expect(svcMock.createWriteRequest).not.toHaveBeenCalled();
  });

  it("an admin stages a write exactly as today — the writeEnabled + outbox + confirm chain is untouched", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("admin", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-admin", role: "admin" });

    const staged = await request(app)
      .post("/api/erp/write-requests")
      .send({ command: "reschedule_appointment", params: {} });

    expect(staged.status).toBe(201);
    expect(staged.body.status).toBe("PENDING_CONFIRMATION");

    const confirmed = await request(app).post("/api/erp/write-requests/wr-1/confirm");
    expect(confirmed.status).toBe(200);
    expect(svcMock.confirmWriteRequest).toHaveBeenCalledWith("wr-1", expect.anything());
  });

  it("the write path never widens on a connector grant level — writeEnabled stays the service's call", async () => {
    // `connectors[p]` folds `writeEnabled` into the level via min(), so the
    // route deliberately does NOT gate writes on "read_write": doing so would
    // mask the honest 409 WRITE_NOT_ENABLED with a misleading 403.
    resolveEffectiveAccessMock.mockResolvedValue(
      access("admin", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    svcMock.createWriteRequest.mockRejectedValue(
      Object.assign(new Error("writes are disabled for this integration"), {
        name: "ErpError",
        code: "WRITE_NOT_ENABLED",
        status: 409,
        toJSON: () => ({ error: "writes are disabled", code: "WRITE_NOT_ENABLED" }),
      }),
    );
    const app = buildApp({ id: "u-admin", role: "admin" });

    const res = await request(app)
      .post("/api/erp/write-requests")
      .send({ command: "reschedule_appointment", params: {} });

    expect(res.status).not.toBe(403);
    expect(svcMock.createWriteRequest).toHaveBeenCalled();
  });
});
