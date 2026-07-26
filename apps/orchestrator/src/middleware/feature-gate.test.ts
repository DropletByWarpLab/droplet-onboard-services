/**
 * WARP-1528 / ADR-032 §3(a) (RBAC v2 T4) — the per-user feature gate.
 *
 * `requireFeatureAccess(moduleId, minLevel)` is layer 2 registered BESIDE the
 * ADR-004 `requireRole` floors (the seam `requireScope` proved). It only ever
 * NARROWS: the enum floor stays authoritative, and a person the resolver can't
 * narrow (no local row, `service` principal) passes through untouched.
 *
 * Denials are 404-CONSISTENT with `requireModuleEnabled` — byte-identical body
 * — so a feature a person may not open reads as ABSENT, never as FORBIDDEN
 * (403 would leak that the surface exists and that someone else can reach it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { requireFeatureAccess, resolveEffectiveAccessForRequest } from "./feature-gate.js";
import type { AuthUser } from "./auth.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";

type Principal = AuthUser | null;

function principal(id: string, username: string, role: AuthUser["role"]): AuthUser {
  return { id, username, displayName: username, role };
}

function result(
  features: Array<{ moduleId: string; level: "view" | "act" | "manage" }>,
  tier: EffectiveAccessResult["tier"] = "family",
): EffectiveAccessResult {
  return {
    tier,
    features: features as EffectiveAccessResult["features"],
    toolDomains: [],
    locks: false,
    cloud: false,
    connectors: {},
    // WARP-1579: null = "no custom role narrows the connectors axis", which
    // is what this module gate's fixtures have always modelled.
    connectorGrants: null,
    usage: {
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      source: "default",
      sources: {
        storageQuotaBytes: "default",
        maxUploadSizeMb: "default",
        llmDailyMessageCap: "default",
      },
    },
    deptRights: [],
    exceptions: [],
  };
}

/** Mount one or more gates on /api/cameras behind a synthetic principal. */
function appWith(
  user: Principal,
  resolve: (userId: string) => Promise<EffectiveAccessResult | null>,
  gates: Array<ReturnType<typeof requireFeatureAccess>>,
) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });
  for (const gate of gates) app.use("/api/cameras", gate);
  app.get("/api/cameras", (_req, res) => {
    res.json({ ok: true });
  });
  void resolve;
  return app;
}

const OWNER = principal("u-owner", "ada", "owner");
const STAFF = principal("u-staff", "bo", "family");

describe("requireFeatureAccess — narrowing", () => {
  beforeEach(() => {
    recordActivityMock.mockClear();
  });

  it("passes when the resolved level is exactly the minimum", async () => {
    const resolve = vi.fn(async () => result([{ moduleId: "cameras", level: "act" }]));
    const app = appWith(STAFF, resolve, [requireFeatureAccess("cameras", "act", resolve)]);
    const res = await request(app).get("/api/cameras");
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith("u-staff");
  });

  it("passes when the resolved level is ABOVE the minimum", async () => {
    const resolve = vi.fn(async () => result([{ moduleId: "cameras", level: "manage" }]));
    const app = appWith(STAFF, resolve, [requireFeatureAccess("cameras", "act", resolve)]);
    expect((await request(app).get("/api/cameras")).status).toBe(200);
  });

  it("404s when the resolved level is BELOW the minimum", async () => {
    const resolve = vi.fn(async () => result([{ moduleId: "cameras", level: "view" }]));
    const app = appWith(STAFF, resolve, [requireFeatureAccess("cameras", "act", resolve)]);
    const res = await request(app).get("/api/cameras");
    expect(res.status).toBe(404);
  });

  it("404s when the feature is absent from the resolved set", async () => {
    const resolve = vi.fn(async () => result([{ moduleId: "files", level: "manage" }]));
    const app = appWith(STAFF, resolve, [requireFeatureAccess("cameras", "view", resolve)]);
    expect((await request(app).get("/api/cameras")).status).toBe(404);
  });

  it("denies with the SAME body as requireModuleEnabled (never leaks existence)", async () => {
    const resolve = vi.fn(async () => result([]));
    const app = appWith(STAFF, resolve, [requireFeatureAccess("cameras", "view", resolve)]);
    const res = await request(app).get("/api/cameras");
    // Byte-identical to middleware/module-gate.ts's workspace-off body: a
    // per-person denial must be indistinguishable from a box-wide toggle.
    expect(res.body).toEqual({ error: "module_disabled", module: "cameras" });
  });

  it("records a WARP-237 policy-violation row on denial (requireRole parity)", async () => {
    const resolve = vi.fn(async () => result([]));
    const app = appWith(STAFF, resolve, [requireFeatureAccess("cameras", "view", resolve)]);
    await request(app).get("/api/cameras");
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "auth",
      what: "Access denied",
      refs: expect.objectContaining({ reason: "feature-access-denied" }),
    });
  });
});

