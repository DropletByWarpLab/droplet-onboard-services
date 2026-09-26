/**
 * WARP-2978 (ADR-059 P3 spec §7) — incidents, acknowledgement and alert
 * routing. Mounted at "/api" in app.ts AFTER createSecuritySiteRouter, under
 * the `security` module gate mountModuleGates mounts off /api/security (box
 * toggle + per-person view):
 *
 *   16  GET  /api/security/incidents                     view
 *   17  GET  /api/security/incidents/summary             view   (declared before /:id)
 *   18  GET  /api/security/incidents/:id                 view
 *   19  POST /api/security/incidents/:id/acknowledge     act
 *   20  POST /api/security/incidents/:id/resolve         act
 *   21  GET  /api/security/alert-routing                 view   (a filter by level, not a gate)
 *   22  PUT  /api/security/alert-routing/:userId         manage
 *   35  POST /api/security/incidents/:id/verdict         act, floored at owner/admin (WARP-2980 P5 PR-B)
 *
 * Route 35 (brief §4.4: "the owner or a Security manager can mark Expected /
 * Not expected"): `sensitiveRateLimit, requireRole('owner','admin'),
 * requireFeatureAccess('security','act')` — act is the level ADR §6 gives
 * verdicts, and the owner/admin floor means nobody can overwrite a judgement
 * about flags or cameras they cannot see (review item 2; P4 route S1's
 * precedent). 409 NOT_JUDGEABLE when there is nothing for them to judge or
 * their view is partial (one body). A verdict never changes the incident's
 * state, severity, codes or notifications.
 *
 * Gates follow P2b exactly: every GET is `requireRole('owner','admin',
 * 'family')` only — a page load never produces a feature-gate denial, which
 * the threat mirror would copy into the feed as a threat. act:
 * `sensitiveRateLimit, requireRole('owner','admin','family'),
 * requireFeatureAccess('security','act')`; manage: `sensitiveRateLimit,
 * requireRole('owner','admin'), requireFeatureAccess('security','manage')`.
 * Never `requireRoleOrMcpService`: Droplet's AI may never acknowledge,
 * resolve or change routing (§4.9).
 *
 * DS-005 is services/security-incident-view.ts's (one place). A hidden
 * incident answers exactly like a missing one (404 INCIDENT_NOT_FOUND, same
 * body); an incident whose visible codes are empty is plain activity (409
 * NOT_ACTIONABLE). Errors are `{error: {code, message}}`; a read that cannot
 * be answered is a 503, never an empty 200 (an empty list reads as a quiet
 * site). An audit failure is 503 AUDIT_UNAVAILABLE with nothing changed.
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
import {
  INCIDENT_PAGE_MAX,
  incidentsSummary,
  listIncidents,
  loadIncidentDetail,
  parseIncidentCursor,
  type IncidentViewer,
} from "../services/security-incident-view.js";
import { actOnIncident, setIncidentVerdict } from "../services/security-incident-actions.js";
import { securityOngoingSource } from "../services/camera.service.js";
import { alertsReady, readAlertRouting, setAlertRouting } from "../services/security-alerts.service.js";
import { resolveEffectiveAccess } from "../services/effective-access.service.js";
import { loadActiveLinks, viewerAreas } from "../services/security-zones.service.js";
import { describeClient } from "../lib/client-descriptor.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-incident-routes");

const VIEW_ROLES = ["owner", "admin", "family"] as const;
const ACT_ROLES = ["owner", "admin", "family"] as const;
const MANAGE_ROLES = ["owner", "admin"] as const;

type ErrorCode =
  | "VALIDATION_ERROR"
  | "INCIDENT_NOT_FOUND"
  | "INCIDENT_CONFLICT"
  | "NOT_ACTIONABLE"
  | "INCIDENTS_UNAVAILABLE"
  | "AUDIT_UNAVAILABLE"
  | "ROUTING_UNAVAILABLE"
  | "USER_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "NO_RECIPIENT"
  | "NOT_ELIGIBLE"
  | "INTERNAL_ERROR"
  // WARP-2980 P5 PR-B — route 35.
  | "NOT_JUDGEABLE";

function fail(res: Response, status: number, code: ErrorCode, message: string, issues?: unknown[]): void {
  res.status(status).json({ error: issues ? { code, message, issues } : { code, message } });
}

const UUID = z.string().uuid();

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(INCIDENT_PAGE_MAX).default(30),
    cursor: z.string().max(60).optional(),
    state: z.enum(["attention", "open", "acknowledged", "resolved", "activity", "all"]).default("all"),
    severity: z.enum(["alert", "notice"]).optional(),
    zone: UUID.optional(),
  })
  .strict();

/** A NotificationLog id (cuid) — and nothing that could be anything else. */
const NOTIFICATION_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const ackBodySchema = z.object({ notificationId: NOTIFICATION_ID.optional() }).strict();
const resolveBodySchema = z.object({ note: z.string().max(280).optional() }).strict();
/** Route 35: a verdict can change, never go back to unreviewed. */
const verdictBodySchema = z.object({ verdict: z.enum(["expected", "not_expected"]) }).strict();
const routingBodySchema = z
  .object({
    state: z.enum(["receiving", "not_receiving"]),
    expectedVersion: z.number().int().min(0).max(2_147_483_647).nullable(),
  })
  .strict();

