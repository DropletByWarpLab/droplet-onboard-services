/**
 * WARP-485 — req.user.id normalization across JWT + OCS auth paths.
 *
 * Pre-fix the OCS fallback set `req.user.id = ocs.data.id` (the
 * Nextcloud username string), which silently broke WARP-480's
 * self-action guard on /api/people/:id mutations under OCS auth —
 * `req.params.id === req.user?.id` always returned false-negative
 * because params is a UUID and OCS-path id was a username.
 *
 * This file pins the contract: `req.user.id` is ALWAYS the local
 * `User.id` UUID, regardless of which auth path populated the session.
 * Coverage:
 *
 *   1. JWT path → req.user.id = jwtPayload.sub (UUID, unchanged).
 *   2. OCS path + matching User row → req.user.id = localUser.id UUID.
 *   3. OCS path + NO matching User → 401 USER_NOT_PROVISIONED.
 *   4. Integration: WARP-480 self-guard under OCS auth — an owner
 *      authenticated via OCS attempts to DELETE themselves and gets
 *      the expected 409 SELF_ACTION_NOT_ALLOWED. This proves the
 *      normalization works end-to-end across auth + the people route.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    JWT_SECRET: "test-secret-at-least-32-chars-long-aaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Force cache miss so every test exercises the live validation path.
const cacheGet = vi.fn().mockResolvedValue(null);
const cacheSet = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...args: unknown[]) => cacheGet(...args),
  cacheSet: (...args: unknown[]) => cacheSet(...args),
}));

// JWT verifier — most tests force it to fail so the OCS path runs.
// The JWT-path test below overrides this to a payload.
const verifyAccessToken = vi.fn().mockReturnValue(null);
const roleFromGroups = vi.fn().mockReturnValue("family");
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (...args: unknown[]) => verifyAccessToken(...args),
  roleFromGroups: (...args: unknown[]) => roleFromGroups(...args),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
}));

// Mocks above hoist before the static import below.
import {
  authMiddleware,
  _setAuthPrismaForTests,
} from "../middleware/auth.js";
import { createPeopleRouter } from "../routes/people.js";
import type { ScopeName } from "../middleware/scope.js";
import { createTransactionSeam } from "./helpers/prisma-tx-harness.js";

// In-memory User table mock — keyed by nextcloudUsername for the OCS
// lookup and by id for the people-routes lookups. Production wires
// the real PrismaClient via setAuthPrisma(prisma) at app boot.
interface MockUserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
  role: string;
  isLocal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function buildPrismaMock(rows: MockUserRow[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byNcUsername = new Map(
    rows
      .filter((r) => r.nextcloudUsername)
      .map((r) => [r.nextcloudUsername!, r]),
  );
  const self: any = {};
  // WARP-1570: shared seam — people.ts opens its guard rails with
  // SERIALIZABLE_TX, which the old stub discarded outright.
  const seam = createTransactionSeam({
    client: () => self,
    stores: { byId, byNcUsername },
  });
  self.$transaction = seam.$transaction;
  self._seam = () => seam;
  self.user = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      if (where.id !== undefined) return byId.get(where.id) ?? null;
      if (where.nextcloudUsername !== undefined) {
        return byNcUsername.get(where.nextcloudUsername) ?? null;
      }
      return null;
    }),
    findMany: vi.fn(async () => [...byId.values()]),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = byId.get(where.id);
      if (!row) {
        const err: any = new Error("not found");
        err.code = "P2025";
        throw err;
      }
      byId.delete(where.id);
      if (row.nextcloudUsername) byNcUsername.delete(row.nextcloudUsername);
      return row;
    }),
    count: vi.fn(async ({ where }: { where?: { role?: string } } = {}) => {
      if (!where || where.role === undefined) return byId.size;
      let n = 0;
      for (const u of byId.values()) if (u.role === where.role) n += 1;
      return n;
    }),
  };
  return self;
}

function buildOcsResponse(ncUserId: string, displayName: string) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ocs: {
        meta: { status: "ok" },
        data: {
          id: ncUserId,
          "display-name": displayName,
          groups: [],
        },
      },
    }),
  } as unknown as Response;
}

function mockReq(token: string, path = "/api/people"): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    path,
    params: {},
  } as unknown as Request;
}

function mockRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    clearCookie: vi.fn(),
  };
  return res;
}

// One-shot helper: run authMiddleware to completion (sync OR async OCS).
async function runAuth(req: Request, res: any) {
  const next = vi.fn();
  authMiddleware(req, res, next as unknown as NextFunction);
  // Drain validateNextcloudToken's promise chain.
  await new Promise((r) => setImmediate(r));
  return { next };
}

describe("WARP-485 — req.user.id normalization", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    cacheGet.mockClear();
    cacheSet.mockClear();
    verifyAccessToken.mockReset().mockReturnValue(null);
    roleFromGroups.mockReset().mockReturnValue("family");
    global.fetch = vi.fn();
    _setAuthPrismaForTests(null);
  });

  // Restore the real fetch when the suite finishes so other suites
  // running in the same vitest process don't see our stub.
  afterAll(() => {
    global.fetch = realFetch;
  });

  it("JWT path: req.user.id = jwtPayload.sub UUID (unchanged behavior)", async () => {
    // No prisma needed — JWT path short-circuits the OCS lookup.
    _setAuthPrismaForTests(null);
    verifyAccessToken.mockReturnValueOnce({
      sub: "u-uuid-1111",
      username: "alice",
      displayName: "Alice",
      role: "owner",
    });

    const req = mockReq("jwt-token");
    const res = mockRes();
    const { next } = await runAuth(req, res);

    expect(next).toHaveBeenCalledTimes(1);
    const user = (req as any).user;
    expect(user).toBeDefined();
    expect(user.id).toBe("u-uuid-1111");
    expect(user.username).toBe("alice");
    // OCS path never ran — no fetch.
    expect((global.fetch as any)).not.toHaveBeenCalled();
  });

  it("OCS path: req.user.id is the local User.id UUID, NOT the NC username", async () => {
    // Local row exists with nextcloudUsername="stefan-cruceru" and a
    // proper UUID id. The middleware must resolve the OCS token to the
    // local row's UUID, not pass through `ocs.data.id`.
    const localUser: MockUserRow = {
      id: "u-uuid-stefan-7777",
      username: "stefan-cruceru",
      displayName: "Stefan Cruceru",
      email: null,
      nextcloudUsername: "stefan-cruceru",
      role: "owner",
      isLocal: false,
      createdAt: new Date("2026-05-26T10:00:00Z"),
      updatedAt: new Date("2026-05-26T10:00:00Z"),
    };
    const prisma = buildPrismaMock([localUser]);
    _setAuthPrismaForTests(prisma);
    roleFromGroups.mockReturnValue("owner");
    (global.fetch as any).mockResolvedValueOnce(
      buildOcsResponse("stefan-cruceru", "Stefan Cruceru"),
    );

    const req = mockReq("ocs-legacy-token");
    const res = mockRes();
    const { next } = await runAuth(req, res);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    const user = (req as any).user;
    expect(user).toBeDefined();
    // The contract: req.user.id is the local UUID, never the NC username.
    expect(user.id).toBe("u-uuid-stefan-7777");
    expect(user.id).not.toBe("stefan-cruceru");
    // Display fields keep the OCS-derived values for UX continuity.
    expect(user.username).toBe("stefan-cruceru");
    expect(user.displayName).toBe("Stefan Cruceru");
    expect(user.role).toBe("owner");
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { nextcloudUsername: "stefan-cruceru" },
    });
  });

  it("OCS path + no matching local User row → 401 USER_NOT_PROVISIONED (fail-closed)", async () => {
    // Auto-provisioning here would be a privilege-escalation vector
    // (an attacker who holds a valid OCS token for an unrelated NC user
    // could otherwise mint a local row with default `family` role).
    // Operators must explicitly provision the user via /api/people.
    const prisma = buildPrismaMock([]); // empty directory
    _setAuthPrismaForTests(prisma);
    (global.fetch as any).mockResolvedValueOnce(
      buildOcsResponse("unprovisioned-nc-user", "Unknown User"),
    );

    const req = mockReq("ocs-legacy-token");
    const res = mockRes();
    const { next } = await runAuth(req, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      code: "USER_NOT_PROVISIONED",
    });
    expect((req as any).user).toBeUndefined();
  });

  it("OCS path + prisma singleton not initialised → 401 USER_NOT_PROVISIONED (defense in depth)", async () => {
    // If the orchestrator boot order ever changes such that auth runs
    // before initAuthPrisma(), we MUST fail closed rather than promote
    // the OCS-username string to req.user.id (regressing WARP-485).
    _setAuthPrismaForTests(null);
    (global.fetch as any).mockResolvedValueOnce(
      buildOcsResponse("stefan-cruceru", "Stefan Cruceru"),
    );

    const req = mockReq("ocs-legacy-token");
    const res = mockRes();
    const { next } = await runAuth(req, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      code: "USER_NOT_PROVISIONED",
    });
    expect((req as any).user).toBeUndefined();
  });

  it("WARP-480 self-action guard fires under OCS auth (end-to-end normalization)", async () => {
    // The regression that motivated WARP-485. Pre-fix path:
    //   - OCS sets req.user.id = "stefan-cruceru" (NC username)
    //   - DELETE /api/people/u-uuid-stefan-7777 compares params.id ("u-uuid-stefan-7777")
    //     against req.user.id ("stefan-cruceru") → mismatch → guard bypassed
    //     → owner deletes themselves.
    // Post-fix: req.user.id is the local UUID, so the equality check
    // fires correctly and returns 409 SELF_ACTION_NOT_ALLOWED.
    const owner: MockUserRow = {
      id: "u-uuid-stefan-7777",
      username: "stefan-cruceru",
      displayName: "Stefan Cruceru",
      email: null,
      nextcloudUsername: "stefan-cruceru",
      role: "owner",
      isLocal: false,
      createdAt: new Date("2026-05-26T10:00:00Z"),
      updatedAt: new Date("2026-05-26T10:00:00Z"),
    };
    const coOwner: MockUserRow = {
      id: "u-uuid-romain-8888",
      username: "romain",
      displayName: "Romain",
      email: null,
      nextcloudUsername: "romain",
      role: "owner",
      isLocal: true,
      createdAt: new Date("2026-05-26T10:00:00Z"),
      updatedAt: new Date("2026-05-26T10:00:00Z"),
    };
    const prisma = buildPrismaMock([owner, coOwner]);
    _setAuthPrismaForTests(prisma);
    roleFromGroups.mockReturnValue("owner");
    (global.fetch as any).mockResolvedValueOnce(
      buildOcsResponse("stefan-cruceru", "Stefan Cruceru"),
    );

    // Mount the production authMiddleware + the real people router so
    // the test exercises the real wire path, not a synthetic stub.
    const app = express();
    app.use(express.json());
    app.use(authMiddleware);
    // WARP-455: scope-loader axis. Caller is owner (loader
    // short-circuited), so a fixed loader preserves the 409 assertion.
    app.use(
      "/api",
      createPeopleRouter(
        prisma,
        async () => new Set<ScopeName>(["exec_only"]),
      ),
    );

    const res = await request(app)
      .delete("/api/people/u-uuid-stefan-7777")
      .set("Authorization", "Bearer ocs-legacy-token");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

});
