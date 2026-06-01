/**
 * Route tests for the PR #381 onboarding TEAM-invite endpoint.
 *
 *   POST /api/people/invite { email, role }
 *     → 200 { ok, token, email, role, expires_at }  — invite created.
 *     → 400 { code: "INVITE_EMAIL_INVALID" }         — malformed email.
 *     → 400 { code: "INVITE_ROLE_INVALID" }          — role not in the shipped
 *                                                       household model.
 *     → 400 { error: "Invalid request" }             — missing email/role.
 *     → 403                                           — caller isn't owner/admin.
 *
 * The TEAM step invites teammates by email + role. owner+admin only (the roster
 * is administrative — same guard as the rest of /api/people). Strategy mirrors
 * people.routes.test.ts: a minimal Express app + supertest with a synthetic auth
 * middleware that stuffs req.user, and an in-memory `userInvite` Prisma mock.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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

import { createPeopleRouter } from "./people.js";

function createPrismaMock() {
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
  app.use("/api", createPeopleRouter(prismaMock));
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("POST /api/people/invite", () => {
  it("creates an invite with a normalized email + validated role (owner)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "  Romain@Acme.CO ", role: "family" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBe("romain@acme.co");
    expect(res.body.role).toBe("family");
    expect(res.body.token).toBeTruthy();
    expect(res.body.expires_at).toBeTruthy();

    const [row] = prisma._invites();
    expect(row.email).toBe("romain@acme.co");
    expect(row.role).toBe("family");
    expect(row.createdBy).toBe("stefan");
  });

  it("allows admin too", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: "a1", username: "admin1", role: "admin" });
    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "sam@acme.co", role: "guest" });
    expect(res.status).toBe(200);
  });

  it("returns 403 for a family-role caller (administrative surface)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: "f1", username: "fam", role: "family" });
    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "sam@acme.co", role: "guest" });
    expect(res.status).toBe(403);
    expect(prisma._invites()).toHaveLength(0);
  });

  it("400s an invalid email inline (INVITE_EMAIL_INVALID), no write", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "not-an-email", role: "family" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVITE_EMAIL_INVALID");
    expect(prisma._invites()).toHaveLength(0);
  });

  it("400s a role outside the household model (INVITE_ROLE_INVALID), no write", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "sam@acme.co", role: "manager" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVITE_ROLE_INVALID");
    expect(prisma._invites()).toHaveLength(0);
  });

  it("400s a missing body", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app).post("/api/people/invite").send({});
    expect(res.status).toBe(400);
    expect(prisma._invites()).toHaveLength(0);
  });

  it("emits an audit ActivityRow on success", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    await request(app)
      .post("/api/people/invite")
      .send({ email: "nina@acme.co", role: "family" });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const arg = recordActivityMock.mock.calls[0][0];
    expect(arg.kind).toBe("auth");
    // The audit row must NOT leak the token; it records who invited whom.
    expect(JSON.stringify(arg)).not.toContain("token");
  });
});
