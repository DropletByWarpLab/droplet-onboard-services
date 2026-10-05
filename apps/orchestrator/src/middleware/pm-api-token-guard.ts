/**
 * WARP-3533 — what a personal API token can reach: `/api/pm/*` and
 * `/api/support/*`, with the scopes it was minted with, at a bounded rate.
 *
 * `authMiddleware` resolves a `dpm_` bearer to its HOLDER (a human `AuthUser`)
 * and sets `req.apiToken`. A human principal passes every route that has no
 * `requireRole` of its own, so, like an extension's call-back principal
 * (extension-principal-guard.ts, WARP-2900), a token must be confined by a
 * guard mounted globally right after `authMiddleware`, before any router:
 *
 *   1. {@link pmApiTokenRateLimit} — one bucket per TOKEN (not per IP: a CI
 *      runner and a laptop behind one NAT must not starve each other). It runs
 *      first, so the denial rows below are bounded by the same budget;
 *   2. {@link pmApiTokenScopeGuard} — the prefix and the scope.
 *
 * Route confinement is by PREFIX (segment-bounded, case-insensitive — the
 * module gates' own normaliser), not an exact allowlist like the extension's:
 * a token is a person's script and the surface is "the whole PM API", so a route
 * added under `/api/pm` tomorrow is reachable by a token with the right scope
 * the day it lands, with the holder's role/module/feature gates in front of it.
 * Two things are carved out of that prefix: admin configuration
 * (`SESSION_ONLY_ROUTES`: webhooks, project and desk settings), which only a
 * session may touch. Nothing else is reachable: not `/api/auth`, not
 * `/api/developer` (so a token can never mint a token, a feed link or flip the
 * switch), not `/api/files`.
 *
 * Scope is by METHOD: every read needs `<area>:read` and everything else
 * `<area>:write`; write implies read. The one exception is the tiny
 * `READ_ONLY_POSTS` list: POSTs that only read (a filter too big for a query
 * string). Scopes only NARROW — the holder's own role checks run after this and
 * are unchanged.
 */
import type { NextFunction, Request, Response } from "express";
import { recordAccessDenied } from "./auth.js";
import { createRateLimit } from "./rate-limit.js";
import { requiredScope, scopeAllows, tokenAreaForPath } from "../services/pm/pm-api-token.service.js";

/** Requests per minute, per token. 5 a second sustained: a script, not a crawler. */
export const PM_API_TOKEN_RPM = 300;

export function createPmApiTokenRateLimit(limit: number = PM_API_TOKEN_RPM, name = "pm-api-token") {
  return createRateLimit(name, {
    windowMs: 60_000,
    limit,
    // Only token requests count here; everything else is the app-wide IP limiter's.
    skip: (req) => !req.apiToken,
    key: (req) => (req.apiToken ? `token:${req.apiToken.id}` : undefined),
  });
}

/**
 * One limiter for the process (module scope, not per createApp): tests build
 * several apps and express-rate-limit warns when a MemoryStore is created
 * repeatedly from the same call site.
 */
export const pmApiTokenRateLimit = createPmApiTokenRateLimit();

export function pmApiTokenScopeGuard(req: Request, res: Response, next: NextFunction): void {
  const token = req.apiToken;
  if (!token) {
    next();
    return;
  }
  const area = tokenAreaForPath(req.path);
  if (!area) {
    // authMiddleware already refuses this before the lookup; the guard is the
    // second lock, for any path it did not see (a router mounted ahead of it).
    recordAccessDenied(req, "api-token-route");
    res.status(403).json({
      error: "Forbidden: an API token cannot call this route",
      code: "TOKEN_ROUTE_FORBIDDEN",
    });
    return;
  }
  if (!scopeAllows(token.scopes, area, req.method, req.path)) {
    const required = requiredScope(area, req.method, req.path);
    recordAccessDenied(req, "api-token-scope");
    res
      .status(403)
      .set("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${required}"`)
      .json({ error: "insufficient_scope", required });
    return;
  }
  next();
}
