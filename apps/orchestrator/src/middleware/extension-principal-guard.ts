/**
 * WARP-2900 (ADR-056 slice H3) — what an extension's bearer can reach: two
 * routes, and nothing else on the box.
 *
 * A promoted extension calls back with its own `dxt_` bearer, which
 * `authMiddleware` resolves to the `_service:ext:<slug>` principal (role
 * `service`). Service principals were built for first-party containers,
 * and many authenticated routes carry no `requireRole` at all (GET
 * /api/storage is one): any principal reaches them. An extension is code
 * the owner's assistant wrote, so "any authenticated principal" is exactly
 * the reach it must not inherit (the WARP-2180 laundering rule). This guard,
 * mounted globally right after `authMiddleware`, refuses an extension
 * principal on every route that is not in {@link EXTENSION_PRINCIPAL_ROUTES}
 * — before any router sees the request.
 *
 * Exact `METHOD path` match, no prefixes, no normalisation: a path Express
 * would still route (a trailing slash, other letter case) is refused here,
 * which fails closed. The two routes themselves re-check the principal and
 * resolve the installing owner (routes/extensions.ts).
 */
import type { NextFunction, Request, Response } from "express";
import { recordAccessDenied, type AuthUser } from "./auth.js";
import { EXTENSION_PRINCIPAL_PREFIX } from "../services/extension-token.js";

/** The only requests an extension principal may make. */
export const EXTENSION_PRINCIPAL_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/extensions/self",
  "POST /api/extensions/self/call",
]);

/** An extension's call-back principal, by either of its two marks. */
export function isExtensionPrincipal(user: AuthUser | undefined): boolean {
  if (!user) return false;
  return user.extensionId !== undefined || user.id.startsWith(EXTENSION_PRINCIPAL_PREFIX);
}

export function extensionPrincipalGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isExtensionPrincipal(req.user)) {
    next();
    return;
  }
  if (EXTENSION_PRINCIPAL_ROUTES.has(`${req.method} ${req.path}`)) {
    next();
    return;
  }
  recordAccessDenied(req, "extension-principal-route");
  res.status(403).json({ error: "Forbidden: an extension may call only its own routes" });
}
