/**
 * WARP-3180 — POST /api/auth/step-up: re-prove the CURRENT session's owner.
 *
 * Owner-only sensitive routes (audit key rotation, WARP-3165) sit behind
 * require-recent-mfa (60 s). Until now the only way to get a fresh
 * `lastMfaAt` was a full sign-in, which mints a NEW session and accepts any
 * account's credentials — an owner who typed someone else's would silently
 * become them. This route has no user or email field: it checks the password
 * and TOTP of `req.user` and re-issues the access token for the SAME session
 * id with `lastMfaAt = now`, exactly the stamp /auth/login writes. The
 * refresh token and the session record (idle/absolute clocks) are untouched.
 *
 * Any authenticated role may step up; what a stamp unlocks is each route's
 * own business (rotate-key stays owner-only).
 *
 * Wrong-password and wrong-code attempts share the per-user counter of
 * POST /auth/change-password and the credential step-up (WARP-3193), so the
 * three cannot be alternated to multiply guesses (shared helper:
 * throttled-credential-check.ts). The password is never logged or written to
 * the audit row. A lockout is audited once, when it starts.
 *
 * Recovery codes are refused on purpose (`totp` only, `.strict()`): they are
 * a one-time way back into an account, not something to spend on a routine
 * sensitive action. An owner without their authenticator signs in again with
 * a recovery code, which stamps `lastMfaAt` too, then re-enrols TOTP.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { authRateLimit } from "../middleware/rate-limit.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken, type Role } from "../services/jwt.service.js";
import { verifyPassword } from "../services/password.service.js";
import { checkLoginSecondFactor } from "../services/login-second-factor.service.js";
import { throttledCredentialCheck } from "../services/throttled-credential-check.js";
import { recordActivity } from "../services/activity.singleton.js";
import { isBrowserRequest } from "../lib/browser-context.js";
import { listUserSessions, revokeAllSessions, idleLimitSecondsForRole, absoluteLimitSecondsForRole } from "../services/session.service.js";

const bodySchema = z
  .object({
    password: z.string().min(1).max(1024),
    totp: z.string().trim().min(1).max(16),
  })
  .strict();

const INVALID = { error: "Wrong password or code", code: "STEP_UP_INVALID" } as const;

export function createStepUpRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Self-service uses ONLY the confirmed bearer identity. The operator's
  // box-wide /auth/sessions contract is unchanged, and no sid is exposed.
  const confirmedSession = (req: Request, res: Response) => {
    const me = req.user;
    if (!me || me.role === "service" || !me.sid || req.sessionChecked !== true) {
      res.status(401).json({ error: "Sign in again", code: "SESSION_REQUIRED" });
      return null;
    }
    return me;
  };
  router.get("/auth/security", authRateLimit, async (req, res, next) => {
    const me = confirmedSession(req, res);
    if (!me) return;
    try {
      const factor = await prisma.totpCredential.findUnique({ where: { userId: me.id }, select: { confirmedAt: true } });
      res.set("Cache-Control", "no-store").json({ totpEnabled: Boolean(factor?.confirmedAt) });
    } catch (err) { next(err); }
  });
  router.get("/auth/sessions/mine", authRateLimit, async (req, res, next) => {
    const me = confirmedSession(req, res);
    if (!me) return;
    try {
      const sessions = await listUserSessions(me.id);
      res.set("Cache-Control", "no-store");
      if (sessions === null) {
        res.status(503).json({ error: "Your sessions could not be read. Try again.", code: "SESSIONS_UNAVAILABLE" });
        return;
      }
      res.json({ sessions: sessions.map((sn) => ({
        role: sn.role, createdAt: sn.createdAt, lastSeenAt: sn.lastSeenAt,
        idleDeadline: sn.lastSeenAt + idleLimitSecondsForRole(sn.role),
        absoluteDeadline: sn.createdAt + absoluteLimitSecondsForRole(sn.role),
      })) });
    } catch (err) { next(err); }
  });
  router.post("/auth/sessions/revoke-others", authRateLimit, async (req, res, next) => {
    const me = confirmedSession(req, res);
    if (!me) return;
    // No caller-selected identity/session exception: only this checked sid survives.
    if (!z.object({}).strict().safeParse(req.body ?? {}).success) {
      res.status(400).json({ error: "No identity or session fields are allowed", code: "INVALID_REQUEST" });
      return;
    }
    try {
      const revoked = await revokeAllSessions(me.id, { exceptSid: me.sid });
      await recordActivity({ kind: "auth", severity: "ok", sourceIcon: "shield-check", what: "Other sessions revoked",
        sub: `${revoked} session(s)`, refs: { outcome: "sessions_revoked", reason: "self_service", userId: me.id, revoked }, actor: { type: "user", id: me.id } });
      res.set("Cache-Control", "no-store").json({ revoked });
    } catch (err) { next(err); }
  });

  // authRateLimit (20/min/IP), like every other credential check
  // (/auth/login, /auth/change-password, /auth/totp/verify): the per-user
  // lock below fails open on a cache error, so the IP limit must be tight.
  router.post("/auth/step-up", authRateLimit, async (req, res, next) => {
    try {
      const me = req.user;
      // Fail closed: the auth middleware lets a JWT through when the session
      // store is unreachable (sessionChecked=false), so a revoked session
      // could otherwise step up. Also refuses sid-less grace tokens and
      // service / `dxt_` extension principals, which have no session.
      if (!me || me.role === "service" || !me.sid || req.sessionChecked !== true) {
        res.status(401).json({ error: "Sign in again", code: "SESSION_REQUIRED" });
        return;
      }
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Password and code are required", code: "INVALID_REQUEST" });
        return;
      }

      const audit = (outcome: "success" | "failed" | "locked") =>
        recordActivity({
          kind: "auth",
          severity: outcome === "success" ? "ok" : "warn",
          sourceIcon: outcome === "success" ? "shield-check" : "shield-alert",
          what:
            outcome === "success"
              ? "Step-up confirmed"
              : outcome === "locked"
                ? "Step-up locked out"
                : "Step-up failed",
          sub: me.username,
          // Never the password or the code.
          refs: { outcome, userId: me.id, username: me.username },
          actor: { type: "user", id: me.id },
        });

      const row = await prisma.user.findUnique({
        where: { id: me.id },
        select: { passwordHash: true, provisionSource: true, directoryStatus: true, accessRoleId: true, role: true },
      });
      if (!row || row.directoryStatus === "DEACTIVATED") {
        res.status(401).json({ error: "Sign in again", code: "SESSION_REQUIRED" });
        return;
      }
      if (row.provisionSource === "SSO" || row.provisionSource === "SCIM" || !row.passwordHash) {
        res.status(409).json({
          error: "This account has no Droplet password to confirm. Sign in again through your identity provider.",
          code: "STEP_UP_UNAVAILABLE",
        });
        return;
      }
      const totpCred = await prisma.totpCredential.findUnique({ where: { userId: me.id } });
      if (!totpCred?.confirmedAt) {
        res.status(409).json({
          error: "Turn on two-factor sign-in first, then try again.",
          code: "TOTP_NOT_ENROLLED",
        });
        return;
      }

      const hash = row.passwordHash;
      // The code is checked only after the password matches. Checking it
      // anyway would even out a ~1 ms timing difference, but it would also
      // burn the user's one-time code (acceptTotpCode claims its time step)
      // on every wrong password. Wrong guesses are counted and locked out by
      // the shared throttle either way.
      const result = await throttledCredentialCheck(
        me.id,
        async () =>
          (await verifyPassword(hash, parsed.data.password)) &&
          (await checkLoginSecondFactor(prisma, me.id, { totp: parsed.data.totp })) === "passed",
      );
      if (result.outcome === "locked") {
        // Not audited: a refused attempt while locked tests nothing, and
        // auditing each one would let a hijacked session flood the signed
        // chain. The lockout itself is audited once, below.
        res.status(429).set("Retry-After", String(result.retryAfterSeconds)).json({
          error: "Too many attempts. Try again shortly.",
          code: "TOO_MANY_ATTEMPTS",
          retryAfterSeconds: result.retryAfterSeconds,
        });
        return;
      }
      if (result.outcome === "invalid") {
        await audit(result.lockedNow ? "locked" : "failed");
        res.status(401).json(INVALID);
        return;
      }

      const lastMfaAt = new Date().toISOString();
      const accessToken = signAccessToken({
        id: me.id,
        username: me.username,
        displayName: me.displayName,
        // The row's role, as /auth/refresh does: re-minting must not extend a
        // role that changed since this token was issued.
        role: (row.role as Role | null) ?? me.role,
        lastMfaAt,
        sid: me.sid,
        accessRoleId: row.accessRoleId ?? null,
      });
      const wantBody = (req.query.return === "body" || req.query.return === "body=1") && !isBrowserRequest(req.headers);
      if (!wantBody) res.cookie(SESSION_COOKIE_NAME, accessToken, {
        httpOnly: true,
        secure: req.secure || req.headers["x-forwarded-proto"] === "https",
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
      });
      await audit("success");
      res.set("Cache-Control", "no-store").json({ ok: true, lastMfaAt, ...(wantBody ? {
        accessToken,
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
        user: { id: me.id, username: me.username, displayName: me.displayName, role: (row.role as Role | null) ?? me.role },
      } : {}) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
