/**
 * WARP-2573 + WARP-2994 — a Nextcloud credential never opens a Droplet
 * session, for any role.
 *
 * WARP-2573: an NC instance admin who reset the OWNER's NC password could
 * present `Bearer basic:<b64 owner:newpass>`; the OCS fallback forwarded it
 * to Nextcloud as HTTP Basic and minted an owner session. WARP-2573 refused
 * admin-tier rows on that path.
 *
 * WARP-2994: the same fallback let every other role skip Droplet TOTP and
 * the /auth/login throttle with a password or an NC app-password. No shipped
 * client used it, so the fallback is gone: only a Droplet JWT (minted by
 * /auth/login, SSO or WebAuthn) or a SERVICE_TOKEN_* principal gets in, and
 * Nextcloud is never consulted to decide who a caller is.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "voice-service-token-aaaaaaaaaaaaaaaa",
    SERVICE_TOKEN_MCP: "",
    JWT_SECRET: "test-secret-at-least-32-chars-long-aaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/auth-denylist.service.js", () => ({
  isUserDenied: vi.fn().mockResolvedValue(false),
}));

import {
  authMiddleware,
  validateTokenForWs,
  SESSION_COOKIE_NAME,
} from "../middleware/auth.js";
import { signAccessToken } from "../services/jwt.service.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** Every shape a Nextcloud credential used to take on the fallback. */
const NC_CREDENTIALS: Record<string, string> = {
  // WARP-2573: the owner's NC password after an NC admin reset it.
  "reset owner password (basic:)": `basic:${b64("owner:attacker-chosen-pw")}`,
  // WARP-2994: a family member's password — TOTP and the throttle skipped.
  "family password (basic:)": `basic:${b64("kid:their-password")}`,
  // WARP-2994: an NC app-password minted from that password, or lifted from
  // a paired phone's WebDAV config — refusing only `basic:` would miss it.
  "NC app-password": "aBcDe-FgHiJ-kLmNo-PqRsT-uVwXy",
  // AUTH_MODE=oauth2's cookie value: an NC OAuth access token.
  "NC OAuth access token": "nc-oauth-access-token-0123456789abcdef",
};

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

describe("a Nextcloud credential never opens a Droplet session (WARP-2573, WARP-2994)", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    // If anything still asked Nextcloud who the caller is, it would get a
    // cheerful "yes, that's the owner, in the admin group".
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ocs: {
          meta: { status: "ok" },
          data: { id: "owner", "display-name": "owner", groups: ["admin"] },
        },
      }),
    })) as any;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  for (const [label, token] of Object.entries(NC_CREDENTIALS)) {
    it(`${label} as a bearer → 401, no session, Nextcloud never asked`, async () => {
      const r = req({ bearer: token });
      const s = res();
      const next = await run(r, s);

      expect(next).not.toHaveBeenCalled();
      expect((r as any).user).toBeUndefined();
      expect(s.statusCode).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it(`${label} in the session cookie → 401 and the cookie is cleared`, async () => {
      const r = req({ cookie: token });
      const s = res();
      const next = await run(r, s);

      expect(next).not.toHaveBeenCalled();
      expect(s.statusCode).toBe(401);
      expect(s.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, { path: "/" });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it(`${label} on the WebSocket upgrade → refused`, async () => {
      await expect(validateTokenForWs(token)).resolves.toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  }

  it("non-regression: a Droplet JWT (from /auth/login) still authenticates", async () => {
    const jwt = signAccessToken({
      id: "u-uuid-owner",
      username: "owner",
      displayName: "owner",
      role: "owner",
    });
    const r = req({ cookie: jwt });
    const next = await run(r, res());

    expect(next).toHaveBeenCalledTimes(1);
    expect((r as any).user).toMatchObject({ id: "u-uuid-owner", role: "owner" });
    await expect(validateTokenForWs(jwt)).resolves.toMatchObject({ role: "owner" });
  });

  it("non-regression: a service principal bearer still authenticates", async () => {
    const r = req({ bearer: "voice-service-token-aaaaaaaaaaaaaaaa" });
    const next = await run(r, res());

    expect(next).toHaveBeenCalledTimes(1);
    expect((r as any).user).toMatchObject({ role: "service" });
  });
});
