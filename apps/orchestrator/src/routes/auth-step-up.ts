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
 * three cannot be alternated to multiply guesses. The password is never
 * logged or written to the audit row.
 */
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken, type Role } from "../services/jwt.service.js";
import { verifyPassword } from "../services/password.service.js";
import { checkLoginSecondFactor } from "../services/login-second-factor.service.js";
import {
  checkPasswordChangeLock,
  clearPasswordChangeRateState,
  recordPasswordChangeFailure,
} from "../services/password-change-throttle.service.js";
import { recordActivity } from "../services/activity.singleton.js";

const bodySchema = z
  .object({
    password: z.string().min(1).max(1024),
    totp: z.string().trim().min(1).max(16),
  })
  .strict();

const INVALID = { error: "Wrong password or code", code: "STEP_UP_INVALID" } as const;

export function createStepUpRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post("/auth/step-up", sensitiveRateLimit, async (req, res, next) => {
    try {
      const me = req.user;
      if (!me || me.role === "service" || !me.sid) {
        // A sid-less token (legacy/grace) has no session to stamp.
        res.status(401).json({ error: "Sign in again", code: "SESSION_REQUIRED" });
        return;
      }
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Password and code are required", code: "INVALID_REQUEST" });
        return;
      }

      const lock = await checkPasswordChangeLock(me.id);
      if (lock.locked) {
        res.status(429).set("Retry-After", String(lock.retryAfterSeconds)).json({
          error: "Too many attempts. Try again shortly.",
          code: "TOO_MANY_ATTEMPTS",
          retryAfterSeconds: lock.retryAfterSeconds,
        });
        return;
      }

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

      const audit = (outcome: "success" | "failed") =>
        recordActivity({
          kind: "auth",
          severity: outcome === "success" ? "ok" : "warn",
          sourceIcon: outcome === "success" ? "shield-check" : "shield-alert",
          what: outcome === "success" ? "Step-up confirmed" : "Step-up failed",
          sub: me.username,
          refs: { outcome, userId: me.id, username: me.username },
          actor: { type: "user", id: me.id },
        });

      const passwordOk = await verifyPassword(row.passwordHash, parsed.data.password);
      // Always run the code check too when the password is right; when it is
      // wrong, don't spend the code (single-use time step).
      const codeOk =
        passwordOk &&
        (await checkLoginSecondFactor(prisma, me.id, { totp: parsed.data.totp })) === "passed";
      if (!codeOk) {
        await recordPasswordChangeFailure(me.id);
        await audit("failed");
        res.status(401).json(INVALID);
        return;
      }
      await clearPasswordChangeRateState(me.id);

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
      res.cookie(SESSION_COOKIE_NAME, accessToken, {
        httpOnly: true,
        secure: req.secure || req.headers["x-forwarded-proto"] === "https",
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
      });
      await audit("success");
      res.json({ ok: true, lastMfaAt });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
