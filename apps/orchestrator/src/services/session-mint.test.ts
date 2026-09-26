/**
 * issueSessionTokens / setSessionCookies — the ONE session mint shared by
 * password login (auth.ts), passkey login (webauthn.ts), SSO (sso.ts browser
 * callback) and the native SSO handoff (sso.ts native/token).
 *
 * Contract (unchanged from the three hand-rolled copies it replaces):
 *   - WARP-247: the server-side session record is created FIRST and its `sid`
 *     rides in both tokens.
 *   - WARP-116: the refresh token is indexed for the admin revoke sweep.
 *   - WARP-1582: `accessRoleId` is three-state — `null` is emitted, an absent
 *     value keeps the claim absent.
 *   - PR #375: `lastMfaAt` is stamped only when supplied.
 *   - Expiries are epoch SECONDS (the `?return=body` wire shape).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../config.js", () => ({
  config: { JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa" },
}));

const createSession = vi.fn(async (_u: { id: string; role: string }) => ({
  sid: "sid-mint-7",
  evictedSids: [] as string[],
}));
vi.mock("./session.service.js", () => ({
  createSession: (...a: unknown[]) => createSession(...(a as [{ id: string; role: string }])),
}));

const registerRefreshSession = vi.fn().mockResolvedValue(undefined);
vi.mock("./jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("./jwt.service.js")>("./jwt.service.js");
  return { ...actual, registerRefreshSession: (...a: unknown[]) => registerRefreshSession(...a) };
});

vi.mock("../middleware/auth.js", () => ({
  SESSION_COOKIE_NAME: "droplet_session",
  REFRESH_COOKIE_NAME: "droplet_refresh",
}));

import { issueSessionTokens, sessionTokenBody, setSessionCookies } from "./session-mint.js";
import {
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./jwt.service.js";
import jwt from "jsonwebtoken";

const alice = { id: "u-alice", username: "alice", displayName: "Alice", role: "family" as const };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("issueSessionTokens", () => {
  it("creates the session record first and threads its sid into both tokens", async () => {
    const minted = await issueSessionTokens({ ...alice, accessRoleId: null });

    expect(createSession).toHaveBeenCalledWith({ id: "u-alice", role: "family" });
    expect(minted.sid).toBe("sid-mint-7");
    const access = verifyAccessToken(minted.accessToken);
    expect(access).toMatchObject({ sub: "u-alice", username: "alice", role: "family", sid: "sid-mint-7" });
    const refresh = jwt.decode(minted.refreshToken) as Record<string, unknown>;
    expect(refresh).toMatchObject({ sub: "u-alice", type: "refresh", sid: "sid-mint-7" });
    expect(registerRefreshSession).toHaveBeenCalledWith("u-alice", minted.refreshToken);
  });

  it("returns epoch-second expiries matching the token TTLs", async () => {
    const before = Math.floor(Date.now() / 1000);
    const minted = await issueSessionTokens(alice);
    const after = Math.floor(Date.now() / 1000);
    expect(minted.accessTokenExpiresAt).toBeGreaterThanOrEqual(before + ACCESS_TOKEN_TTL_SECONDS);
    expect(minted.accessTokenExpiresAt).toBeLessThanOrEqual(after + ACCESS_TOKEN_TTL_SECONDS);
    expect(minted.refreshTokenExpiresAt).toBeGreaterThanOrEqual(before + REFRESH_TOKEN_TTL_SECONDS);
    expect(minted.refreshTokenExpiresAt).toBeLessThanOrEqual(after + REFRESH_TOKEN_TTL_SECONDS);
  });

  it("keeps accessRoleId three-state: null is emitted, absent stays absent", async () => {
    const withNull = verifyAccessToken((await issueSessionTokens({ ...alice, accessRoleId: null })).accessToken);
    expect(withNull).toHaveProperty("accessRoleId", null);
    const withRole = verifyAccessToken(
      (await issueSessionTokens({ ...alice, accessRoleId: "role-7" })).accessToken,
    );
    expect(withRole?.accessRoleId).toBe("role-7");
    const absent = jwt.decode((await issueSessionTokens(alice)).accessToken) as Record<string, unknown>;
    expect("accessRoleId" in absent).toBe(false);
  });

  it("stamps lastMfaAt only when supplied", async () => {
    const stamped = await issueSessionTokens(alice, { lastMfaAt: "2026-09-25T12:00:00.000Z" });
    expect(verifyAccessToken(stamped.accessToken)?.lastMfaAt).toBe("2026-09-25T12:00:00.000Z");
    const plain = await issueSessionTokens(alice);
    expect(verifyAccessToken(plain.accessToken)?.lastMfaAt).toBeUndefined();
  });
});

describe("sessionTokenBody", () => {
  it("is exactly the four ?return=body token fields", async () => {
    const minted = await issueSessionTokens(alice);
    expect(sessionTokenBody(minted)).toEqual({
      accessToken: minted.accessToken,
      refreshToken: minted.refreshToken,
      accessTokenExpiresAt: minted.accessTokenExpiresAt,
      refreshTokenExpiresAt: minted.refreshTokenExpiresAt,
    });
  });
});

describe("setSessionCookies", () => {
  function fakeRes() {
    const cookie = vi.fn();
    return { res: { cookie } as unknown as Response, cookie };
  }

  it.each([
    ["https via the gateway", { secure: false, headers: { "x-forwarded-proto": "https" } }, true],
    ["direct TLS", { secure: true, headers: {} }, true],
    ["plain http", { secure: false, headers: {} }, false],
  ])("sets the access + refresh cookies (%s)", (_label, reqShape, secure) => {
    const { res, cookie } = fakeRes();
    setSessionCookies(reqShape as unknown as Request, res, { accessToken: "a", refreshToken: "r" });
    expect(cookie).toHaveBeenCalledTimes(2);
    expect(cookie).toHaveBeenNthCalledWith(1, "droplet_session", "a", {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
    });
    expect(cookie).toHaveBeenNthCalledWith(2, "droplet_refresh", "r", {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/api/auth",
      maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
    });
  });
});
