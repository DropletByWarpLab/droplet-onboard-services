/**
 * WARP-1636 — the OCS auth fallback mints at the STORED Droplet role,
 * capped. Wired half.
 *
 * `jwt.nc-session-role.test.ts` pins the rail as a pure function. This
 * file pins that the rail is actually ON the session-mint path — the
 * failure mode a parallel guard would leave wide open, and the reason
 * the cap lives inside `resolveNcSessionRole` rather than being spelled
 * out at the call site.
 *
 * Deliberately does NOT mock `../services/jwt.service.js`. The sibling
 * OCS suites (`auth.req-user-id.test.ts`, `middleware/auth.test.ts`)
 * stub `roleFromGroups` to a fixed string, which means they would stay
 * green with the cap deleted. Here the real module runs, so the assertion
 * below is about the shipped code path end to end: OCS says "this person
 * is in Nextcloud's built-in `admin` group", the local row says
 * `role="admin"`, and the session must come back `admin`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request, NextFunction } from "express";

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

// Force a cache miss so every test exercises the live OCS validation path
// (a warm entry would replay an already-normalised AuthUser and prove
// nothing about the mint).
const cacheGet = vi.fn().mockResolvedValue(null);
const cacheSet = vi.fn().mockResolvedValue(undefined);
const cacheDel = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...args: unknown[]) => cacheGet(...args),
  cacheSet: (...args: unknown[]) => cacheSet(...args),
  cacheDel: (...args: unknown[]) => cacheDel(...args),
}));

import { authMiddleware, _setAuthPrismaForTests } from "../middleware/auth.js";

interface StoredUser {
  id: string;
  username: string;
  nextcloudUsername: string;
  role: string;
  directoryStatus: string;
}

function buildPrismaMock(row: StoredUser) {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        if (where.nextcloudUsername !== undefined) {
          return where.nextcloudUsername === row.nextcloudUsername ? row : null;
        }
        if (where.id !== undefined) {
          return where.id === row.id ? row : null;
        }
        return null;
      }),
    },
  } as any;
}

/** An OCS /cloud/user answer that reports the given group memberships. */
function ocsUserWithGroups(ncUserId: string, groups: string[]) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ocs: {
        meta: { status: "ok" },
        data: { id: ncUserId, "display-name": ncUserId, groups },
      },
    }),
  } as unknown as Response;
}

function mockReq(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    path: "/api/files/spaces",
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

async function runAuth(req: Request, res: any) {
  const next = vi.fn();
  authMiddleware(req, res, next as unknown as NextFunction);
  // Drain validateNextcloudTokenDetailed's promise chain.
  await new Promise((r) => setImmediate(r));
  return { next };
}

describe("WARP-1636 — OCS fallback caps the session role at the stored Droplet role", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    cacheGet.mockClear().mockResolvedValue(null);
    cacheSet.mockClear();
    cacheDel.mockClear();
    global.fetch = vi.fn();
    _setAuthPrismaForTests(null);
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it("a narrowed admin in Nextcloud's built-in `admin` group gets an `admin` session, not `owner`", async () => {
    // The contractor from the ticket: an operator built an Admin-based
    // custom role granting cameras + smart_home and deliberately NOT
    // files, and assigned it at role=admin. buildNcGroups put them in
    // NC's `admin` group, so they are an instance administrator — but
    // that must not buy them an orchestrator session at the one tier
    // ADR-032 §3 says bypasses layer 2.
    const stored: StoredUser = {
      id: "u-uuid-contractor-0001",
      username: "facilities-contractor",
      nextcloudUsername: "facilities-contractor",
      role: "admin",
      directoryStatus: "ACTIVE",
    };
    _setAuthPrismaForTests(buildPrismaMock(stored));
    (global.fetch as any).mockResolvedValueOnce(
      ocsUserWithGroups("facilities-contractor", ["admin", "droplet-admins", "household"]),
    );

    const req = mockReq("nc-app-password");
    const res = mockRes();
    const { next } = await runAuth(req, res);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    const user = (req as any).user;
    expect(user.id).toBe("u-uuid-contractor-0001");
    expect(user.role).toBe("admin");
    // The regression this whole ticket is about.
    expect(user.role).not.toBe("owner");
  });

  it("caches the CAPPED role, so a warm token cannot replay the escalation", async () => {
    // The cache stores fully-normalised AuthUser rows and short-circuits
    // the mint on a hit. Writing the uncapped role here would hand the
    // escalation back for TOKEN_CACHE_TTL on every subsequent request.
    const stored: StoredUser = {
      id: "u-uuid-contractor-0002",
      username: "narrowed",
      nextcloudUsername: "narrowed",
      role: "admin",
      directoryStatus: "ACTIVE",
    };
    _setAuthPrismaForTests(buildPrismaMock(stored));
    (global.fetch as any).mockResolvedValueOnce(
      ocsUserWithGroups("narrowed", ["admin"]),
    );

    await runAuth(mockReq("nc-app-password-2"), mockRes());

    expect(cacheSet).toHaveBeenCalledTimes(1);
    const cachedUser = cacheSet.mock.calls[0][1] as { role: string };
    expect(cachedUser.role).toBe("admin");
  });

  it("a family user drifted into the NC admin group gets a `family` session", async () => {
    const stored: StoredUser = {
      id: "u-uuid-family-0003",
      username: "teenager",
      nextcloudUsername: "teenager",
      role: "family",
      directoryStatus: "ACTIVE",
    };
    _setAuthPrismaForTests(buildPrismaMock(stored));
    (global.fetch as any).mockResolvedValueOnce(
      ocsUserWithGroups("teenager", ["admin", "household"]),
    );

    const req = mockReq("nc-app-password-3");
    const { next } = await runAuth(req, mockRes());

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).user.role).toBe("family");
  });

  it("a real owner still gets an `owner` session (the cap removes authority, never adds)", async () => {
    const stored: StoredUser = {
      id: "u-uuid-owner-0004",
      username: "stefan-cruceru",
      nextcloudUsername: "stefan-cruceru",
      role: "owner",
      directoryStatus: "ACTIVE",
    };
    _setAuthPrismaForTests(buildPrismaMock(stored));
    (global.fetch as any).mockResolvedValueOnce(
      ocsUserWithGroups("stefan-cruceru", ["admin", "droplet-admins", "household"]),
    );

    const req = mockReq("nc-app-password-4");
    const { next } = await runAuth(req, mockRes());

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).user.role).toBe("owner");
  });
});
