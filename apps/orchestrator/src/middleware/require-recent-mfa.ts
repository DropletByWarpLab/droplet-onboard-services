/**
 * WARP-230 — require-recent-mfa middleware.
 *
 * Asserts the authenticated user completed an MFA challenge within the
 * given window (default 60s). Used by sensitive admin actions (reseal,
 * future key rotation, etc.) where simple session-cookie presence isn't
 * enough — the operator must have just re-proven identity.
 *
 * The user's most-recent MFA timestamp lives on `req.user.lastMfaAt`.
 * The auth middleware populates it from the access token's claims (TBD
 * — TOTP/WebAuthn stamping follows in the matching MFA ticket
 * WARP-238). Until then, the field is null for every user and the
 * middleware will 401 with `mfa_required`, which is the correct
 * fail-closed behavior for a sealed-identity reseal route.
 *
 * Window is a named constant (no guessing — project rule).
 */
import type { Request, Response, NextFunction } from "express";

export const DEFAULT_MFA_WINDOW_SEC = 60;

export interface RequireRecentMfaOptions {
  /** Window in seconds. Default 60. */
  windowSec?: number;
}

type UserWithMfa = { lastMfaAt?: Date | string | null };

export function createRequireRecentMfa(
  opts: RequireRecentMfaOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const windowSec = opts.windowSec ?? DEFAULT_MFA_WINDOW_SEC;
  const windowMs = windowSec * 1000;
  return (req, res, next) => {
    const user = (req as unknown as { user?: UserWithMfa }).user;
    if (!user) {
      res.status(401).json({ error: "auth_required" });
      return;
    }
    const raw = user.lastMfaAt;
    const last = raw ? new Date(raw) : null;
    if (!last || Number.isNaN(last.getTime())) {
      res.status(401).json({
        error: "mfa_required",
        message: "recent MFA re-auth required",
      });
      return;
    }
    const age = Date.now() - last.getTime();
    if (age > windowMs) {
      res.status(401).json({
        error: "mfa_stale",
        message: `MFA re-auth older than ${windowSec}s`,
      });
      return;
    }
    next();
  };
}
