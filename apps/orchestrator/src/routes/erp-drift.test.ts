/**
 * WARP-2463 — the admin read surface over stored reconciliation drift.
 *
 * `requireRole` is NOT stubbed here. The acceptance criterion is about the
 * real guard: the 403 body, and the `recordAccessDenied` ActivityRow that
 * WARP-237 makes mandatory-emit on an ACL denial. A hand-written stand-in
 * would pass whether or not the shipped middleware still emits that row, which
 * is precisely the class of vacuously-green test this repo has shipped before.
 * Only `recordActivity` — the append-lock singleton at the very bottom of that
 * call — is replaced, so the row can be observed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createErpDriftRouter } from "./erp-drift.js";
import { isRoleGuard } from "../middleware/auth.js";

const NOW = new Date("2026-08-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** Rows shaped as Prisma would return them. */
function driftRow(over: Record<string, unknown> = {}) {
  return {
    id: "d-1",
    connectionId: "conn-1",
    provider: "xero",
    entity: "invoice",
    sweepAt: new Date(NOW.getTime() - DAY),
    classification: "NONE",
    missedCount: 0,
    fullCount: 12,
    incrementalCount: 12,
    watermarkAt: new Date(NOW.getTime() - 2 * DAY),
    earliestMissedAt: null,
    ...over,
  };
}