describe("requireFeatureAccess — the passes it must never narrow", () => {
  it("passes a principal with no local row (nothing to narrow — today's world)", async () => {
    // resolveEffectiveAccess returns null for "no such user": the
    // AUTH_ENABLED=false dev session and the OCS-fallback principal. Layer 1
    // (requireRole + requireModuleEnabled) is still enforcing.
    const resolve = vi.fn(async () => null);
    const app = appWith(STAFF, resolve, [requireFeatureAccess("cameras", "manage", resolve)]);
    expect((await request(app).get("/api/cameras")).status).toBe(200);
  });

  it("passes a `service` principal WITHOUT resolving (dedicated paths, §3)", async () => {
    const resolve = vi.fn(async () => result([]));
    const app = appWith(
      principal("_service:mcp", "mcp", "service"),
      resolve,
      [requireFeatureAccess("cameras", "manage", resolve)],
    );
    expect((await request(app).get("/api/cameras")).status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("passes an owner (the §3 bypass rides in the resolver's own output)", async () => {
    const resolve = vi.fn(async () =>
      result([{ moduleId: "cameras", level: "manage" }], "owner"),
    );
    const app = appWith(OWNER, resolve, [requireFeatureAccess("cameras", "manage", resolve)]);
    expect((await request(app).get("/api/cameras")).status).toBe(200);
  });

  it("passes when there is no principal at all (auth owns 401, not this gate)", async () => {
    const resolve = vi.fn(async () => result([]));
    const app = appWith(null, resolve, [requireFeatureAccess("cameras", "view", resolve)]);
    expect((await request(app).get("/api/cameras")).status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("requireFeatureAccess — failure posture + cost", () => {
  it("fails CLOSED to the same 404 when the resolver throws", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("db down");
    });
    const app = appWith(STAFF, resolve, [requireFeatureAccess("cameras", "view", resolve)]);
    const res = await request(app).get("/api/cameras");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "cameras" });
  });

  it("resolves ONCE per request even with two gates mounted (per-request memo)", async () => {
    const resolve = vi.fn(async () => result([{ moduleId: "cameras", level: "manage" }]));
    const app = appWith(STAFF, resolve, [
      requireFeatureAccess("cameras", "view", resolve),
      requireFeatureAccess("cameras", "manage", resolve),
    ]);
    expect((await request(app).get("/api/cameras")).status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("a ROUTE handler shares the gates' memo — the whole request costs one resolve", async () => {
    // The resolver is ~7 DB round-trips with no cache in v1, so any in-request
    // consumer (the /api/modules effectiveForUser view is the first) must come
    // through resolveEffectiveAccessForRequest, not call the resolver again.
    const resolve = vi.fn(async () => result([{ moduleId: "cameras", level: "manage" }]));
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = STAFF;
      next();
    });
    app.use("/api/cameras", requireFeatureAccess("cameras", "view", resolve));
    app.get("/api/cameras", async (req, res) => {
      const access = await resolveEffectiveAccessForRequest(req, resolve);
      res.json({ features: access?.features ?? [] });
    });
    const res = await request(app).get("/api/cameras");
    expect(res.status).toBe(200);
    expect(res.body.features).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("resolveEffectiveAccessForRequest short-circuits the no-narrowing principals", async () => {
    const resolve = vi.fn(async () => result([]));
    const req = { user: principal("_service:mcp", "mcp", "service") } as unknown as Request;
    expect(await resolveEffectiveAccessForRequest(req, resolve)).toBeNull();
    expect(await resolveEffectiveAccessForRequest({} as Request, resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