/** The viewer as the incident read model needs them. requireRole already guaranteed a user. */
async function viewerOf(prisma: PrismaClient, req: Request, deps: SecurityRouteDeps): Promise<IncidentViewer> {
  const scope = await securityViewerScope(prisma, req, deps.resolve);
  const role = req.user?.role;
  return {
    userId: req.user!.id,
    visibleCameras: scope.visibleCameras,
    mayReadThreats: scope.mayReadThreats,
    mayReadLocks: scope.mayReadLocks,
    ownerOrAdmin: role === "owner" || role === "admin",
  };
}

/**
 * The viewer's Security level for OUTPUT (route 18's `viewer.level`, route
 * 21's shape): the resolved level; with nothing to resolve, what the role
 * floor allows (owner/admin manage — `mayListArchivedZones`' rule — family
 * act); a resolved person with no Security entry reads as view.
 */
async function outputLevel(req: Request, deps: SecurityRouteDeps): Promise<"view" | "act" | "manage"> {
  const level = await securityLevelFor(req, deps.resolve);
  if (level === "none") return "view";
  if (level === null) return mayListArchivedZones(req, null) ? "manage" : "act";
  return level;
}

/** What the acknowledging request can say about who and which device. */
function actorOf(req: Request) {
  const user = req.user!;
  const sessionId = user.sid ?? null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName ?? "",
    sessionId,
    // WARP-2804: true only when authMiddleware's live-session check confirmed this sign-in.
    sessionChecked: sessionId !== null && req.sessionChecked === true,
    client: describeClient(req.get("user-agent"), req.get("x-droplet-client")),
  };
}

function writeFailed(res: Response, err: unknown, what: string, unavailable: "INCIDENTS_UNAVAILABLE" | "ROUTING_UNAVAILABLE"): void {
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
  fail(res, 503, unavailable, "Security can't be reached right now.");
}

