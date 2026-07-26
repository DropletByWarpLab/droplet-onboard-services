/**
 * WARP-1533 (RBAC v2 T9) — POST /api/people/invite accepts an optional
 * `accessRoleId` (ADR-032 §5 invite line).
 *
 *   → 200 + row.accessRoleId persisted     — active role, tier agrees.
 *   → 400 ACCESS_ROLE_NOT_FOUND            — unknown role id.
 *   → 400 ACCESS_ROLE_NOT_ACTIVE           — archived role.
 *   → 400 ACCESS_ROLE_NOT_ASSIGNABLE       — owner/service startingPoint row.
 *   → 400 ROLE_TIER_MISMATCH               — invite tier ≠ role startingPoint.
 *   → PIN: admin + Admin-based role is ALLOWED (WARP-623 is ≤, not <).
 *
 * Harness mirrors people-invite.route.test.ts (minimal Express + supertest +
 * synthetic auth middleware + in-memory Prisma mock) — the accessRole
 * delegate is the only addition.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
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

import { createPeopleRouter } from "./people.js";
import type { ScopeName } from "../middleware/scope.js";

const ACTIVE_ROLE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Finance",
  slug: "finance",
  startingPoint: "family",
  state: "active",
};

function createPrismaMock(roles: Array<Record<string, unknown>> = [ACTIVE_ROLE]) {
  const invites: Array<Record<string, unknown>> = [];
  return {
    _invites: () => invites,
    userInvite: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `inv-${invites.length + 1}`, createdAt: new Date(), ...data };
        invites.push(row);
        return row;
      }),
    },
    accessRole: {
      findUnique: vi.fn(async ({ where }: any) => roles.find((r) => r.id === where?.id) ?? null),
    },
  };
}

function buildApp(
  prismaMock: any,
  user: { id: string; username: string; role: string } = {
    id: "owner-id",
    username: "stefan",
    role: "owner",
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { ...user, displayName: user.username };
    next();
  });
  app.use(
    "/api",
    createPeopleRouter(prismaMock, async () => new Set<ScopeName>(["team"])),
  );
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("POST /api/people/invite — accessRoleId", () => {
  it("persists accessRoleId on the invite row and echoes it (active role, tier agrees)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app).post("/api/people/invite").send({
      email: "reception@acme.co",
      role: "family",
      accessRoleId: ACTIVE_ROLE.id,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.access_role_id).toBe(ACTIVE_ROLE.id);

    const [row] = prisma._invites();
    expect(row.accessRoleId).toBe(ACTIVE_ROLE.id);
    expect(row.role).toBe("family");
  });

  it("PIN — an admin can send an Admin-based-role invite (≤ their tier, WARP-623)", async () => {
    const adminRole = { ...ACTIVE_ROLE, id: "22222222-2222-4222-8222-222222222222", startingPoint: "admin" };
    const prisma = createPrismaMock([adminRole]);
    const app = buildApp(prisma, { id: "a1", username: "admin1", role: "admin" });

    const res = await request(app).post("/api/people/invite").send({
      email: "ops@acme.co",
      role: "admin",
      accessRoleId: adminRole.id,
    });

    expect(res.status).toBe(200);
    expect(prisma._invites()[0].accessRoleId).toBe(adminRole.id);
  });

  it("400 ACCESS_ROLE_NOT_FOUND when the role id is unknown — no row written", async () => {
    const prisma = createPrismaMock([]);
    const app = buildApp(prisma);

    const res = await request(app).post("/api/people/invite").send({
      email: "reception@acme.co",
      role: "family",
      accessRoleId: "33333333-3333-4333-8333-333333333333",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ACCESS_ROLE_NOT_FOUND");
    expect(prisma._invites()).toHaveLength(0);
  });

  it("400 ACCESS_ROLE_NOT_ACTIVE for an archived role — no row written", async () => {
    const prisma = createPrismaMock([{ ...ACTIVE_ROLE, state: "archived" }]);
    const app = buildApp(prisma);

    const res = await request(app).post("/api/people/invite").send({
      email: "reception@acme.co",
      role: "family",
      accessRoleId: ACTIVE_ROLE.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ACCESS_ROLE_NOT_ACTIVE");
    expect(prisma._invites()).toHaveLength(0);
  });

  it("400 ACCESS_ROLE_NOT_ASSIGNABLE on an owner-startingPoint row (fail-closed, even for owner)", async () => {
    const prisma = createPrismaMock([{ ...ACTIVE_ROLE, startingPoint: "owner" }]);
    const app = buildApp(prisma);

    // The invite TIER is `admin`, not `owner`: WARP-1526 rail 7 refuses an
    // owner-tier invite outright (403 ROLE_NOT_ASSIGNABLE — there is exactly
    // one owner by design, design brief §6.2), so an owner tier would never
    // reach the access-role service. The case under test is the ROLE's
    // corrupt owner startingPoint, which is still reached — and still
    // fail-closed — on a legitimately-assignable tier.
    const res = await request(app).post("/api/people/invite").send({
      email: "reception@acme.co",
      role: "admin",
      accessRoleId: ACTIVE_ROLE.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ACCESS_ROLE_NOT_ASSIGNABLE");
    expect(prisma._invites()).toHaveLength(0);
  });

  it("400 ROLE_TIER_MISMATCH when both are supplied but disagree", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app).post("/api/people/invite").send({
      email: "reception@acme.co",
      role: "guest",
      accessRoleId: ACTIVE_ROLE.id, // Finance is family-based
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ROLE_TIER_MISMATCH");
    expect(prisma._invites()).toHaveLength(0);
  });

  it("400 on a non-UUID accessRoleId (zod boundary)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app).post("/api/people/invite").send({
      email: "reception@acme.co",
      role: "family",
      accessRoleId: "not-a-uuid",
    });

    expect(res.status).toBe(400);
    expect(prisma._invites()).toHaveLength(0);
  });

  it("Activity: an access-role invite records the ADR-032 wording + role refs", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    await request(app).post("/api/people/invite").send({
      email: "reception@acme.co",
      role: "family",
      accessRoleId: ACTIVE_ROLE.id,
    });

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const entry = recordActivityMock.mock.calls[0][0];
    expect(entry.kind).toBe("auth");
    expect(entry.what).toBe("Invite created with access role");
    expect(entry.sub).toContain("Finance");
    expect(entry.refs.accessRoleId).toBe(ACTIVE_ROLE.id);
    expect(entry.refs.accessRoleStartingPoint).toBe("family");
  });

  it("Activity: a plain tier invite keeps the shipped 'Teammate invited' wording", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    await request(app)
      .post("/api/people/invite")
      .send({ email: "plain@acme.co", role: "family" });

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0][0].what).toBe("Teammate invited");
    expect(prisma._invites()[0].accessRoleId ?? null).toBeNull();
  });
});
