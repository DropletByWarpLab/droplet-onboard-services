/**
 * WARP-230 — admin routes for device identity.
 *
 *   GET  /api/admin/device-identity/status
 *   POST /api/admin/device-identity/reseal
 *
 * Both require admin role. Reseal additionally requires recent MFA
 * (re-auth within DEFAULT_MFA_WINDOW_SEC = 60s).
 *
 * Errors:
 *   401 auth_required          — no req.user
 *   401 mfa_required / stale   — reseal without recent MFA
 *   403 admin_required         — non-admin user
 *   503 device_identity_svc_unreachable — sidecar gRPC error
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";

import { createRequireRecentMfa } from "../middleware/require-recent-mfa.js";
import type { DeviceIdentityClient } from "../services/device-identity.client.js";

// Roles allowed to read status + initiate reseal. "owner" is the
// canonical top-level role in this codebase (see jwt.service Role type);
// "admin" is the spec-mandated role. We accept both so the spec's
// terminology stays intact and the codebase's existing owner accounts
// can use the surface without a role rename.
const ADMIN_ROLES = new Set(["admin", "owner"]);

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { user?: { role?: string } }).user;
  if (!user) {
    res.status(401).json({ error: "auth_required" });
    return;
  }
  if (!user.role || !ADMIN_ROLES.has(user.role)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  next();
}

// Single-use nonce minted server-side per reseal request. The sidecar
// only accepts nonces it minted itself via issue_reseal_nonce(); the
// orchestrator-side counterpart here is the operator-auth marker the
// admin presents inside the trust boundary. Real cryptographic nonce
// minting moves into the sidecar in the follow-up WARP-238 wiring.
function mintOperatorNonce(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export function createAdminDeviceIdentityRouter(
  client: DeviceIdentityClient,
): Router {
  const router = Router();
  const requireMfa = createRequireRecentMfa();

  router.get(
    "/admin/device-identity/status",
    requireAdmin,
    async (_req, res) => {
      try {
        const status = await client.getDeviceIdentityStatus();
        res.json(status);
      } catch (err) {
        res.status(503).json({
          error: "device_identity_svc_unreachable",
          message: (err as Error).message,
        });
      }
    },
  );

  router.post(
    "/admin/device-identity/reseal",
    requireAdmin,
    requireMfa,
    async (_req, res) => {
      try {
        const nonce = mintOperatorNonce();
        const result = await client.requestReseal(nonce);
        res.json(result);
      } catch (err) {
        res.status(503).json({
          error: "device_identity_svc_unreachable",
          message: (err as Error).message,
        });
      }
    },
  );

  return router;
}
