/**
 * Security regression — invite-creation rank cap (privilege escalation).
 *
 * POST /api/auth/invites is guarded by requireRole("owner","admin"), but the
 * guard only proves the caller MAY issue invites — not WHICH role they may
 * assign. Before this fix an `admin` could mint an `owner` invite; on accept
 * (POST /api/auth/invites/accept/:token) an owner/admin invite is granted an
 * `owner` session role + Nextcloud `admin` group, so the gap was a straight
 * privilege escalation. The route now rejects (403 ROLE_RANK_EXCEEDED) any
 * assigned role that outranks the inviter's own.
 *
 * Mounts the REAL createProtectedAuthRouter (not a synthetic stand-in) behind
 * a synthetic auth middleware that stuffs req.user — same harness as
 * people.routes.test.ts / rbac.test.ts — so the handler-internal rank check
 * is exercised end to end, with prisma mocked to a single userInvite.create
 * capture.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

// Config mock — hoisted above the route import. Mirrors rbac.test.ts: the
// keys the auth module + middleware touch at load time.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

import { createProtectedAuthRouter } from "../routes/auth.js";
import type { Role } from "../services/jwt.service.js";

/** Prisma stub exposing `userInvite.create` and `user.findFirst` (for deriveUniqueUserId). */
function createPrismaMock() {
  const create = vi.fn(
    async ({ data }: { data: { role: string; username: string; email?: string | null } }) => ({
      token: "tok-abc",
      username: data.username,
      displayName: null,
      email: data.email ?? null,
      role: data.role,
      createdBy: "inviter",
      createdAt: new Date("2026-06-01T00:00:00Z"),
      expiresAt: new Date("2026-06-04T00:00:00Z"),
      acceptedAt: null,
      revokedAt: null,
    }),
  );
  // deriveUniqueUserId queries user.findFirst to check username uniqueness.
  // Return null (candidate not taken) so the first base candidate is used.
  const findFirst = vi.fn().mockResolvedValue(null);
  return { create, findFirst, prisma: { userInvite: { create }, user: { findFirst } } as any };
}

/** Mount the real protected auth router behind a synthetic req.user. */
function buildApp(prismaMock: any, inviterRole: Role) {
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
  app.use("/api", createProtectedAuthRouter(prismaMock));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/invites — inviter rank cap (privilege escalation)", () => {
  it("rejects admin → owner with 403 ROLE_RANK_EXCEEDED and creates no invite", async () => {
    // The core escalation: an admin must not be able to mint an owner
    // invite (which on accept would grant owner + Nextcloud admin group).
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "neo@warp.test", role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_RANK_EXCEEDED");
    // Fail-closed: nothing is persisted on the rejection path.
    expect(create).not.toHaveBeenCalled();
  });

  it("owner → owner invite → 403 ROLE_NOT_ASSIGNABLE (WARP-1526 supersession — invites never assign owner)", async () => {
    // SUPERSEDED (WARP-1526, conscious): owner→owner was pinned as allowed
    // purely to document the rank cap's equal-rank (<=) semantics. The
    // assignable-enum narrowing (rail 7, after the rank cap in the shared
    // guard service) now refuses `owner` for EVERY actor — invites only
    // ever assign {admin, family, guest} (design brief §6.2 "never Owner
    // or Service"; exactly one owner by design; ownership transfer is a
    // future dedicated flow). Equal-rank semantics stay pinned by the
    // admin→admin case below.
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "trinity@warp.test", role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_NOT_ASSIGNABLE");
    expect(create).not.toHaveBeenCalled();
  });

  it("allows admin → admin (equal rank) with 200 and derives username from email", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "morpheus@warp.test", role: "admin" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("admin");
    expect(create.mock.calls[0][0].data.username).toBe("morpheus");
  });

  it("allows admin → family (below rank) with 200 and derives username from email", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "dozer@warp.test", role: "family" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("family");
    expect(create.mock.calls[0][0].data.username).toBe("dozer");
  });

  it("allows owner → admin (below rank) with 200 and derives username from email", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "tank@warp.test", role: "admin" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("admin");
    expect(create.mock.calls[0][0].data.username).toBe("tank");
  });

  it("400s when email is missing (required field)", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ role: "family" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_EMAIL");
    expect(create).not.toHaveBeenCalled();
  });

  it("still 400s on an unknown role before the rank check (zod precedence)", async () => {
    // The rank cap runs AFTER schema validation, so a malformed role is a
    // 400 (not a 403) — proving we didn't reorder the guards.
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "cypher@warp.test", role: "superuser" });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
