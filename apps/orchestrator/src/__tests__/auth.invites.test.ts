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
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

import { createProtectedAuthRouter } from "../routes/auth.js";
import type { Role } from "../services/jwt.service.js";

/** Prisma stub exposing just the `userInvite.create` the create route calls. */
function createPrismaMock() {
  const create = vi.fn(
    async ({ data }: { data: { role: string; username: string } }) => ({
      token: "tok-abc",
      username: data.username,
      displayName: null,
      email: null,
      role: data.role,
      createdBy: "inviter",
      createdAt: new Date("2026-06-01T00:00:00Z"),
      expiresAt: new Date("2026-06-04T00:00:00Z"),
      acceptedAt: null,
      revokedAt: null,
    }),
  );
  return { create, prisma: { userInvite: { create } } as any };
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
      .send({ username: "neo", role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_RANK_EXCEEDED");
    // Fail-closed: nothing is persisted on the rejection path.
    expect(create).not.toHaveBeenCalled();
  });

  it("allows owner → owner with 200 and persists role=owner", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "trinity", role: "owner" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.role).toBe("owner");
  });

  it("allows admin → admin (equal rank) with 200", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "morpheus", role: "admin" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("admin");
  });

  it("allows admin → family (below rank) with 200", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "dozer", role: "family" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("family");
  });

  it("allows owner → admin (below rank) with 200", async () => {
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "tank", role: "admin" });

    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.role).toBe("admin");
  });

  it("still 400s on an unknown role before the rank check (zod precedence)", async () => {
    // The rank cap runs AFTER schema validation, so a malformed role is a
    // 400 (not a 403) — proving we didn't reorder the guards.
    const { create, prisma } = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "cypher", role: "superuser" });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
