/**
 * WARP-3630 — privileged-account two-step enrolment gate.
 *
 * With `REQUIRE_ADMIN_TWO_STEP` on, an owner or admin who has no confirmed
 * second factor (a confirmed TOTP credential or at least one passkey) may
 * reach only the sign-out / refresh / enrolment surface until they enrol; every
 * other route answers 403 `MFA_ENROLLMENT_REQUIRED`. Same shape as
 * requirePasswordChangeGate (WARP-824): mounted after authMiddleware, state
 * read fresh from the database, exact allowed paths.
 *
 * Exempt: a request with no human session (service principals, extensions)
 * and the AUTH_ENABLED=false dev principal. SSO and SCIM accounts are NOT
 * exempt: they enrol a Droplet factor like anyone else (their step-up on the
 * admin routes needs one).
 *
 * Unlike the password gate this FAILS CLOSED (503) on a database error: it is
 * a security control, not a convenience.
 */
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("admin-mfa-enrollment-gate");

/** Exact paths (no prefix match) an unenrolled admin may still call. */
const ENROLLMENT_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/refresh",
  "/api/auth/change-password",
  "/api/auth/totp/enroll",
  "/api/auth/totp/verify",
  "/api/auth/webauthn/register/options",
  "/api/auth/webauthn/register/verify",
  "/api/auth/webauthn/credentials",
]);

/**
 * Does this person have a second factor: a CONFIRMED TOTP credential (explicit
 * `confirmedAt`) or at least one passkey? Throws on a database error; callers
 * must treat that as a denial.
 */
export async function hasSecondFactor(
  prisma: Pick<PrismaClient, "totpCredential" | "webAuthnCredential">,
  userId: string,
): Promise<boolean> {
  const totp = await prisma.totpCredential.findUnique({ where: { userId } });
  if (totp?.confirmedAt) return true;
  return (await prisma.webAuthnCredential.count({ where: { userId } })) > 0;
}

export function requireAdminMfaEnrollmentGate(
  prisma: Pick<PrismaClient, "totpCredential" | "webAuthnCredential">,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const user = req.user;
    if (
      !config.REQUIRE_ADMIN_TWO_STEP ||
      !config.AUTH_ENABLED ||
      !user ||
      (user.role !== "owner" && user.role !== "admin")
    ) {
      return next();
    }
    const path = req.path.replace(/\/+$/, "") || "/";
    if (ENROLLMENT_ALLOWED_PATHS.has(path)) return next();

    try {
      if (await hasSecondFactor(prisma, user.id)) return next();

      res.status(403).json({
        error: "Set up two-step sign-in to continue.",
        code: "MFA_ENROLLMENT_REQUIRED",
      });
    } catch (err) {
      logger.error({ err, userId: user.id }, "admin MFA enrolment gate: lookup failed; refusing (fail-closed)");
      res.status(503).json({ error: "Try again shortly.", code: "MFA_GATE_UNAVAILABLE" });
    }
  };
}
