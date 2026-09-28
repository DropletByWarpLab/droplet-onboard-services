/**
 * WARP-3193 SEC-AUTH-9 — step-up before enrolling a new credential.
 *
 * TOTP enroll/verify and passkey registration needed only a session, so a
 * hijacked session could register its own passkey and keep access (a
 * password change does not remove passkeys). This gate makes the caller
 * re-prove who they are first:
 *
 *   - a CONFIRMED TOTP factor (explicit `confirmedAt`) → the existing
 *     require-recent-mfa gate (WARP-230), 5-minute window: sign in again
 *     with password + code.
 *   - no second factor yet → `currentPassword` in the body, verified against
 *     the row and throttled by the SAME per-user counter as
 *     POST /auth/change-password, so the two cannot be alternated.
 *   - no usable local password (an SSO/SCIM-provisioned account, whose
 *     credential lives at the IdP) and no TOTP → passes: there is nothing
 *     local to re-prove, and refusing would lock the account out of adding
 *     any factor at all. Residual, called out in the WARP-3193 handoff.
 */
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { createRequireRecentMfa } from "./require-recent-mfa.js";
import { verifyPassword } from "../services/password.service.js";
import { throttledCredentialCheck } from "../services/throttled-credential-check.js";

/** How recent the MFA stamp must be to enrol a credential. */
export const CREDENTIAL_STEP_UP_WINDOW_SEC = 300;

type StepUpPrisma = Pick<PrismaClient, "totpCredential" | "user">;

const requireRecentMfa = createRequireRecentMfa({ windowSec: CREDENTIAL_STEP_UP_WINDOW_SEC });

/**
 * Run the step-up for `req.user`. Resolves true when the caller may proceed;
 * false when a refusal has already been sent on `res`. For a route that must
 * answer something else first (TOTP enroll keeps its 409 for an enabled
 * factor); everything else mounts {@link createRequireCredentialStepUp}.
 */
export async function passCredentialStepUp(
  prisma: StepUpPrisma | undefined,
  req: Request,
  res: Response,
): Promise<boolean> {
  const userId = (req as unknown as { user?: { id?: string } }).user?.id;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  if (!prisma) {
    res.status(500).json({ error: "Step-up unavailable: database not wired" });
    return false;
  }

  const totp = await prisma.totpCredential.findUnique({ where: { userId } });
  if (totp?.confirmedAt) {
    let passed = false;
    requireRecentMfa(req, res, () => {
      passed = true;
    });
    return passed;
  }

  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, provisionSource: true },
  });
  // Same rule as auth.ts isIdpProvisioned (WARP-2858): an IdP-provisioned
  // row never uses a local password, even if a legacy hash is present.
  const idpProvisioned = row?.provisionSource === "SSO" || row?.provisionSource === "SCIM";
  if (!row?.passwordHash || idpProvisioned) return true;

  const currentPassword =
    typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  // 403, not 401: the session is valid, and the dashboard's authFetch answers
  // any 401 with a token refresh + retry.
  if (!currentPassword) {
    res.status(403).json({
      error: "Enter your current password to continue.",
      code: "STEP_UP_PASSWORD_REQUIRED",
    });
    return false;
  }
  const hash = row.passwordHash;
  const result = await throttledCredentialCheck(userId, () => verifyPassword(hash, currentPassword));
  if (result.outcome === "locked") {
    res
      .status(429)
      .set("Retry-After", String(result.retryAfterSeconds))
      .json({
        error: "Too many attempts. Try again shortly.",
        code: "TOO_MANY_ATTEMPTS",
        retryAfterSeconds: result.retryAfterSeconds,
      });
    return false;
  }
  if (result.outcome === "invalid") {
    res.status(403).json({ error: "Invalid current password", code: "INVALID_PASSWORD" });
    return false;
  }
  return true;
}

export function createRequireCredentialStepUp(
  prisma?: StepUpPrisma,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      if (await passCredentialStepUp(prisma, req, res)) next();
    } catch (err) {
      next(err);
    }
  };
}
