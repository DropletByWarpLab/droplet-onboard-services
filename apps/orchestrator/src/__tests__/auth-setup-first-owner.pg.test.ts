/**
 * WARP-3589 — POST /auth/setup against a REAL Postgres.
 *
 * The unit suite (routes/auth.directory-setup.test.ts) proves the route wires
 * the claim check and opens a SERIALIZABLE transaction, but a mocked client
 * cannot prove the property that matters: two concurrent first-owner requests
 * never produce two owner rows. Only the database decides that, so this file
 * drives the real router over the real client.
 *
 *   - unclaimed box  → 403 CLAIM_CODE_REQUIRED, no owner row;
 *   - claimed box    → exactly one owner from two concurrent POSTs; the other
 *                      answers the benign 409 OWNER_EXISTS;
 *   - retry          → a second POST after success is 409, not a claim error.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL (same as the other *.pg.test.ts
 * files). Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — rows this file mints are namespaced `warp3589-` and every
 * cleanup is scoped to that prefix. "An owner exists" and "the box is claimed"
 * are box-wide facts, though, and the shared pg database is not guaranteed to
 * be free of other suites' owner or consumed-claim rows (it was not, in CI).
 * So beforeAll sets any such foreign rows aside (owner -> admin, consumed ->
 * available) and afterAll puts them back exactly as found. The pg lane runs
 * --no-file-parallelism, so no other suite observes the interim state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import type { PrismaClient } from "@prisma/client";

// The DB-less lane's global setup mocks @prisma/client; this file needs the
// real driver (access-role.pg.test.ts precedent).
vi.unmock("@prisma/client");

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    // The claim PREREQUISITE is flag-independent (WARP-3589); leave the code
    // gate off so this file isolates exactly that.
    DROPLET_CLAIM_GATE_ENABLED: false,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
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
    ncDeleteUser: vi.fn().mockResolvedValue(undefined),
    ncEnsureGroup: vi.fn().mockResolvedValue(undefined),
    ncListUsers: vi.fn(),
    ncUpdateUser: vi.fn().mockResolvedValue(undefined),
    ncSetUserEnabled: vi.fn().mockResolvedValue(undefined),
    ncGetUserQuotaAdmin: vi.fn().mockResolvedValue(null),
    ncOAuth2AuthorizeUrl: vi.fn(),
    ncOAuth2ExchangeCode: vi.fn(),
    ncOAuth2RefreshToken: vi.fn(),
    NextcloudOcsError,
    NextcloudUserExistsError,
  };
});

vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("test-nc-token"),
}));

vi.mock("../services/password.service.js", () => ({
  hashPassword: vi.fn(async () => "$argon2id$stub"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  verifyDummyPassword: vi.fn().mockResolvedValue(false),
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({ kind: "ok", record: {} })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: vi.fn(async () => 1),
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  denylistUser: vi.fn().mockResolvedValue(undefined),
  isUserDenied: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic-token"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: vi.fn(),
}));

import { createPublicAuthRouter } from "../routes/auth.js";
import { authRateLimit } from "../middleware/rate-limit.js";
import * as nc from "../services/nextcloud.client.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("POST /auth/setup — real Postgres (WARP-3589)", () => {
  let prisma: PrismaClient;

  const OURS = { startsWith: "warp3589-" } as const;
  const PASSWORD = "Real-pg-secret123";

  let setAsideOwners: string[] = [];
  let setAsideClaims: string[] = [];

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await cleanup();

    setAsideOwners = (
      await prisma.user.findMany({
        where: { role: "owner", NOT: { username: OURS } },
        select: { id: true },
      })
    ).map((u) => u.id);
    if (setAsideOwners.length) {
      await prisma.user.updateMany({
        where: { id: { in: setAsideOwners } },
        data: { role: "admin" },
      });
    }
    setAsideClaims = (
      await prisma.claimCode.findMany({
        where: { state: "consumed", NOT: { codeHash: OURS } },
        select: { id: true },
      })
    ).map((c) => c.id);
    if (setAsideClaims.length) {
      await prisma.claimCode.updateMany({
        where: { id: { in: setAsideClaims } },
        data: { state: "available" },
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    if (setAsideOwners.length) {
      await prisma.user.updateMany({
        where: { id: { in: setAsideOwners } },
        data: { role: "owner" },
      });
    }
    if (setAsideClaims.length) {
      await prisma.claimCode.updateMany({
        where: { id: { in: setAsideClaims } },
        data: { state: "consumed" },
      });
    }
    await prisma.$disconnect();
  });

  /** Prefix-scoped — never an unscoped deleteMany. */
  async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({
      where: { OR: [{ username: OURS }, { nextcloudUsername: OURS }] },
    });
    await prisma.claimCode.deleteMany({ where: { codeHash: OURS } });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    authRateLimit.resetKey("127.0.0.1");
    await cleanup();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createPublicAuthRouter(prisma));
    return app;
  }

  /** Mint the consumed ClaimCode row `isClaimed()` counts. Hash only. */
  async function claimTheBox(): Promise<void> {
    await prisma.claimCode.create({
      data: {
        codeHash: `warp3589-${Date.now()}`,
        state: "consumed",
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  }

  // isClaimed() is a box-wide COUNT of consumed rows; beforeAll set any foreign
  // ones aside, so assert the premise instead of silently passing.
  async function expectNoClaimedRows(): Promise<void> {
    expect(await prisma.claimCode.count({ where: { state: "consumed" } })).toBe(0);
  }

  it("unclaimed box → 403 CLAIM_CODE_REQUIRED and no owner row", async () => {
    await expectNoClaimedRows();

    const res = await request(buildApp())
      .post("/api/auth/setup")
      .send({ email: "warp3589-a@warp.test", password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CLAIM_CODE_REQUIRED");
    expect(await prisma.user.count({ where: { username: OURS } })).toBe(0);
    expect(nc.ncInstallAndCreateAdmin).not.toHaveBeenCalled();
  });

  it("claimed box → two concurrent setups create exactly ONE owner", async () => {
    await claimTheBox();
    const app = buildApp();

    const [a, b] = await Promise.all([
      request(app)
        .post("/api/auth/setup")
        .send({ email: "warp3589-a@warp.test", password: PASSWORD }),
      request(app)
        .post("/api/auth/setup")
        .send({ email: "warp3589-b@warp.test", password: PASSWORD }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe("OWNER_EXISTS");

    expect(
      await prisma.user.count({ where: { role: "owner", username: OURS } }),
    ).toBe(1);
    // Only the winner reached Nextcloud provisioning.
    expect(nc.ncInstallAndCreateAdmin).toHaveBeenCalledTimes(1);
  });

  it("a retry after success is the benign 409 OWNER_EXISTS, not a claim error", async () => {
    await claimTheBox();
    const app = buildApp();

    const first = await request(app)
      .post("/api/auth/setup")
      .send({ email: "warp3589-a@warp.test", password: PASSWORD });
    expect(first.status).toBe(200);

    const retry = await request(app)
      .post("/api/auth/setup")
      .send({ email: "warp3589-a@warp.test", password: PASSWORD });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe("OWNER_EXISTS");
    expect(
      await prisma.user.count({ where: { role: "owner", username: OURS } }),
    ).toBe(1);
  });
});
