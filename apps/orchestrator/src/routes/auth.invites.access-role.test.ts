/**
 * WARP-1533 (RBAC v2 T9) — accessRoleId through the legacy invite surface
 * and the accept-path assignment (the WARP-1051 mint).
 *
 * Create (POST /api/auth/invites — the dashboard invite modal's endpoint):
 *   the SAME fail-closed validation as /api/people/invite via the shared
 *   invite-access-role.service (active + assignable + rank-capped + tier
 *   agreement), persisted to the UserInvite row. The two create surfaces
 *   must never diverge (the WARP-1523 lesson).
 *
 * Accept (POST /api/auth/invites/accept/:token):
 *   - role resolves → User.accessRoleId AND User.role = startingPoint are
 *     written by the SAME atomic upsert (both branches), the session role
 *     is the resolved tier (WARP-1051 canonical-role rule intact), and the
 *     Nextcloud groups derive from the resolved tier.
 *   - role vanished/archived between invite and accept → the accept NEVER
 *     fails: fall back to the invite's plain tier (least privilege), leave
 *     accessRoleId unset, and log + Activity-note the fallback.
 *
 * Harness mirrors auth.directory-invite-accept.test.ts (same mocks, real
 * argon2id, supertest against the real routers); the accessRole delegate and
 * the hoisted recordActivity handle are the additions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";

// ── Config mock — must be hoisted above route imports. ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 604800,
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/nextcloud.client.js", () => {
  class NextcloudOcsError extends Error {
    public readonly ocsStatus: number;
    constructor(message: string, ocsStatus: number) {
      super(message);
      this.name = "NextcloudOcsError";
      this.ocsStatus = ocsStatus;
    }
  }
  class NextcloudUserExistsError extends NextcloudOcsError {
    constructor(message = "User already exists") {
      super(message, 102);
      this.name = "NextcloudUserExistsError";
    }
  }
  return {
    ncCheckSetupRequired: vi.fn(),
    ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
    ncLoginWithCredentials: vi.fn(),
    ncDeleteAppPassword: vi.fn().mockResolvedValue(undefined),
    ncGetCurrentUser: vi.fn(),
    ncCreateUser: vi.fn().mockResolvedValue(undefined),
    ncDeleteUser: vi.fn(),
    ncListUsers: vi.fn(),
    ncUpdateUser: vi.fn(),
    ncSetUserEnabled: vi.fn(),
    ncOAuth2AuthorizeUrl: vi.fn(),
    ncOAuth2ExchangeCode: vi.fn(),
    ncOAuth2RefreshToken: vi.fn(),
    NextcloudOcsError,
    NextcloudUserExistsError,
  };
});

const storeNcToken = vi.fn().mockResolvedValue(undefined);
const getNcToken = vi.fn().mockResolvedValue(null);
const deleteNcToken = vi.fn().mockResolvedValue(undefined);
const touchNcToken = vi.fn().mockResolvedValue(undefined);
const resolveNcToken = vi.fn().mockResolvedValue("test-nc-token");
vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: (...args: unknown[]) => storeNcToken(...args),
  getNcToken: (...args: unknown[]) => getNcToken(...args),
  deleteNcToken: (...args: unknown[]) => deleteNcToken(...args),
  touchNcToken: (...args: unknown[]) => touchNcToken(...args),
  resolveNcToken: (...args: unknown[]) => resolveNcToken(...args),
}));

vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return {
    ...actual,
    denyRefreshToken: vi.fn().mockResolvedValue(undefined),
    claimRefreshRotation: vi.fn().mockResolvedValue(true),
  };
});

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

import { createPublicAuthRouter, createProtectedAuthRouter } from "./auth.js";
import * as nc from "../services/nextcloud.client.js";
import { verifyAccessToken } from "../services/jwt.service.js";

const FAMILY_ROLE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Reception",
  slug: "reception",
  startingPoint: "family",
  state: "active",
};
const ADMIN_ROLE = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Ops lead",
  slug: "ops-lead",
  startingPoint: "admin",
  state: "active",
};

// ── In-memory Prisma stand-in: user + userInvite + accessRole surfaces ──
function createPrismaMock(roles: Array<Record<string, unknown>> = [FAMILY_ROLE, ADMIN_ROLE]) {
  const users: any[] = [];
  const invites: any[] = [];
  let userCounter = 0;
  let inviteCounter = 0;
  const self: any = {};
  self.user = {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const idx = users.findIndex(
        (u) =>
          (where?.nextcloudUsername !== undefined &&
            u.nextcloudUsername === where.nextcloudUsername) ||
          (where?.email !== undefined && u.email === where.email) ||
          (where?.id !== undefined && u.id === where.id) ||
          (where?.username !== undefined && u.username === where.username),
      );
      if (idx >= 0) {
        users[idx] = { ...users[idx], ...update, updatedAt: new Date() };
        return users[idx];
      }
      const row = {
        id: create.id ?? `u-uuid-${++userCounter}`,
        isLocal: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      users.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      if (where?.emailLookupHash !== undefined)
        return users.find((u: any) => u.emailLookupHash === where.emailLookupHash) ?? null;
      if (where?.email !== undefined) return users.find((u) => u.email === where.email) ?? null;
      if (where?.nextcloudUsername !== undefined)
        return users.find((u) => u.nextcloudUsername === where.nextcloudUsername) ?? null;
      if (where?.id !== undefined) return users.find((u) => u.id === where.id) ?? null;
      if (where?.username !== undefined)
        return users.find((u) => u.username === where.username) ?? null;
      return null;
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const orClauses = where?.OR ?? [];
      return (
        users.find((u) =>
          orClauses.some(
            (clause: any) =>
              (clause.username !== undefined && u.username === clause.username) ||
              (clause.nextcloudUsername !== undefined &&
                u.nextcloudUsername === clause.nextcloudUsername),
          ),
        ) ?? null
      );
    }),
  };
  self.userInvite = {
    create: vi.fn(async ({ data }: any) => {
      if (invites.some((r) => r.token === data.token)) {
        const e: any = new Error("Unique constraint failed on token");
        e.code = "P2002";
        throw e;
      }
      const row = {
        id: `inv-${++inviteCounter}`,
        displayName: null,
        email: null,
        role: "family",
        accessRoleId: null,
        acceptedAt: null,
        acceptedFrom: null,
        revokedAt: null,
        createdAt: new Date(),
        ...data,
      };
      invites.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      if (where?.token) return invites.find((r) => r.token === where.token) ?? null;
      if (where?.id) return invites.find((r) => r.id === where.id) ?? null;
      return null;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const idx = invites.findIndex((r) => r.id === where.id || r.token === where.token);
      if (idx < 0) {
        const e: any = new Error("not found");
        e.code = "P2025";
        throw e;
      }
      invites[idx] = { ...invites[idx], ...data };
      return invites[idx];
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (let i = 0; i < invites.length; i += 1) {
        const r = invites[i];
        if (where?.id !== undefined && r.id !== where.id) continue;
        if (where?.token !== undefined && r.token !== where.token) continue;
        if (where?.acceptedAt === null && r.acceptedAt !== null) continue;
        invites[i] = { ...r, ...data };
        count += 1;
      }
      return { count };
    }),
  };
  self.userInvite.findMany = vi.fn(async () =>
    // Most-recent-first, matching the route's `orderBy: { createdAt: "desc" }`.
    [...invites].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  );
  self.accessRole = {
    findUnique: vi.fn(async ({ where }: any) => roles.find((r) => r.id === where?.id) ?? null),
  };
  self.totpCredential = { findUnique: vi.fn(async () => null) };
  self.recoveryCode = {
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
  self._users = users;
  self._invites = invites;
  self._roles = roles;
  return self;
}

type TestUser = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "admin" | "family" | "guest";
};

function buildApp(
  prismaMock: any,
  user: TestUser | null = { id: "admin", username: "admin-issuer", displayName: "Admin", role: "owner" },
) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(prismaMock));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as any).user = user;
    next();
  });
  app.use("/api", createProtectedAuthRouter(prismaMock));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "internal" });
  });
  return app;
}

/** Decode the droplet_session cookie's access JWT off a response. */
function sessionJwt(res: request.Response) {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const sessionCookie = cookies.find((c) => c?.startsWith("droplet_session="));
  if (!sessionCookie) throw new Error("droplet_session cookie not set");
  const raw = sessionCookie.split(";")[0]!.replace("droplet_session=", "");
  const decoded = verifyAccessToken(raw);
  if (!decoded) throw new Error("verifyAccessToken returned null");
  return decoded;
}

