/**
 * WARP-455 — requireScope(resource, loadUserScopes) middleware.
 *
 * Second RBAC axis on top of WARP-171's `requireRole`. Where
 * `requireRole` gates by *capability bucket* ("admin actions",
 * "household reads"), `requireScope` gates by *information bucket*
 * ("team", "exec_only", "finance", "engineering", "ops", "private").
 * The two are orthogonal — `requireRole(...)` first, `requireScope(...)`
 * second, both on the same route.
 *
 * Truth table (locked by __tests__/require-scope.middleware.test.ts):
 *
 *     role        |  binding for `resource`?  |  result
 *     ────────────┼───────────────────────────┼──────────────
 *     owner       |  any                      |  pass
 *     admin       |  any                      |  pass
 *     family      |  yes                      |  pass
 *     family      |  no                       |  403
 *     guest       |  yes                      |  pass
 *     guest       |  no                       |  403
 *     service     |  any                      |  403  (read-only)
 *     missing     |  —                        |  403
 *     unknown     |  —                        |  403
 *
 * The loader is injected so route mounts can pass a Prisma-backed
 * fetcher and unit tests can pass a fixed Set without a DB. Production
 * wiring lives in `services/scope-loader.service.ts` (singleton bound
 * to the orchestrator's PrismaClient).
 *
 * Fail-closed semantics mirror `requireRole`:
 *   - 403 on absent/unknown role (defense in depth — authMiddleware
 *     should have already issued 401)
 *   - 403 on missing binding
 *   - 500 on loader exception (a DB hiccup is operational, NOT an
 *     auth-fault — same posture as the OCS-unreachable path in
 *     auth.ts → 500)
 */
import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("require-scope");

/**
 * Canonical scope set — must mirror the Prisma `Scope` enum
 * (apps/orchestrator/prisma/schema.prisma) exactly. Duplicated as a TS
 * literal so the middleware compiles standalone without pulling the
 * Prisma client into the auth hot path.
 */
export type ScopeName =
  | "team"
  | "exec_only"
  | "finance"
  | "engineering"
  | "ops"
  | "private";

/**
 * Role values that always pass requireScope without a DB round-trip.
 * Owners and admins hold every scope by definition (ADR-004 §3 — the
 * admin-tier passes every write). The Set lets the guard short-circuit
 * before invoking the loader.
 */
const ADMIN_TIER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * Role values that participate in scope checks. `service` is
 * deliberately absent — service principals are read-only and never
 * pass a scope-guarded route.
 */
const SCOPED_HUMAN_ROLES: ReadonlySet<string> = new Set([
  "family",
  "guest",
]);

/**
 * Loader the middleware delegates to. Returns the set of scopes the
 * given user holds. The route mount provides the implementation
 * (Prisma-backed in production; an injected Set in tests).
 */
export type ScopeLoader = (userId: string) => Promise<Set<ScopeName>>;

/**
 * Build a middleware that gates `resource` by scope. See module
 * comment for the truth table.
 */
export function requireScope(
  resource: ScopeName,
  loadUserScopes: ScopeLoader,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function scopeGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const role = req.user?.role;
    if (typeof role !== "string" || role.length === 0) {
      res.status(403).json({ error: "Forbidden: no role on session" });
      return;
    }

    if (ADMIN_TIER_ROLES.has(role)) {
      // Owners + admins always pass — no DB round-trip. This is the
      // hot path: most write traffic to scope-guarded routes today
      // comes from owners/admins.
      next();
      return;
    }

    if (!SCOPED_HUMAN_ROLES.has(role)) {
      // `service` lands here; so does any unknown role string. Both
      // fail closed. Service is intentional (the scope axis is for
      // human roles); unknown is defense in depth (the Prisma enum
      // + zod validation should make this unreachable in practice).
      res
        .status(403)
        .json({ error: "Forbidden: role not permitted for scope" });
      return;
    }

    const userId = req.user?.id;
    if (typeof userId !== "string" || userId.length === 0) {
      // A `family` / `guest` session without an `id` is a contract
      // bug upstream — fail closed rather than throwing.
      res.status(403).json({ error: "Forbidden: no user id on session" });
      return;
    }

    let bindings: Set<ScopeName>;
    try {
      bindings = await loadUserScopes(userId);
    } catch (err) {
      // A DB hiccup is operational, NOT an auth fault. Mirror the
      // authMiddleware OCS-unreachable path that returns 500. The
      // dashboard's error rendering already keys on 5xx as
      // "service error" (toast + retry); 403 would silently send
      // the user to re-auth.
      logger.error(
        { err, userId, resource },
        "requireScope loader threw — returning 500",
      );
      res
        .status(500)
        .json({ error: "Scope lookup failed; please retry" });
      return;
    }

    if (bindings.has(resource)) {
      next();
      return;
    }

    res.status(403).json({
      error: "Forbidden: scope binding missing",
      scope: resource,
    });
  };
}