function prismaStub(rows: Array<Record<string, unknown>> = [driftRow()]) {
  return {
    erpDriftRecord: {
      findMany: vi.fn(async (args: any) => {
        const w = args?.where ?? {};
        let out = rows.filter((r) => !w.connectionId || r.connectionId === w.connectionId);
        if (w.sweepAt?.gte) out = out.filter((r) => (r.sweepAt as Date) >= w.sweepAt.gte);
        return out;
      }),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

function buildApp(user: { id?: string; role?: string } | undefined, prisma = prismaStub()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api", createErpDriftRouter(prisma as never));
  return app;
}

beforeEach(() => {
  recordActivityMock.mockReset();
});

describe("GET /api/integrations/:connectionId/drift — the guard", () => {
  it("carries requireRole AT REGISTRATION, not a check inside the handler", () => {
    // MUTATION: move the role check into the handler body (an `isAdmin(req)`
    // early-return) → no marked guard on the route stack → red.
    //
    // The distinction is not stylistic: a guard inside the handler runs after
    // the route has already been entered, which is how a surface acquires a
    // path that reaches data before authorization has been decided.
    const router = createErpDriftRouter(prismaStub() as never) as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }>;
    };
    const routes = router.stack.map((l) => l.route).filter(Boolean) as Array<{
      path: string;
      stack: Array<{ handle: unknown }>;
    }>;

    // Guards against a vacuous sweep: an empty router would satisfy "every
    // route is guarded" while checking nothing.
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/integrations/:connectionId/drift");
    expect(routes[0].stack.some((h) => isRoleGuard(h.handle))).toBe(true);
    // The guard runs BEFORE the handler.
    expect(routes[0].stack.findIndex((h) => isRoleGuard(h.handle))).toBe(0);
  });

  it("denies a family caller with a 403 AND a recordAccessDenied row", async () => {
    // MUTATION: widen the guard to `requireRole("owner","admin","family")` →
    // 200 and no audit row → red. WARP-237 makes the denial row
    // mandatory-emit: an ACL denial that leaves no trace is invisible to the
    // audit chain the box is sold on.
    const prisma = prismaStub();
    const res = await request(buildApp({ id: "u-family", role: "family" }, prisma)).get(
      "/api/integrations/conn-1/drift",
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
    expect(prisma.erpDriftRecord.findMany).not.toHaveBeenCalled();

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const row = recordActivityMock.mock.calls[0][0];
    expect(row).toMatchObject({
      kind: "auth",
      severity: "warn",
      what: "Access denied",
    });
    expect(row.refs).toMatchObject({ role: "family", reason: "role-not-permitted" });
  });

  it("denies a guest and a role-less session too", async () => {
    for (const user of [{ id: "u-guest", role: "guest" }, undefined]) {
      recordActivityMock.mockReset();
      const res = await request(buildApp(user)).get("/api/integrations/conn-1/drift");
      expect(res.status).toBe(403);
      expect(recordActivityMock).toHaveBeenCalledTimes(1);
    }
  });

  it("admits owner and admin", async () => {
    for (const role of ["owner", "admin"]) {
      const res = await request(buildApp({ id: `u-${role}`, role })).get(
        "/api/integrations/conn-1/drift",
      );
      expect(res.status).toBe(200);
    }
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/integrations/:connectionId/drift — the payload", () => {
  it("returns drift for the requested connection only", async () => {
    const prisma = prismaStub([
      driftRow(),
      driftRow({ id: "d-2", connectionId: "conn-2", classification: "MISSED_NEWER" }),
    ]);
    const res = await request(buildApp({ id: "u-1", role: "admin" }, prisma)).get(
      "/api/integrations/conn-1/drift",
    );

    expect(res.status).toBe(200);
    expect(res.body.connectionId).toBe("conn-1");
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({
      entity: "invoice",
      provider: "xero",
      classification: "NONE",
      missedCount: 0,
      fullCount: 12,
    });
    expect(res.body.summary).toMatchObject({
      rowsRecorded: 1,
      driftedRows: 0,
      totalMissed: 0,
    });
  });

  it("distinguishes 'never measured' from 'measured and clean'", async () => {
    // The whole point of the stored zero-drift row. A connection with no rows
    // reports rowsRecorded 0 — NOT an implied clean bill of health, and not a
    // 404 either, because "we have never swept this" is a real answer the hub
    // has to be able to render.
    const res = await request(buildApp({ id: "u-1", role: "admin" }, prismaStub([]))).get(
      "/api/integrations/conn-1/drift",
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.summary.rowsRecorded).toBe(0);
    expect(res.body.summary.cleanSweepStreak).toBe(0);
  });

  it("carries no customer content in the response", async () => {
    const prisma = prismaStub([
      driftRow({ classification: "MISSED_NEWER", missedCount: 2, incrementalCount: 10 }),
    ]);
    const res = await request(buildApp({ id: "u-1", role: "admin" }, prisma)).get(
      "/api/integrations/conn-1/drift",
    );
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("INV-");
    expect(body).not.toContain("@");
    expect(body).toContain("MISSED_NEWER");
  });

  it("rejects a nonsense window rather than scanning on it", async () => {
    const res = await request(buildApp({ id: "u-1", role: "admin" })).get(
      "/api/integrations/conn-1/drift?days=0",
    );
    expect(res.status).toBe(400);
  });

  it("defaults the window to 30 days", async () => {
    const prisma = prismaStub();
    await request(buildApp({ id: "u-1", role: "admin" }, prisma)).get(
      "/api/integrations/conn-1/drift",
    );
    const res = await request(buildApp({ id: "u-1", role: "admin" }, prisma)).get(
      "/api/integrations/conn-1/drift",
    );
    expect(res.body.windowDays).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// WARP-2485 — mount order must never be load-bearing
// ---------------------------------------------------------------------------

/**
 * Two Express path patterns can match a common concrete path iff they have the
 * same segment count and, at every position, either side is a `:param` or the
 * two literals are equal. These routers use plain patterns only — no regex, no
 * optional segments, no wildcards — so this is exact, not an approximation.
 */
function canMatchSamePath(a: string, b: string): boolean {
  const as = a.split("/").filter(Boolean);
  const bs = b.split("/").filter(Boolean);
  if (as.length !== bs.length) return false;
  return as.every((seg, i) => seg.startsWith(":") || bs[i].startsWith(":") || seg === bs[i]);
}

function pathsOf(router: unknown): string[] {
  const stack = (router as { stack: Array<{ route?: { path: string } }> }).stack;
  return stack.map((l) => l.route?.path).filter((p): p is string => Boolean(p));
}

describe("the drift route is match-disjoint from every /api/integrations sibling", () => {
  it("shares no concrete path with the credentials or ERP routers", async () => {
    // REGRESSION (WARP-2485). The first revision of this route was
    // `/integrations/drift/:connectionId`, which overlapped WARP-2275's
    // `/integrations/:provider/credentials` on the single concrete path
    // `/integrations/drift/credentials` and leaned on MOUNT ORDER in app.ts to
    // resolve it. A router whose correctness depends on where it was mounted
    // breaks the moment someone reorders that file.
    //
    // MUTATION: restore the old `/integrations/drift/:connectionId` → the
    // credentials pattern overlaps → red.
    const { createSaasCredentialsRouter } = await import("./saas-credentials.js");
    const { createIntegrationsRouter } = await import("./integrations.js");

    const mine = pathsOf(createErpDriftRouter(prismaStub() as never));
    const siblings = [
      ...pathsOf(createSaasCredentialsRouter({} as never)),
      ...pathsOf(createIntegrationsRouter({} as never)),
    ];

    // Guards against a vacuous sweep: an empty sibling list would make the
    // disjointness assertion below true while comparing nothing.
    expect(mine).toEqual(["/integrations/:connectionId/drift"]);
    expect(siblings.length).toBeGreaterThanOrEqual(8);
    expect(siblings).toContain("/integrations/:provider/credentials");

    const overlaps = siblings.filter((s) => mine.some((m) => canMatchSamePath(m, s)));
    expect(overlaps).toEqual([]);
  });

  it("recognises a real overlap, so the sweep above is not vacuous", () => {
    // The matcher itself must be able to fail. Without this, a degraded
    // `canMatchSamePath` that always returned false would make the disjointness
    // assertion pass for every route the repo will ever add.
    expect(
      canMatchSamePath("/integrations/drift/:connectionId", "/integrations/:provider/credentials"),
    ).toBe(true);
    expect(
      canMatchSamePath("/integrations/:connectionId/drift", "/integrations/:provider/credentials"),
    ).toBe(false);
    expect(
      canMatchSamePath("/integrations/:connectionId/drift", "/integrations/eaglesoft/connect"),
    ).toBe(false);
    expect(
      canMatchSamePath("/integrations/:connectionId/drift", "/integrations/credentials"),
    ).toBe(false);
  });
});
