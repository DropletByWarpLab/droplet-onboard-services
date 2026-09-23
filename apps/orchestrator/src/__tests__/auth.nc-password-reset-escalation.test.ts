/**
 * WARP-2573 — a Nextcloud instance admin who resets the OWNER's Nextcloud
 * password must not be able to turn that into a Droplet owner session.
 *
 * The chain this pins shut (verified on stage @ 160badfc5):
 *   1. buildNcGroups puts every owner/admin-tier user in NC's built-in
 *      `admin` group → every Droplet admin is an NC instance admin.
 *   2. An NC instance admin can set any NC user's password.
 *   3. The orchestrator's OCS fallback forwards a `basic:<b64 user:pass>`
 *      bearer to Nextcloud as HTTP Basic, resolves the local row by
 *      `nextcloudUsername`, and (WARP-1636) caps the role at the row's
 *      stored role — which for the owner IS `owner`.
 * So `Authorization: Bearer basic:<b64(owner:newpass)>` was an owner
 * session with no Droplet password and no TOTP. The fix refuses admin-tier
 * rows on that path; they sign in through /auth/login (argon2 + TOTP), SSO
 * or WebAuthn, which issue JWTs.
 *
 * Runs the REAL jwt.service (no role stubs) so the assertions are about the
 * shipped mint path.
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

const cacheGet = vi.fn().mockResolvedValue(null);
const cacheSet = vi.fn().mockResolvedValue(undefined);
const cacheDel = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...args: unknown[]) => cacheGet(...args),
  cacheSet: (...args: unknown[]) => cacheSet(...args),
  cacheDel: (...args: unknown[]) => cacheDel(...args),
}));

vi.mock("../services/auth-denylist.service.js", () => ({
  isUserDenied: vi.fn().mockResolvedValue(false),
}));

import {
  authMiddleware,
  validateTokenForWs,
  _setAuthPrismaForTests,
  SESSION_COOKIE_NAME,
} from "../middleware/auth.js";
import { signAccessToken } from "../services/jwt.service.js";

const OWNER = {
  id: "u-uuid-owner-2573",
  username: "owner",
  nextcloudUsername: "owner",
  role: "owner",
  directoryStatus: "ACTIVE",
};
const FAMILY = {
  id: "u-uuid-family-2573",
  username: "kid",
  nextcloudUsername: "kid",
  role: "family",
  directoryStatus: "ACTIVE",
};

function prismaWith(...rows: (typeof OWNER)[]) {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        if (where.nextcloudUsername !== undefined) {
          return rows.find((r) => r.nextcloudUsername === where.nextcloudUsername) ?? null;
        }
        if (where.id !== undefined) return rows.find((r) => r.id === where.id) ?? null;
        return null;
      }),
    },
  } as any;
}

/** The token the attacker holds after resetting the owner's NC password. */
const resetOwnerToken = `basic:${Buffer.from("owner:attacker-chosen-pw").toString("base64")}`;

/** Nextcloud accepts the reset password: OCS /cloud/user answers as the owner. */
function ncAcceptsAs(ncUserId: string, groups: string[]) {
  (global.fetch as any).mockImplementation(async (_url: string, init: any) => {
    // The fallback really does turn the `basic:` bearer into HTTP Basic —
    // i.e. the attacker's reset password is what authenticates here.
    expect(init.headers.Authorization).toMatch(/^Basic /);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ocs: { meta: { status: "ok" }, data: { id: ncUserId, "display-name": ncUserId, groups } },
      }),
    };
  });
}

function req(opts: { bearer?: string; cookie?: string }): Request {
  return {
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    cookies: opts.cookie ? { [SESSION_COOKIE_NAME]: opts.cookie } : {},
    path: "/api/auth/users",
    params: {},
  } as unknown as Request;
}

function res() {
  return {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    clearCookie: vi.fn(),
  } as any;
}

async function run(r: Request, s: any) {
  const next = vi.fn();
  authMiddleware(r, s, next as unknown as NextFunction);
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  return next;
}

describe("WARP-2573 — an NC-side password reset cannot yield a Droplet owner session", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    cacheGet.mockReset().mockResolvedValue(null);
    cacheSet.mockClear();
    cacheDel.mockClear();
    global.fetch = vi.fn();
    _setAuthPrismaForTests(prismaWith(OWNER, FAMILY));
  });

  afterAll(() => {
    global.fetch = realFetch;
    _setAuthPrismaForTests(null);
  });

  it("the reset owner password as a bearer → 401, no session, nothing cached", async () => {
    ncAcceptsAs("owner", ["admin", "droplet-admins", "household"]);
    const r = req({ bearer: resetOwnerToken });
    const s = res();
    const next = await run(r, s);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect((r as any).user).toBeUndefined();
    expect(s.statusCode).toBe(401);
    expect(s.body.code).toBe("NC_CREDENTIAL_ADMIN_TIER_REFUSED");
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("the same credential in the session cookie → 401 and the cookie is cleared", async () => {
    ncAcceptsAs("owner", ["admin"]);
    const r = req({ cookie: resetOwnerToken });
    const s = res();
    const next = await run(r, s);

    expect(next).not.toHaveBeenCalled();
    expect(s.statusCode).toBe(401);
    expect(s.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, { path: "/" });
  });

  it("the WebSocket upgrade path refuses it too", async () => {
    ncAcceptsAs("owner", ["admin"]);
    await expect(validateTokenForWs(resetOwnerToken)).resolves.toBeNull();
  });

  it("a warm cache entry for an owner (minted before this fix) is purged, not replayed", async () => {
    cacheGet.mockResolvedValueOnce({
      id: OWNER.id,
      username: "owner",
      displayName: "owner",
      role: "owner",
    });
    const r = req({ bearer: resetOwnerToken });
    const s = res();
    const next = await run(r, s);

    expect(next).not.toHaveBeenCalled();
    expect(s.statusCode).toBe(401);
    expect(cacheDel).toHaveBeenCalledTimes(1);
    // Refused from the store's role, without a Nextcloud round-trip.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("non-regression: a family account still authenticates on the fallback", async () => {
    ncAcceptsAs("kid", ["household"]);
    const r = req({ bearer: `basic:${Buffer.from("kid:pw").toString("base64")}` });
    const next = await run(r, res());

    expect(next).toHaveBeenCalledTimes(1);
    expect((r as any).user).toMatchObject({ id: FAMILY.id, role: "family" });
  });

  it("non-regression: the owner's own Droplet JWT (from /auth/login) is untouched", async () => {
    const jwt = signAccessToken({
      id: OWNER.id,
      username: "owner",
      displayName: "owner",
      role: "owner",
    });
    const r = req({ cookie: jwt });
    const next = await run(r, res());

    expect(next).toHaveBeenCalledTimes(1);
    expect((r as any).user).toMatchObject({ id: OWNER.id, role: "owner" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
