/**
 * WARP-2980 (ADR-059 P5, spec §7) — "what normal looks like", and (PR-B)
 * expected activity.
 *
 *   29  GET  /api/security/patterns                     view    the learning list, the keys this viewer may see
 *   30  GET  /api/security/patterns/cells               view    one key's 48 hour cells for one label
 *   31  GET  /api/security/patterns/explain             view    one area or camera at one time (P4's tool's twin)
 *   32  GET  /api/security/suppressions                 view    expected activity this viewer may see; canManage
 *   33  POST /api/security/suppressions                 manage  add expected activity
 *   34  POST /api/security/suppressions/:id/remove      manage  remove it (declared after the literal path)
 *
 * "Suppression" is the route's and the code's word (the ADR's, as DS-020 keeps
 * `zone`); the UI says "Expected activity". Routes 33–34 are manage:
 * `sensitiveRateLimit, requireRole('owner','admin'),
 * requireFeatureAccess('security','manage')` — the role floor answers 403
 * before the resolver is asked. Never `requireRoleOrMcpService`: Droplet's AI
 * may never create, extend or widen a suppression (§4.9), and no route here
 * extends or widens one (it is immutable; remove and add again).
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
import { requireFeatureAccess } from "../middleware/feature-gate.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { mayListArchivedZones, securityLevelFor, securityViewerScope, type SecurityRouteDeps } from "../services/security-access.js";
import { chainSafeText, hasUnsafeDisplayChars, isSecurityAuditUnavailable } from "../services/security-audit.js";
import { ActivityChainPreconditionError } from "../services/activity.service.js";
import { FRIGATE_NAME } from "../services/security-event-ingest.js";
import { explainSecurityPattern, readPatternCells, readPatternsOverview } from "../services/security-patterns-read.js";
import {
  SECURITY_SUPPRESSION_ACTIVE_LIMIT,
  SUPPRESSION_DEFAULT_DAYS,
  SUPPRESSION_MAX_DAYS,
  createSuppression,
  listSuppressions,
  removeSuppression,
} from "../services/security-suppressions.service.js";
import { PATTERN_CODES } from "../lib/security-baseline-math.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-patterns-routes");

/** Same household floor as the rest of /api/security. */
const SECURITY_VIEW_ROLES = ["owner", "admin", "family"] as const;
/** The manage floor (routes 33–34): as for areas and opening hours. */
const SECURITY_MANAGE_ROLES = ["owner", "admin"] as const;
/** `SecuritySuppression.reason` VarChar(120), counted in characters (code points) after trimming. */
const SUPPRESSION_REASON_MAX = 120;

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

/** Route 33's body: exactly these keys (D13). The reason's length and characters are checked after trimming. */
const createBody = z
  .object({
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("area"), zoneId: z.string().uuid() }).strict(),
      z.object({ kind: z.literal("camera"), camera: frigateName }).strict(),
    ]),
    label: frigateName,
    days: z.enum(["every_day", "weekdays", "weekends"]),
    hourFrom: z.number().int().min(0).max(23),
    hourCount: z.number().int().min(1).max(24),
    // The three pattern codes only: never after_hours_presence, camera_offline or threat_signal (D12).
    codes: z
      .array(z.enum(PATTERN_CODES))
      .min(1)
      .max(3)
      .refine((c) => new Set(c).size === c.length, { message: "each code once" }),
    reason: z.string().max(1_000),
    expiresInDays: z.number().int().min(1).max(SUPPRESSION_MAX_DAYS).default(SUPPRESSION_DEFAULT_DAYS),
  })
  .strict()
  .refine((b) => !b.codes.includes("long_dwell") || b.label === "person", {
    message: "only people can stay longer than usual",
    path: ["codes"],
  });

/** Route 34 takes no body. */
const removeBody = z.object({}).strict();

type ErrorCode =
  | "VALIDATION_ERROR"
  | "PATTERNS_UNAVAILABLE"
  | "PATTERN_NOT_FOUND"
  | "PATTERNS_NOT_BUILT"
  | "NO_TIMEZONE"
  // WARP-2980 PR-B — expected activity (routes 32–34).
  | "SUPPRESSIONS_UNAVAILABLE"
  | "SUPPRESSION_NOT_FOUND"
  | "SUPPRESSION_TARGET_NOT_FOUND"
  | "SUPPRESSION_LIMIT"
  | "ZONE_ARCHIVED"
  | "AUDIT_UNAVAILABLE"
  | "INTERNAL_ERROR";

function fail(res: Response, status: number, code: ErrorCode, message: string, issues?: unknown[]): void {
  res.status(status).json({ error: issues ? { code, message, issues } : { code, message } });
}

const invalid = (res: Response, issues: unknown[]) => fail(res, 400, "VALIDATION_ERROR", "The request is not valid", issues);
const unavailable = (res: Response) => fail(res, 503, "PATTERNS_UNAVAILABLE", "What's usual can't be read right now");
/** One body for "missing" and "hidden" alike (DS-005). */
const notFound = (res: Response) => fail(res, 404, "PATTERN_NOT_FOUND", "There's nothing to show for that");
const suppressionsUnavailable = (res: Response) => fail(res, 503, "SUPPRESSIONS_UNAVAILABLE", "Expected activity can't be read right now.");

