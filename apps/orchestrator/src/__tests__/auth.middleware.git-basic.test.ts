/**
 * authMiddleware — the git CLI's Basic credential on `/api/git/*` (WARP-2896).
 *
 * `git clone http://<box>/git/<ws>.git` speaks HTTP Basic only. On the
 * `/api/git/` prefix the middleware reads the second half of a Basic
 * credential as the session JWT and verifies it exactly as a Bearer would
 * be. Everywhere else a Basic header stays what it always was — no
 * credential — and on the git prefix a missing credential answers with the
 * `WWW-Authenticate: Basic` challenge the CLI needs before it asks.
 *
 * Same harness as auth.middleware.display-token.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
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

const verifyAccessToken = vi.fn().mockReturnValue(null);
vi.mock("../services/jwt.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/jwt.service.js")>();
  return {
    ...original,
    verifyAccessToken: (...args: unknown[]) => verifyAccessToken(...args),
  };
});

const fetchSpy = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
vi.stubGlobal("fetch", fetchSpy);

import { authMiddleware } from "../middleware/auth.js";

interface FakeReq {
  headers: Record<string, string | undefined>;
  cookies: Record<string, string | undefined>;
  path: string;
  user?: unknown;
}

function buildReq(overrides: Partial<FakeReq> = {}): FakeReq {
  return { headers: {}, cookies: {}, path: "/api/git/ws-a.git/info/refs", ...overrides };
}

function buildRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    clearCookie: vi.fn(),
  };
  return res;
}

/** The JWT path finishes in an async IIFE (denylist lookup); let it settle. */
const flush = () => new Promise((r) => setTimeout(r, 10));
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const JWT_USER = { sub: "u-owner", username: "romain", displayName: "Romain", role: "owner", sid: undefined };

beforeEach(() => {
  verifyAccessToken.mockReset().mockReturnValue(null);
  cacheGet.mockClear();
});

describe("authMiddleware — Basic on /api/git/ carries the session JWT in its second slot", () => {
  it("verifies the password as a JWT and sets the user", async () => {
    verifyAccessToken.mockImplementation((token: string) => (token === "jwt-abc" ? JWT_USER : null));
    const req = buildReq({ headers: { authorization: basic("romain", "jwt-abc") } }) as unknown as Request;
    const res = buildRes();
    const next = vi.fn() as unknown as NextFunction;
    authMiddleware(req, res as unknown as Response, next);
    await flush();
    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyAccessToken).toHaveBeenCalledWith("jwt-abc");
    expect((req as unknown as FakeReq).user).toMatchObject({ id: "u-owner", username: "romain", role: "owner" });
  });

  it("the first half is ignored — only the second slot is a credential", async () => {
    verifyAccessToken.mockImplementation((token: string) => (token === "jwt-abc" ? JWT_USER : null));
    const req = buildReq({ headers: { authorization: basic("whoever", "jwt-abc") } }) as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    authMiddleware(req, buildRes() as unknown as Response, next);
    await flush();
    expect((req as unknown as FakeReq).user).toMatchObject({ username: "romain" });
  });

  it("a Basic header OFF the git prefix is not a credential: 401, no verify", async () => {
    // MUTATION: drop the `req.path.startsWith("/api/git/")` guard in
    // auth.ts and this passes a JWT in through Basic on every route.
    verifyAccessToken.mockReturnValue(JWT_USER);
    const req = buildReq({ path: "/api/files", headers: { authorization: basic("romain", "jwt-abc") } }) as unknown as Request;
    const res = buildRes();
    const next = vi.fn() as unknown as NextFunction;
    authMiddleware(req, res as unknown as Response, next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
  });

  it("no credential on the git prefix: 401 WITH the Basic challenge; elsewhere 401 without it", async () => {
    const onGit = buildReq() as unknown as Request;
    const gitRes = buildRes();
    authMiddleware(onGit, gitRes as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(gitRes.statusCode).toBe(401);
    expect(gitRes.headers["WWW-Authenticate"]).toBe('Basic realm="Droplet workshop"');

    const elsewhere = buildReq({ path: "/api/files" }) as unknown as Request;
    const otherRes = buildRes();
    authMiddleware(elsewhere, otherRes as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(otherRes.statusCode).toBe(401);
    expect(otherRes.headers["WWW-Authenticate"]).toBeUndefined();
  });

  it("a malformed Basic value (no colon, empty second slot, bad base64) is no credential", async () => {
    for (const value of [
      `Basic ${Buffer.from("nocolon").toString("base64")}`,
      basic("romain", ""),
      "Basic !!!not-base64!!!",
      "Basic ",
    ]) {
      const req = buildReq({ headers: { authorization: value } }) as unknown as Request;
      const res = buildRes();
      authMiddleware(req, res as unknown as Response, vi.fn() as unknown as NextFunction);
      await Promise.resolve();
      expect(res.statusCode, value).toBe(401);
    }
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});
