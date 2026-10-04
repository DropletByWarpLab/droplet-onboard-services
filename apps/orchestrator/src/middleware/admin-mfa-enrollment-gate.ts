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
 * Exempt: a request with no human session (service principals, extensions),
 * the AUTH_ENABLED=false dev principal, and SSO / SCIM-provisioned accounts,
 * whose second factor belongs to the identity provider.
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

export function requireAdminMfaEnrollmentGate(
  prisma: Pick<PrismaClient, "user" | "totpCredential" | "webAuthnCredential">,
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
      const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { provisionSource: true },
      });
      // No directory row (nothing to enrol) or an IdP-owned account.
      if (!row || row.provisionSource === "SSO" || row.provisionSource === "SCIM") return next();

      const totp = await prisma.totpCredential.findUnique({ where: { userId: user.id } });
      if (totp?.confirmedAt) return next();
      if ((await prisma.webAuthnCredential.count({ where: { userId: user.id } })) > 0) return next();

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
