/**
 * WARP-2980 (ADR-059 P5, spec §7) — "what normal looks like", read-only.
 *
 *   29  GET /api/security/patterns           view   the learning list, the keys this viewer may see
 *   30  GET /api/security/patterns/cells     view   one key's 48 hour cells for one label
 *   31  GET /api/security/patterns/explain   view   one area or camera at one time (the PR-E tool's twin)
 *
 * Mounted in app.ts after createSecuritySiteRouter, under the same
 * /api/security module gate (`mountModuleGates`: the box toggle and the
 * per-person view). Every route is `requireRole('owner','admin','family')`
 * ONLY — a page load must never produce a denial the threat mirror turns
 * into a "threat". Never `requireRoleOrMcpService`: the chat tool (PR-E)
 * reaches `explainSecurityPattern` through P4's assistant router with the
 * acting person's scope, not through here.
 *
 * Errors are `{error: {code, message, issues?}}` (the dashboard's apiFetch
 * shape); query strings are zod `.strict()`. A hidden key answers exactly
 * like a missing one (404 PATTERN_NOT_FOUND, one body). An outage is a 503
 * PATTERNS_UNAVAILABLE, never an empty 200 that would read as "nothing is
 * usual yet". Who sees what comes from services/security-access.ts; the
 * numbers from services/security-patterns-read.ts.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { securityViewerScope, type SecurityRouteDeps } from "../services/security-access.js";
import { FRIGATE_NAME } from "../services/security-event-ingest.js";
import { explainSecurityPattern, readPatternCells, readPatternsOverview } from "../services/security-patterns-read.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-patterns-routes");

/** Same household floor as the rest of /api/security. */
const SECURITY_VIEW_ROLES = ["owner", "admin", "family"] as const;

/** `at` may be at most this far ahead (a clock a little ahead of the box's). */
const EXPLAIN_AT_AHEAD_MS = 3_600_000;

const KEY = /^(area:[0-9a-f-]{36}|camera:[a-zA-Z0-9_-]{1,64})$/;
const frigateName = z.string().regex(FRIGATE_NAME);

const cellsQuery = z
  .object({
    key: z.string().regex(KEY),
    label: frigateName.default("person"),
  })
  .strict();

const explainQuery = z
  .object({
    zone: z.string().uuid().optional(),
    camera: frigateName.optional(),
    label: frigateName.optional(),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((q) => (q.zone === undefined) !== (q.camera === undefined), { message: "exactly one of zone or camera" });

type ErrorCode = "VALIDATION_ERROR" | "PATTERNS_UNAVAILABLE" | "PATTERN_NOT_FOUND" | "PATTERNS_NOT_BUILT" | "NO_TIMEZONE";

function fail(res: Response, status: number, code: ErrorCode, message: string, issues?: unknown[]): void {
  res.status(status).json({ error: issues ? { code, message, issues } : { code, message } });
}

const invalid = (res: Response, issues: unknown[]) => fail(res, 400, "VALIDATION_ERROR", "The request is not valid", issues);
const unavailable = (res: Response) => fail(res, 503, "PATTERNS_UNAVAILABLE", "What's usual can't be read right now");
/** One body for "missing" and "hidden" alike (DS-005). */
const notFound = (res: Response) => fail(res, 404, "PATTERN_NOT_FOUND", "There's nothing to show for that");

export function createSecurityPatternsRouter(prisma: PrismaClient, deps: SecurityRouteDeps = {}): Router {
  const router = Router();
  const view = requireRole(...SECURITY_VIEW_ROLES);

  // ── 29 ──────────────────────────────────────────────────────────────────
  router.get("/security/patterns", view, async (req: Request, res: Response) => {
    if (Object.keys(req.query).length > 0) {
      invalid(res, [{ path: [], message: "no query parameters" }]);
      return;
    }
    try {
      const scope = await securityViewerScope(prisma, req, deps.resolve);
      res.json(await readPatternsOverview(prisma, scope));
    } catch (err) {
      logger.error({ err }, "security patterns overview read failed");
      unavailable(res);
    }
  });

  // ── 30 ──────────────────────────────────────────────────────────────────
  router.get("/security/patterns/cells", view, async (req: Request, res: Response) => {
    const q = cellsQuery.safeParse(req.query);
    if (!q.success) {
      invalid(res, q.error.issues);
      return;
    }
    try {
      const scope = await securityViewerScope(prisma, req, deps.resolve);
      const r = await readPatternCells(prisma, scope, q.data.key, q.data.label);
      if (r.status === "not_found") notFound(res);
      else res.json(r.view);
    } catch (err) {
      logger.error({ err }, "security pattern cells read failed");
      unavailable(res);
    }
  });

  // ── 31 ──────────────────────────────────────────────────────────────────
  router.get("/security/patterns/explain", view, async (req: Request, res: Response) => {
    const q = explainQuery.safeParse(req.query);
    if (!q.success) {
      invalid(res, q.error.issues);
      return;
    }
    const now = deps.now?.() ?? new Date();
    const at = q.data.at ? new Date(q.data.at) : undefined;
    if (at && at.getTime() > now.getTime() + EXPLAIN_AT_AHEAD_MS) {
      invalid(res, [{ path: ["at"], message: "at most an hour ahead" }]);
      return;
    }
    try {
      const scope = await securityViewerScope(prisma, req, deps.resolve);
      const r = await explainSecurityPattern(
        prisma,
        scope,
        { zoneId: q.data.zone, camera: q.data.camera, label: q.data.label, at },
        now,
      );
      switch (r.status) {
        case "ok":
          res.json(r.view);
          return;
        case "not_found":
          notFound(res);
          return;
        case "not_built":
          fail(res, 409, "PATTERNS_NOT_BUILT", "Droplet hasn't worked out what's usual yet");
          return;
        case "no_timezone":
          fail(res, 409, "NO_TIMEZONE", "Droplet needs the site's timezone first");
          return;
      }
    } catch (err) {
      logger.error({ err }, "security pattern explain failed");
      unavailable(res);
    }
  });

  return router;
}