/**
 * A failed expected-activity write: the audit row could not be written →
 * 503 AUDIT_UNAVAILABLE (the transaction rolled the change back); a broken
 * audit precondition or bad refs → a programming error, 500; anything else
 * is the database → 503 SUPPRESSIONS_UNAVAILABLE.
 */
function writeFailed(res: Response, err: unknown, what: string): void {
  if (isSecurityAuditUnavailable(err)) {
    logger.error({ err }, `${what}: audit unavailable, nothing changed`);
    fail(res, 503, "AUDIT_UNAVAILABLE", "Nothing was changed: the audit log couldn't be written.");
    return;
  }
  if (err instanceof TypeError || err instanceof ActivityChainPreconditionError) {
    logger.error({ err }, `${what}: programming error`);
    fail(res, 500, "INTERNAL_ERROR", "Something went wrong on Droplet.");
    return;
  }
  logger.error({ err }, `${what} failed`);
  suppressionsUnavailable(res);
}

/** The person acting, as the expected-activity writes record them. requireRole already guaranteed a user. */
function actorOf(req: Request) {
  const u = req.user!;
  return { id: u.id, role: u.role, username: u.username, displayName: u.displayName ?? "" };
}

export function createSecurityPatternsRouter(prisma: PrismaClient, deps: SecurityRouteDeps = {}): Router {
  const router = Router();
  const view = requireRole(...SECURITY_VIEW_ROLES);
  const manageGate = [sensitiveRateLimit, requireRole(...SECURITY_MANAGE_ROLES), requireFeatureAccess("security", "manage", deps.resolve)];
  const clock = (): Date => deps.now?.() ?? new Date();

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

  // ── 32 ──────────────────────────────────────────────────────────────────
  // View-level (a filter, never a gate): the rows this viewer may see (DS-005),
  // and whether the SERVER would let them add or remove (D22) — the page renders
  // its controls from `canManage`, never from a client-side level guess. A
  // read, scope or level that cannot be answered is a 503, never an empty list.
  router.get("/security/suppressions", view, async (req: Request, res: Response) => {
    if (Object.keys(req.query).length > 0) {
      invalid(res, [{ path: [], message: "no query parameters" }]);
      return;
    }
    try {
      const scope = await securityViewerScope(prisma, req, deps.resolve);
      const level = await securityLevelFor(req, deps.resolve);
      const suppressions = await listSuppressions(
        prisma,
        { scope, ownerOrAdmin: scope.mayReadThreats && scope.visibleCameras === "all" },
        clock(),
      );
      res.json({ suppressions, canManage: mayListArchivedZones(req, level), limit: SECURITY_SUPPRESSION_ACTIVE_LIMIT });
    } catch (err) {
      logger.error({ err }, "expected activity read failed");
      suppressionsUnavailable(res);
    }
  });

  // ── 33 (manage) ─────────────────────────────────────────────────────────
  router.post("/security/suppressions", ...manageGate, async (req: Request, res: Response) => {
    const body = createBody.safeParse(req.body ?? {});
    if (!body.success) {
      invalid(res, body.error.issues);
      return;
    }
    const reason = body.data.reason.trim();
    const length = [...reason].length;
    // User text: storable, and safe to show every Security viewer — checked BEFORE the transaction.
    if (length < 1 || length > SUPPRESSION_REASON_MAX || !chainSafeText(reason) || hasUnsafeDisplayChars(reason)) {
      invalid(res, [{ path: ["reason"], message: "1–120 characters Droplet can store and show" }]);
      return;
    }
    try {
      const r = await createSuppression(prisma, { ...body.data, reason }, actorOf(req), clock());
      switch (r.status) {
        case "ok":
          res.status(201).json({ suppression: r.suppression });
          return;
        case "target_not_found":
          fail(res, 404, "SUPPRESSION_TARGET_NOT_FOUND", "There's no such area or camera.");
          return;
        case "zone_archived":
          fail(res, 409, "ZONE_ARCHIVED", "That area was removed.");
          return;
        case "limit":
          fail(res, 409, "SUPPRESSION_LIMIT", `There can be up to ${SECURITY_SUPPRESSION_ACTIVE_LIMIT} expected activities at a time.`);
          return;
      }
    } catch (err) {
      writeFailed(res, err, "expected activity create");
    }
  });

  // ── 34 (manage) ─────────────────────────────────────────────────────────
  router.post("/security/suppressions/:id/remove", ...manageGate, async (req: Request, res: Response) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      invalid(res, [{ path: ["id"], message: "not an id" }]);
      return;
    }
    const body = removeBody.safeParse(req.body ?? {});
    if (!body.success) {
      invalid(res, body.error.issues);
      return;
    }
    try {
      const r = await removeSuppression(prisma, req.params.id!, actorOf(req), clock());
      if (r.status === "not_found") {
        fail(res, 404, "SUPPRESSION_NOT_FOUND", "There's no such expected activity.");
        return;
      }
      res.json({ changed: r.changed });
    } catch (err) {
      writeFailed(res, err, "expected activity remove");
    }
  });

  return router;
}
