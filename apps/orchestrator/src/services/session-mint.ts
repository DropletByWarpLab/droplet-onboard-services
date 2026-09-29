/**
 * The one session mint shared by every sign-in path: password login
 * (routes/auth.ts), passkey login (routes/webauthn.ts) and the SSO callback
 * (routes/sso.ts).
 *
 *   - WARP-247: the server-side session record is created FIRST (cap +
 *     idle/absolute clocks) and its `sid` rides in both tokens.
 *   - WARP-116: the refresh token is indexed so an admin revoke sweep reaches
 *     every live session of the user.
 *   - WARP-1582: `accessRoleId` is passed through as given: `null` ("no
 *     custom role") is emitted, an absent value keeps the claim absent.
 *   - PR #375: `lastMfaAt` is stamped only when the caller supplies it.
 *
 * Expiries are epoch SECONDS, the `?return=body` wire shape.
 */
import type { Request, Response } from "express";

import {
  signAccessToken,
  signRefreshToken,
  registerRefreshSession,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type Role,
} from "./jwt.service.js";
import { createSession } from "./session.service.js";
import { SESSION_COOKIE_NAME, REFRESH_COOKIE_NAME } from "../middleware/auth.js";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** WARP-1582 — the User row's custom access role, `null` for none. */
  accessRoleId?: string | null;
}

export interface IssueSessionOptions {
  /** ISO time a second factor (TOTP, recovery code, passkey UV) was satisfied. */
  lastMfaAt?: string;
}

export interface IssuedSession {
  sid: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  accessTokenExpiresAt: number;
  /** Epoch seconds. */
  refreshTokenExpiresAt: number;
}

/** Create the session record, sign both tokens and index the refresh token. */
export async function issueSessionTokens(
  user: SessionUser,
  opts: IssueSessionOptions = {},
): Promise<IssuedSession> {
  const { sid } = await createSession({ id: user.id, role: user.role });
  const accessToken = signAccessToken({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    lastMfaAt: opts.lastMfaAt,
    sid,
    ...(user.accessRoleId !== undefined ? { accessRoleId: user.accessRoleId } : {}),
  });
  const refreshToken = signRefreshToken({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    sid,
  });
  await registerRefreshSession(user.id, refreshToken);
  const now = Math.floor(Date.now() / 1000);
  return {
    sid,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenExpiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
  };
}

/** The four token fields of the `?return=body` response, in wire order. */
export function sessionTokenBody(minted: IssuedSession): {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
} {
  return {
    accessToken: minted.accessToken,
    refreshToken: minted.refreshToken,
    accessTokenExpiresAt: minted.accessTokenExpiresAt,
    refreshTokenExpiresAt: minted.refreshTokenExpiresAt,
  };
}

/** Set the httpOnly access + refresh cookies a browser session runs on. */
export function setSessionCookies(
  req: Request,
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
): void {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie(SESSION_COOKIE_NAME, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/api/auth",
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}