export function createSecurityIncidentsRouter(prisma: PrismaClient, deps: SecurityRouteDeps = {}): Router {
  const router = Router();
  const clock = (): Date => (deps.now ? deps.now() : new Date());
  // WARP-2978 PR-D — who is still in view, for a camera-limited viewer's "still happening".
  const presence = deps.ongoing ?? securityOngoingSource();
  const resolver = deps.resolve ?? resolveEffectiveAccess;
  const actGate = [sensitiveRateLimit, requireRole(...ACT_ROLES), requireFeatureAccess("security", "act", deps.resolve)];
  const manageGate = [sensitiveRateLimit, requireRole(...MANAGE_ROLES), requireFeatureAccess("security", "manage", deps.resolve)];
  // WARP-2980 PR-B — act level, owner/admin floor (review item 2).
  const verdictGate = [sensitiveRateLimit, requireRole(...MANAGE_ROLES), requireFeatureAccess("security", "act", deps.resolve)];

  // 16 — the incident list, (the viewer's own last activity desc, id desc) — review R1.
  router.get("/security/incidents", requireRole(...VIEW_ROLES), async (req: Request, res: Response) => {
    const q = listQuerySchema.safeParse(req.query);
    const cursor = q.success && q.data.cursor ? parseIncidentCursor(q.data.cursor) : undefined;
    if (!q.success || cursor === null) {
      fail(res, 400, "VALIDATION_ERROR", "Those list options aren't in a shape Droplet understands.", q.success ? undefined : q.error.issues);
      return;
    }
    try {
      const viewer = await viewerOf(prisma, req, deps);
      if (q.data.zone && viewer.visibleCameras !== "all") {
        // A hidden (or missing, archived, unlinked) area answers the empty page, no query.
        // The feed's area rule (DS-005, DS-019): a lock link shows an area only with Devices view.
        const areas = viewerAreas(await loadActiveLinks(prisma), viewer);
        if (!areas.names.has(q.data.zone)) {
          res.json({ incidents: [], nextCursor: null });
          return;
        }
      }
      res.json(
        await listIncidents(
          prisma,
          viewer,
          { state: q.data.state, severity: q.data.severity, zoneId: q.data.zone, cursor: cursor ?? undefined },
          q.data.limit,
          clock(),
          presence,
        ),
      );
    } catch (err) {
      logger.error({ err }, "incident list read failed");
      fail(res, 503, "INCIDENTS_UNAVAILABLE", "Incidents can't be read right now.");
    }
  });

  // 17 — the counts and the latest three for /d/security. Before /:id.
  router.get("/security/incidents/summary", requireRole(...VIEW_ROLES), async (req: Request, res: Response) => {
    try {
      const viewer = await viewerOf(prisma, req, deps);
      const [summary, ready] = await Promise.all([incidentsSummary(prisma, viewer, clock(), presence), alertsReady(prisma)]);
      res.json({ ...summary, alertsReady: ready });
    } catch (err) {
      logger.error({ err }, "incident summary read failed");
      fail(res, 503, "INCIDENTS_UNAVAILABLE", "Incidents can't be read right now.");
    }
  });

  // 18 — one incident: codes, visible members, acks, notices (§6.8).
  router.get("/security/incidents/:id", requireRole(...VIEW_ROLES), async (req: Request, res: Response) => {
    if (!UUID.safeParse(req.params.id).success) {
      fail(res, 400, "VALIDATION_ERROR", "That isn't an incident id.");
      return;
    }
    try {
      const viewer = await viewerOf(prisma, req, deps);
      const detail = await loadIncidentDetail(prisma, req.params.id!, viewer, await outputLevel(req, deps), clock(), presence);
      if (!detail) {
        // Missing and hidden are the same answer, byte for byte.
        fail(res, 404, "INCIDENT_NOT_FOUND", "There is no such incident.");
        return;
      }
      res.json(detail);
    } catch (err) {
      logger.error({ err }, "incident read failed");
      fail(res, 503, "INCIDENTS_UNAVAILABLE", "Incidents can't be read right now.");
    }
  });

  async function act(req: Request, res: Response, action: "acknowledge" | "resolve"): Promise<void> {
    if (!UUID.safeParse(req.params.id).success) {
      fail(res, 400, "VALIDATION_ERROR", "That isn't an incident id.");
      return;
    }
    const parsed = (action === "resolve" ? resolveBodySchema : ackBodySchema).safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 400, "VALIDATION_ERROR", "That request isn't in a shape Droplet understands.", parsed.error.issues);
      return;
    }
    const body = parsed.data as { notificationId?: string; note?: string };
    const note = (body.note ?? "").trim();
    // User text: storable, and safe to show every Security viewer — checked BEFORE the transaction.
    if (!chainSafeText(note) || hasUnsafeDisplayChars(note)) {
      fail(res, 400, "VALIDATION_ERROR", "The note has characters Droplet can't store.");
      return;
    }
    const now = clock();
    try {
      const viewer = await viewerOf(prisma, req, deps);
      const result = await actOnIncident(prisma, {
        incidentId: req.params.id!,
        action,
        actor: actorOf(req),
        viewer,
        notificationId: body.notificationId ?? null,
        note,
        now,
      });
      switch (result.status) {
        case "not_found":
          fail(res, 404, "INCIDENT_NOT_FOUND", "There is no such incident.");
          return;
        case "not_actionable":
          fail(res, 409, "NOT_ACTIONABLE", "There's nothing here to acknowledge.");
          return;
        case "conflict":
          fail(res, 409, "INCIDENT_CONFLICT", "Someone else changed this incident at the same moment. Try again.");
          return;
      }
      const detail = await loadIncidentDetail(prisma, req.params.id!, viewer, await outputLevel(req, deps), now, presence);
      res.json({ incident: detail, changed: result.changed });
    } catch (err) {
      writeFailed(res, err, `incident ${action}`, "INCIDENTS_UNAVAILABLE");
    }
  }

  // 19 (act) — "someone is on it".
  router.post("/security/incidents/:id/acknowledge", ...actGate, (req: Request, res: Response) => act(req, res, "acknowledge"));

  // 20 (act) — done, with an optional note. Seals the incident.
  router.post("/security/incidents/:id/resolve", ...actGate, (req: Request, res: Response) => act(req, res, "resolve"));

  // 35 (act, owner/admin) — WARP-2980 P5 PR-B: Expected / Not expected.
  router.post("/security/incidents/:id/verdict", ...verdictGate, async (req: Request, res: Response) => {
    if (!UUID.safeParse(req.params.id).success) {
      fail(res, 400, "VALIDATION_ERROR", "That isn't an incident id.");
      return;
    }
    const body = verdictBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      fail(res, 400, "VALIDATION_ERROR", "That request isn't in a shape Droplet understands.", body.error.issues);
      return;
    }
    const now = clock();
    try {
      const viewer = await viewerOf(prisma, req, deps);
      const r = await setIncidentVerdict(prisma, { incidentId: req.params.id!, verdict: body.data.verdict, actor: actorOf(req), viewer, now });
      switch (r.status) {
        case "not_found":
          fail(res, 404, "INCIDENT_NOT_FOUND", "There is no such incident.");
          return;
        case "not_judgeable":
          fail(res, 409, "NOT_JUDGEABLE", "There's nothing here to mark.");
          return;
        case "conflict":
          fail(res, 409, "INCIDENT_CONFLICT", "Someone else changed this incident at the same moment. Try again.");
          return;
      }
      const detail = await loadIncidentDetail(prisma, req.params.id!, viewer, await outputLevel(req, deps), now, presence);
      res.json({ incident: detail, changed: r.changed });
    } catch (err) {
      writeFailed(res, err, "incident verdict", "INCIDENTS_UNAVAILABLE");
    }
  });

  // 21 — who is told. A filter by level, not a gate: below manage, the viewer's own line.
  router.get("/security/alert-routing", requireRole(...VIEW_ROLES), async (req: Request, res: Response) => {
    try {
      const level = await outputLevel(req, deps);
      res.json(await readAlertRouting(prisma, resolver, { id: req.user!.id, role: req.user!.role }, level));
    } catch (err) {
      logger.error({ err }, "alert routing read failed");
      fail(res, 503, "ROUTING_UNAVAILABLE", "Who is told about alerts can't be read right now.");
    }
  });

  // 22 (manage) — choose who is told.
  router.put("/security/alert-routing/:userId", ...manageGate, async (req: Request, res: Response) => {
    const body = routingBodySchema.safeParse(req.body ?? {});
    if (!UUID.safeParse(req.params.userId).success || !body.success) {
      fail(res, 400, "VALIDATION_ERROR", "That routing change isn't in a shape Droplet understands.", body.success ? undefined : body.error.issues);
      return;
    }
    try {
      const r = await setAlertRouting(
        prisma,
        resolver,
        { user: { id: req.user!.id, role: req.user!.role } },
        { userId: req.params.userId!, state: body.data.state, expectedVersion: body.data.expectedVersion },
        clock(),
      );
      switch (r.status) {
        case "ok":
          res.json({ person: r.person });
          return;
        case "not_found":
          fail(res, 404, "USER_NOT_FOUND", "There is no such person.");
          return;
        case "not_eligible":
          fail(res, 422, "NOT_ELIGIBLE", "This person can't open Security, so they can't be told about alerts.");
          return;
        case "version_conflict":
          fail(res, 409, "VERSION_CONFLICT", "Who is told about alerts changed since this page loaded.");
          return;
        case "no_recipient":
          fail(res, 409, "NO_RECIPIENT", "Someone who can open Security has to be told about alerts.");
          return;
      }
    } catch (err) {
      writeFailed(res, err, "alert routing change", "ROUTING_UNAVAILABLE");
    }
  });

  return router;
}