const INVITE_PASSWORD = "Accept-secret123";

/** Issue an invite via the legacy admin endpoint and return its token. */
async function issueInvite(app: express.Express, body: Record<string, unknown>) {
  const res = await request(app).post("/api/auth/invites").send(body);
  expect(res.status).toBe(200);
  return res.body.token as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  (nc.ncCreateUser as any).mockResolvedValue(undefined);
  (nc.ncLoginWithCredentials as any).mockResolvedValue({
    token: "nc-app-password",
    loginName: "reception",
  });
  storeNcToken.mockResolvedValue(undefined);
});

describe("POST /api/auth/invites — accessRoleId (legacy surface, shared validation)", () => {
  it("persists accessRoleId when the role is active and the tier agrees", async () => {
    const prisma = createPrismaMock();
    await issueInvite(buildApp(prisma), {
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });
    expect(prisma._invites[0].accessRoleId).toBe(FAMILY_ROLE.id);
    expect(prisma._invites[0].role).toBe("family");
  });

  it("400 ACCESS_ROLE_NOT_ACTIVE for an archived role — no row written", async () => {
    const prisma = createPrismaMock([{ ...FAMILY_ROLE, state: "archived" }]);
    const res = await request(buildApp(prisma)).post("/api/auth/invites").send({
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ACCESS_ROLE_NOT_ACTIVE");
    expect(prisma._invites).toHaveLength(0);
  });

  it("400 ROLE_TIER_MISMATCH when the tier and the role's startingPoint disagree", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma)).post("/api/auth/invites").send({
      email: "reception@warp.test",
      role: "admin",
      accessRoleId: FAMILY_ROLE.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ROLE_TIER_MISMATCH");
    expect(prisma._invites).toHaveLength(0);
  });

  it("Activity: an access-role invite on the legacy surface records the ADR-032 wording", async () => {
    const prisma = createPrismaMock();
    await issueInvite(buildApp(prisma), {
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });
    const call = recordActivityMock.mock.calls.find(
      (c: any[]) => c[0]?.what === "Invite created with access role",
    );
    expect(call).toBeDefined();
    expect(call![0].kind).toBe("auth");
    expect(call![0].refs.accessRoleId).toBe(FAMILY_ROLE.id);
  });
});

describe("accept path — accessRoleId assignment in the mint (WARP-1051 pattern)", () => {
  it("writes BOTH User.accessRoleId and User.role = startingPoint in the same atomic upsert; session role = resolved tier", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);

    // ONE atomic statement carries both fields — the "same transaction"
    // contract (a two-step write could crash between role and accessRoleId).
    expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = (prisma.user.upsert as any).mock.calls[0][0];
    expect(upsertArg.create.accessRoleId).toBe(FAMILY_ROLE.id);
    expect(upsertArg.create.role).toBe("family");
    // The re-acceptance (update) branch keeps the pair in lockstep too.
    expect(upsertArg.update.accessRoleId).toBe(FAMILY_ROLE.id);
    expect(upsertArg.update.role).toBe("family");

    const row = prisma._users[0];
    expect(row.accessRoleId).toBe(FAMILY_ROLE.id);
    expect(row.role).toBe("family");

    // Session role = the resolved tier (canonical-role rule, WARP-1051).
    expect(sessionJwt(res).role).toBe("family");
    expect(res.body.user.role).toBe("family");
  });

  it("an Admin-based role lands the admin tier end-to-end (row, session, NC groups)", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      email: "ops@warp.test",
      role: "admin",
      accessRoleId: ADMIN_ROLE.id,
    });

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);

    const row = prisma._users[0];
    expect(row.accessRoleId).toBe(ADMIN_ROLE.id);
    expect(row.role).toBe("admin");
    expect(sessionJwt(res).role).toBe("admin");
    // NC groups derive from the resolved tier — an admin invitee lands the
    // NC admin group (pre-WARP-171 wire contract preserved).
    const groupsArg = (nc.ncCreateUser as any).mock.calls[0]?.[4] as string[];
    expect(groupsArg).toContain("admin");
  });

  it("a drifted invite row (tier ≠ startingPoint) resolves toward the ROLE's startingPoint everywhere", async () => {
    // Unreachable via the create endpoints (ROLE_TIER_MISMATCH) — pins the
    // invariant for hand-edited/legacy rows: User.role and accessRoleId stay
    // in lockstep, with the startingPoint as the one truth.
    const prisma = createPrismaMock();
    prisma._invites.push({
      id: "inv-drift",
      token: "drifted-invite-token-aaaaaaaaaaaaaaaaaaaaaaa",
      username: "drifter",
      displayName: null,
      email: "drifter@warp.test",
      role: "guest",
      accessRoleId: FAMILY_ROLE.id,
      createdBy: "admin-issuer",
      expiresAt: new Date(Date.now() + 3600_000),
      acceptedAt: null,
      acceptedFrom: null,
      revokedAt: null,
      createdAt: new Date(),
    });

    const res = await request(buildApp(prisma, null))
      .post("/api/auth/invites/accept/drifted-invite-token-aaaaaaaaaaaaaaaaaaaaaaa")
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);

    const row = prisma._users[0];
    expect(row.role).toBe("family");
    expect(row.accessRoleId).toBe(FAMILY_ROLE.id);
    expect(sessionJwt(res).role).toBe("family");
    // NC groups follow the resolved tier (family ⇒ household, not guest).
    const groupsArg = (nc.ncCreateUser as any).mock.calls[0]?.[4] as string[];
    expect(groupsArg).toContain("household");
  });

  it("role deleted between invite and accept → falls back to the invite tier, never fails, Activity-notes it", async () => {
    const roles: Array<Record<string, unknown>> = [FAMILY_ROLE];
    const prisma = createPrismaMock(roles);
    const token = await issueInvite(buildApp(prisma), {
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });
    roles.length = 0; // the role row vanishes before the invitee accepts

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);

    const row = prisma._users[0];
    expect(row.role).toBe("family"); // the invite's plain tier
    expect(row.accessRoleId ?? null).toBeNull();
    expect(sessionJwt(res).role).toBe("family");

    const fallback = recordActivityMock.mock.calls.find(
      (c: any[]) => c[0]?.what === "Invite accepted without access role",
    );
    expect(fallback).toBeDefined();
    expect(fallback![0].kind).toBe("auth");
    expect(fallback![0].severity).toBe("warn");
    expect(fallback![0].refs.accessRoleId).toBe(FAMILY_ROLE.id);
    expect(fallback![0].refs.fallbackReason).toBe("missing");
  });

  it("role archived between invite and accept → same fallback, reason archived", async () => {
    const roles: Array<Record<string, unknown>> = [{ ...FAMILY_ROLE }];
    const prisma = createPrismaMock(roles);
    const token = await issueInvite(buildApp(prisma), {
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });
    roles[0]!.state = "archived";

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);

    const row = prisma._users[0];
    expect(row.role).toBe("family");
    expect(row.accessRoleId ?? null).toBeNull();

    const fallback = recordActivityMock.mock.calls.find(
      (c: any[]) => c[0]?.what === "Invite accepted without access role",
    );
    expect(fallback).toBeDefined();
    expect(fallback![0].refs.fallbackReason).toBe("archived");
  });

  it("an infra failure reading the role ABORTS the accept — never a silent plain-tier grant (review F1)", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });
    // The role read now fails for an INFRASTRUCTURE reason (not "archived",
    // not "missing") — the accept must not proceed onto the plain tier.
    prisma.accessRole.findUnique.mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
    // ZERO mutation: the resolution runs BEFORE the WARP-490 CAS claim and
    // before ncCreateUser, so the invite stays unclaimed and retryable and
    // no account is provisioned at any tier.
    expect(prisma._users).toHaveLength(0);
    expect(prisma._invites[0].acceptedAt).toBeNull();
    expect(nc.ncCreateUser).not.toHaveBeenCalled();
    // And no fallback was recorded — an infra error is not an access verdict.
    expect(
      recordActivityMock.mock.calls.find(
        (c: any[]) => c[0]?.what === "Invite accepted without access role",
      ),
    ).toBeUndefined();
  });

  it("a plain tier invite accepts exactly as before — no accessRoleId, no fallback Activity", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      email: "plain@warp.test",
      role: "family",
    });

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);

    const row = prisma._users[0];
    expect(row.role).toBe("family");
    expect(row.accessRoleId ?? null).toBeNull();
    expect(
      recordActivityMock.mock.calls.find(
        (c: any[]) => c[0]?.what === "Invite accepted without access role",
      ),
    ).toBeUndefined();
  });
});

