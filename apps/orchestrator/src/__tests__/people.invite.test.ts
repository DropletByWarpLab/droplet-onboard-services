/**
 * Security regression — onboarding team-invite rank cap (privilege escalation).
 *
 * POST /api/people/invite (PR #381 team step) is guarded by
 * requireRole("owner","admin"), but the guard only proves the caller MAY
 * invite — not WHICH role they may assign. createTeamInvite validates the role
 * is a *valid* invite role but cannot cap it at the inviter's rank (it only
 * receives `createdBy`, not the inviter's role). So before this fix an `admin`
 * could mint an `owner` invite; on accept that grants an `owner` session role +
 * Nextcloud `admin` group — a straight privilege escalation, the same gap the
 * pre-existing POST /api/auth/invites carries. The route now rejects (403
 * ROLE_RANK_EXCEEDED) any assigned role that outranks the inviter's own.
 *
 * Same harness as people.routes.test.ts: synthetic auth middleware stuffs
 * req.user; prisma is mocked to a single userInvite.create; recordActivity is
 * mocked so we can assert the audit row is NOT written on the refusal path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createPeopleRouter } from "../routes/people.js";
import type { ScopeName } from "../middleware/scope.js";

/** Prisma stub exposing just the userInvite.create the team service calls. */
function createPrismaMock() {
  const create = vi.fn(
    async ({
      data,
    }: {
      data: {
        token: string;
        username: string;
        email: string;
        role: string;
        createdBy: string;
        expiresAt: Date;
      };
    }) => ({
      ...data,
      displayName: null,
      acceptedAt: null,
      revokedAt: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    }),
  );
  return { create, prisma: { userInvite: { create } } as any };
}

/** Mount the real people router behind a synthetic req.user. */
function buildApp(prismaMock: any, inviterRole: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = {
      id: `${inviterRole}-id`,
      username: `user-${inviterRole}`,
      displayName: `User ${inviterRole}`,
      role: inviterRole,
    };
    next();
  });
  // WARP-455 — createPeopleRouter now takes the scope-loader axis as arg 2.
  // The invite routes are gated by requireRole only (never requireScope), so
  // the loader is never invoked here; a fixed loader keeps every assertion
  // intact.
  app.use(
    "/api",
    createPeopleRouter(prismaMock, async () => new Set<ScopeName>(["team"])),
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/people/invite — inviter rank cap (privilege escalation)", () => {
  it("rejects admin → owner with 403 ROLE_RANK_EXCEEDED, no invite, no audit row", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "neo@example.com", role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_RANK_EXCEEDED");
    // Fail-closed: nothing persisted, nothing audited on the rejection path.
    expect(create).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("allows owner → owner with 200 and persists role=owner", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "trinity@example.com", role: "owner" });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.role).toBe("owner");
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("allows admin → admin (equal rank) with 200", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "morpheus@example.com", role: "admin" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("admin");
  });

  it("allows admin → family (below rank) with 200", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "dozer@example.com", role: "family" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("family");
  });

  it("allows owner → admin (below rank) with 200", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "tank@example.com", role: "admin" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("admin");
  });

  it("still 400s an unrecognized role via the service (no escalation bypass)", async () => {
    // The rank check only fires for recognized invite roles; an unknown role
    // falls through to createTeamInvite, which 400s it (INVITE_ROLE_INVALID).
    // Proves the cap didn't open a hole for junk roles or reorder the guards.
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "cypher@example.com", role: "superuser" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVITE_ROLE_INVALID");
    expect(create).not.toHaveBeenCalled();
  });
});