/**
 * WARP-1566 — the two READ surfaces T9 left behind.
 *
 * T9 (WARP-1533) taught the invite to CARRY an accessRoleId and the accept
 * path to ASSIGN it, but neither read surface exposes it. The operator
 * consequence is concrete: the "Pending invites" list can show that someone
 * was invited, and at which built-in tier, but not which custom role they
 * will actually land in — so the one screen that exists to review pending
 * grants cannot review the T9 grant at all.
 *
 * Both surfaces return an EXPLICIT `null` for a plain-tier invite rather
 * than omitting the key. Omission is indistinguishable on the wire from "an
 * orchestrator too old to send it", and the dashboard has to tell those
 * apart to decide between rendering a tier label and rendering nothing (the
 * same three-state discipline the T8 roster extension uses for `role`).
 */
describe("WARP-1566 — accessRoleId on the invite READ surfaces", () => {
  describe("GET /api/auth/invites (admin list)", () => {
    it("carries accessRoleId for a role-bearing invite", async () => {
      const prisma = createPrismaMock();
      const app = buildApp(prisma);
      await issueInvite(app, {
        email: "reception@warp.test",
        role: "family",
        accessRoleId: FAMILY_ROLE.id,
      });

      const res = await request(app).get("/api/auth/invites");
      expect(res.status).toBe(200);
      expect(res.body.invites).toHaveLength(1);
      expect(res.body.invites[0].accessRoleId).toBe(FAMILY_ROLE.id);
    });

    it("carries an EXPLICIT null for a plain-tier invite — the key is never omitted", async () => {
      const prisma = createPrismaMock();
      const app = buildApp(prisma);
      await issueInvite(app, { email: "plain@warp.test", role: "guest" });

      const res = await request(app).get("/api/auth/invites");
      expect(res.status).toBe(200);
      const [row] = res.body.invites;
      expect(row).toHaveProperty("accessRoleId");
      expect(row.accessRoleId).toBeNull();
    });

    it("still refuses a non-admin caller — the new field widens no guard", async () => {
      const prisma = createPrismaMock();
      await issueInvite(buildApp(prisma), {
        email: "reception@warp.test",
        role: "family",
        accessRoleId: FAMILY_ROLE.id,
      });

      const res = await request(
        buildApp(prisma, {
          id: "u-fam",
          username: "family-user",
          displayName: "Fam",
          role: "family",
        }),
      ).get("/api/auth/invites");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/auth/invites/accept/:token (public accept metadata)", () => {
    it("carries accessRoleId for a role-bearing invite", async () => {
      const prisma = createPrismaMock();
      const token = await issueInvite(buildApp(prisma), {
        email: "opslead@warp.test",
        role: "admin",
        accessRoleId: ADMIN_ROLE.id,
      });

      const res = await request(buildApp(prisma, null)).get(
        `/api/auth/invites/accept/${token}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.accessRoleId).toBe(ADMIN_ROLE.id);
    });

    it("carries an EXPLICIT null for a plain-tier invite", async () => {
      const prisma = createPrismaMock();
      const token = await issueInvite(buildApp(prisma), {
        email: "plain@warp.test",
        role: "guest",
      });

      const res = await request(buildApp(prisma, null)).get(
        `/api/auth/invites/accept/${token}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("accessRoleId");
      expect(res.body.accessRoleId).toBeNull();
    });

    it("leaks NOTHING else — the projection stays an explicit allowlist", async () => {
      // The row carries `token`, `createdBy`, `email` and the send-state
      // columns. This endpoint is PUBLIC (the URL token is the only
      // credential), so its projection is an allowlist, not a row spread —
      // adding accessRoleId must not turn it into one.
      const prisma = createPrismaMock();
      const token = await issueInvite(buildApp(prisma), {
        email: "opslead@warp.test",
        role: "admin",
        accessRoleId: ADMIN_ROLE.id,
      });

      const res = await request(buildApp(prisma, null)).get(
        `/api/auth/invites/accept/${token}`,
      );
      expect(Object.keys(res.body).sort()).toEqual([
        "accessRoleId",
        "displayName",
        "expiresAt",
        "role",
        "username",
      ]);
    });
  });
});

/**
 * WARP-1582 — the invite-accept mint site must stamp the access-role claim.
 *
 * The claim is only worth anything if every mint site actually populates
 * it; a site that forgets produces a claim-less token, and the consumer
 * falls back to the per-request database read it was meant to avoid
 * (safe, but silently unoptimised — the failure mode nothing would catch).
 *
 * The accept path is the interesting one because the row it writes and
 * the role the invite ASKED for can differ: on the T9 fallback (role
 * deleted or archived between invite and accept) no assignment happens.
 * The claim must follow the ROW, never the invite's intent.
 */
describe("WARP-1582 — accessRoleId claim on the invite-accept session", () => {
  it("stamps the applied role id into the minted access token", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);
    expect(sessionJwt(res).accessRoleId).toBe(FAMILY_ROLE.id);
  });

  it("stamps an EXPLICIT null for a plain-tier invite — present, not absent", async () => {
    // `null` is what lets the chat path skip its read. An absent claim
    // would be safe but pointless; the assertion distinguishes them.
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      email: "plain@warp.test",
      role: "family",
    });

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);
    const decoded = sessionJwt(res);
    expect(decoded).toHaveProperty("accessRoleId");
    expect(decoded.accessRoleId).toBeNull();
  });

  it("follows the ROW, not the invite, when the role vanished before accept", async () => {
    // T9 fallback: the accept lands on the plain tier with no assignment.
    // A claim stamped from `invite.accessRoleId` would name a role this
    // person does NOT hold — and would then make the chat path read the
    // database for a role that isn't there, inverting the optimisation
    // into a pessimisation on top of being wrong.
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      email: "reception@warp.test",
      role: "family",
      accessRoleId: FAMILY_ROLE.id,
    });
    prisma._roles.length = 0; // role deleted between invite and accept

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);
    expect(sessionJwt(res).accessRoleId).toBeNull();
  });
});
