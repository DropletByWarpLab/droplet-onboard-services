/**
 * WARP-2977 P2b (ADR-059 §3.4) — areas ("zones" in code) and the sources
 * they link to.
 *
 *    3  GET    /api/security/zones                  view    (include=archived: a filter at manage, not a gate)
 *    4  GET    /api/security/sources                view
 *    8  POST   /api/security/zones                  manage
 *    9  PATCH  /api/security/zones/:id              manage
 *   10  POST   /api/security/zones/:id/archive      manage
 *   11  POST   /api/security/zones/:id/unarchive    manage
 *   12  PUT    /api/security/zones/:id/links        manage
 *   23  GET    /api/security/link-proposals         view    (WARP-2979; the list is filled only at manage — a filter, not a gate)
 *   24  POST   /api/security/links/:linkId/accept   manage  (WARP-2979: Add it / Keep)
 *   25  POST   /api/security/links/:linkId/reject   manage  (WARP-2979: Not this / Undo)
 *
 * All under the `security` module gate that mountModuleGates mounts off
 * /api/security (the box toggle + per-person view).
 *
 * Gating: every GET is `requireRole('owner','admin','family')` only — a page
 * load must never produce a denial that the threat mirror turns into a
 * threat. Every manage route is `sensitiveRateLimit, requireRole('owner',
 * 'admin'), requireFeatureAccess('security','manage', deps.resolve)`. Never
 * `requireRoleOrMcpService`. Literal paths come before `:id` paths.
 *
 * Errors are `{error: {code, message, issues?, archivedZoneId?}}` (the
 * dashboard's apiFetch shape). Who sees what comes from
 * services/security-access.ts only; the rules and the audited writes live in
 * services/security-zones.service.ts.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { requireFeatureAccess } from "../middleware/feature-gate.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { ActivityChainPreconditionError } from "../services/activity.service.js";
import { fetchConfig } from "../services/frigate.client.js";
import { isSecurityAuditUnavailable } from "../services/security-audit.js";
import {
  mayListArchivedZones,
  securityLevelFor,
  securityViewerScope,
  type SecurityRouteDeps,
  type SecurityViewerScope,
} from "../services/security-access.js";
import { readSecurityAiSettings } from "../services/security-ai-settings.js";
import {
  SECURITY_ZONE_KINDS,
  SECURITY_ZONE_LINK_LIMIT,
  ZoneWriteError,
  buildSourcesView,
  createZone,
  decideDropletLink,
  listLinkProposals,
  frigatePartsFromConfig,
  loadActiveLinks,
  loadCameraLabels,
  loadZoneRecords,
  normaliseZoneName,
  parseLinkRef,
  replaceZoneLinks,
  setZoneState,
  toZoneView,
  updateZone,
  visibleLinks,
  visibleZoneViews,
  type DesiredZoneLink,
  type ZoneRecord,
  type ZoneWriteContext,
} from "../services/security-zones.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-zones-routes");

/** Same household floor as the rest of /api/security. */
const SECURITY_VIEW_ROLES = ["owner", "admin", "family"] as const;
const SECURITY_MANAGE_ROLES = ["owner", "admin"] as const;

/** `SecurityZone.version` is an Int column. */
const expectedVersion = z.number().int().min(0).max(2_147_483_647);
/** Raw cap before trimming — the real rule (1–60 characters) is normaliseZoneName's. */
const rawName = z.string().max(240);
const zoneKind = z.enum(SECURITY_ZONE_KINDS);

const zonesQuery = z.object({ include: z.literal("archived").optional() }).strict();
const createBody = z.object({ name: rawName, kind: zoneKind }).strict();
const patchBody = z
  .object({ name: rawName.optional(), kind: zoneKind.optional(), expectedVersion })
  .strict()
  .refine((b) => b.name !== undefined || b.kind !== undefined, { message: "name or kind is required" });
const versionBody = z.object({ expectedVersion }).strict();
const linksBody = z
  .object({
    // Deduped below; this raw cap only bounds the work.
    links: z
      .array(z.object({ sourceKind: z.enum(["camera", "camera_zone"]), sourceRef: z.string().max(160) }).strict())
      .max(SECURITY_ZONE_LINK_LIMIT * 2),
    expectedVersion,
  })
  .strict();
const zoneIdParam = z.string().uuid();
/** WARP-2979 — routes 24/25 are intents with no fields; anything sent is refused, never read. */
const emptyBody = z.object({}).strict();

const NAME_RULE = "1–60 characters, at least one visible; no control, bidi override or zero-width characters";

type ErrorCode = ZoneWriteError["code"] | "ZONES_UNAVAILABLE" | "AUDIT_UNAVAILABLE" | "LINKS_UNAVAILABLE";

function fail(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  extra: { issues?: unknown[]; archivedZoneId?: string } = {},
): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

function invalid(res: Response, issues: unknown[]): void {
  fail(res, 400, "VALIDATION_ERROR", "The request is not valid", { issues });
}

function unavailable(res: Response): void {
  fail(res, 503, "ZONES_UNAVAILABLE", "Areas are unavailable right now");
}

/**
 * The one place a failed write becomes its answer:
 *   · ZoneWriteError — the expected refusals (400 on the name CHECK, 404,
 *     409, 422, 503 SOURCE_CHECK_UNAVAILABLE);
 *   · the audit row could not be written — 503 AUDIT_UNAVAILABLE; the
 *     transaction rolled the change back;
 *   · a broken audit precondition or refs the chain refuses — a programming
 *     error, 500 (security-audit.ts's contract);
 *   · anything else is the database — 503 ZONES_UNAVAILABLE.
 */
function answerWriteError(res: Response, err: unknown, what: string): void {
  if (err instanceof ZoneWriteError) {
    fail(res, err.status, err.code, err.message, err.extra);
    return;
  }
  if (isSecurityAuditUnavailable(err)) {
    logger.error({ err }, `${what}: the audit row could not be written, so nothing changed`);
    fail(res, 503, "AUDIT_UNAVAILABLE", "Droplet couldn't record this change, so it wasn't made");
    return;
  }
  if (err instanceof ActivityChainPreconditionError || err instanceof TypeError) {
    logger.error({ err }, `${what}: programming error`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
    return;
  }
  logger.error({ err }, `${what} failed`);
  unavailable(res);
}

function writeContext(req: Request, deps: SecurityRouteDeps): ZoneWriteContext {
  return { req, now: deps.now?.() ?? new Date() };
}

/** The written area as its writer sees it: only the links visible to them (DS-005, even for a write). */
function writtenView(zone: ZoneRecord, scope: SecurityViewerScope, labels: ReadonlyMap<string, string>) {
  return toZoneView(zone, visibleLinks(zone.links, scope), labels, scope);
}

export function createSecurityZonesRouter(prisma: PrismaClient, deps: SecurityRouteDeps = {}): Router {
  const router = Router();
  const view = requireRole(...SECURITY_VIEW_ROLES);
  /** Built per route, so each write route carries its own gate (and its readable meta). */
  const manage = () => [
    sensitiveRateLimit,
    requireRole(...SECURITY_MANAGE_ROLES),
    requireFeatureAccess("security", "manage", deps.resolve),
  ];
  const frigateConfig = deps.frigateConfig ?? fetchConfig;

  /**
   * What a write needs to answer, read BEFORE it: the writer's scope and the
   * camera labels. A failure here is a 503 with nothing changed, never a
   * failure after a commit.
   */
  async function beforeWrite(req: Request): Promise<{ scope: SecurityViewerScope; labels: Map<string, string> }> {
    const [scope, labels] = await Promise.all([
      securityViewerScope(prisma, req, deps.resolve),
      loadCameraLabels(prisma),
    ]);
    return { scope, labels };
  }

  // ── 3. the areas this viewer may see ────────────────────────────────────
  router.get("/security/zones", view, async (req: Request, res: Response) => {
    const q = zonesQuery.safeParse(req.query);
    if (!q.success) {
      invalid(res, q.error.issues);
      return;
    }
    try {
      const scope = await securityViewerScope(prisma, req, deps.resolve);
      // A filter, not a gate: below manage it is ignored, never refused.
      const includeArchived =
        q.data.include === "archived" && mayListArchivedZones(req, await securityLevelFor(req, deps.resolve));
      const [zones, labels] = await Promise.all([loadZoneRecords(prisma, includeArchived), loadCameraLabels(prisma)]);
      res.json({ zones: visibleZoneViews(zones, scope, labels) });
    } catch (err) {
      logger.error({ err }, "security zones read failed");
      unavailable(res);
    }
  });

  // ── 4. what can be linked, and whether each link still points at something ──
  router.get("/security/sources", view, async (req: Request, res: Response) => {
    let scope: SecurityViewerScope;
    try {
      scope = await securityViewerScope(prisma, req, deps.resolve);
    } catch (err) {
      // Without the scope nothing can be filtered for DS-005: fail closed.
      logger.error({ err }, "security sources: the viewer's camera grants could not be read");
      unavailable(res);
      return;
    }
    // Three reads, each settled on its own. The catalog's two halves may each
    // fail alone (spec §7, "degrades per half"): the Camera rows, and the
    // camera system's config (ONE fetch, with its timeout). The links being
    // checked are read separately, so a failed Camera-row read no longer
    // drops them: every visible link still gets a status, `unknown` wherever
    // the answer needed the unreadable half (`linkSourceStatus`), and with
    // both halves down every visible link is `unknown`. An empty list would
    // read on the Areas page as "nothing to flag".
    const [rows, links, cfg] = await Promise.allSettled([
      loadCameraLabels(prisma),
      loadActiveLinks(prisma),
      frigateConfig().then(frigatePartsFromConfig),
    ]);
    if (links.status === "rejected") {
      // Nothing to give a status FOR, and `linkStatus: []` would claim every
      // link checked out. A 503 makes the Areas page say "Couldn't check the
      // camera system" on every area (its failed-request path) instead.
      logger.error({ err: links.reason }, "security sources: the links could not be read");
      unavailable(res);
      return;
    }
    if (rows.status === "rejected") logger.warn({ err: rows.reason }, "security sources: camera rows unreadable");
    if (cfg.status === "rejected") logger.warn({ err: cfg.reason }, "security sources: camera system config unavailable");
    res.json(
      buildSourcesView(
        {
          cameraRows: rows.status === "fulfilled" ? rows.value : null,
          frigate: cfg.status === "fulfilled" ? cfg.value : null,
        },
        links.value,
        scope,
      ),
    );
  });

  // ── 8. add an area ──────────────────────────────────────────────────────
  router.post("/security/zones", ...manage(), async (req: Request, res: Response) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) {
      invalid(res, body.error.issues);
      return;
    }
    const name = normaliseZoneName(body.data.name);
    if (name === null) {
      invalid(res, [{ path: ["name"], message: NAME_RULE }]);
      return;
    }
    try {
      const zone = await createZone(prisma, writeContext(req, deps), { name, kind: body.data.kind });
      res.status(201).json({ zone: toZoneView(zone, [], new Map()) });
    } catch (err) {
      answerWriteError(res, err, "security zone create");
    }
  });

  // ── 9. rename / re-kind an area ─────────────────────────────────────────
  router.patch("/security/zones/:id", ...manage(), async (req: Request, res: Response) => {
    const id = zoneIdParam.safeParse(req.params.id);
    if (!id.success) {
      fail(res, 404, "ZONE_NOT_FOUND", "No such area");
      return;
    }
    const body = patchBody.safeParse(req.body);
    if (!body.success) {
      invalid(res, body.error.issues);
      return;
    }
    let name: string | undefined;
    if (body.data.name !== undefined) {
      const n = normaliseZoneName(body.data.name);
      if (n === null) {
        invalid(res, [{ path: ["name"], message: NAME_RULE }]);
        return;
      }
      name = n;
    }
    try {
      const { scope, labels } = await beforeWrite(req);
      const out = await updateZone(prisma, writeContext(req, deps), id.data, {
        name,
        kind: body.data.kind,
        expectedVersion: body.data.expectedVersion,
      });
      res.json({ zone: writtenView(out.zone, scope, labels), changed: out.changed });
    } catch (err) {
      answerWriteError(res, err, "security zone update");
    }
  });

  // ── 10 / 11. remove (archive) and restore ───────────────────────────────
  for (const [path, to] of [
    ["/security/zones/:id/archive", "archived"],
    ["/security/zones/:id/unarchive", "active"],
  ] as const) {
    router.post(path, ...manage(), async (req: Request, res: Response) => {
      const id = zoneIdParam.safeParse(req.params.id);
      if (!id.success) {
        fail(res, 404, "ZONE_NOT_FOUND", "No such area");
        return;
      }
      const body = versionBody.safeParse(req.body);
      if (!body.success) {
        invalid(res, body.error.issues);
        return;
      }
      try {
        const { scope, labels } = await beforeWrite(req);
        const out = await setZoneState(prisma, writeContext(req, deps), id.data, to, body.data.expectedVersion);
        res.json({ zone: writtenView(out.zone, scope, labels), changed: out.changed });
      } catch (err) {
        answerWriteError(res, err, to === "archived" ? "security zone archive" : "security zone unarchive");
      }
    });
  }

  // ── 12. what covers an area ─────────────────────────────────────────────
  router.put("/security/zones/:id/links", ...manage(), async (req: Request, res: Response) => {
    const id = zoneIdParam.safeParse(req.params.id);
    if (!id.success) {
      fail(res, 404, "ZONE_NOT_FOUND", "No such area");
      return;
    }
    const body = linksBody.safeParse(req.body);
    if (!body.success) {
      invalid(res, body.error.issues);
      return;
    }
    const desired: DesiredZoneLink[] = [];
    const seen = new Set<string>();
    const issues: unknown[] = [];
    body.data.links.forEach((l, i) => {
      if (!parseLinkRef(l.sourceKind, l.sourceRef)) {
        issues.push({ path: ["links", i, "sourceRef"], message: "not a camera or part-of-view reference" });
        return;
      }
      const key = `${l.sourceKind}\u0000${l.sourceRef}`;
      if (seen.has(key)) return;
      seen.add(key);
      desired.push({ sourceKind: l.sourceKind, sourceRef: l.sourceRef });
    });
    if (issues.length > 0) {
      invalid(res, issues);
      return;
    }
    if (desired.length > SECURITY_ZONE_LINK_LIMIT) {
      invalid(res, [{ path: ["links"], message: `at most ${SECURITY_ZONE_LINK_LIMIT} links` }]);
      return;
    }
    try {
      const { scope, labels } = await beforeWrite(req);
      const out = await replaceZoneLinks(
        prisma,
        writeContext(req, deps),
        id.data,
        { links: desired, expectedVersion: body.data.expectedVersion },
        { scope, cameraLabels: labels, frigateConfig },
      );
      res.json({ zone: writtenView(out.zone, scope, labels), changed: out.changed });
    } catch (err) {
      answerWriteError(res, err, "security zone links");
    }
  });

  // ── 23. Droplet's open suggestions (WARP-2979) ──────────────────────────
  // View-gated like every GET; the LIST is a manage-level filter (P2b's
  // `mayListArchivedZones` rule: owner/admin at manage, or unresolved) —
  // below it the answer is an empty list, never a denial.
  router.get("/security/link-proposals", view, async (req: Request, res: Response) => {
    try {
      const level = await securityLevelFor(req, deps.resolve);
      const settings = await readSecurityAiSettings(prisma);
      if (!mayListArchivedZones(req, level)) {
        res.json({ level: level === "none" ? null : level, linking: settings.linking, proposals: [] });
        return;
      }
      const [scope, labels] = await Promise.all([securityViewerScope(prisma, req, deps.resolve), loadCameraLabels(prisma)]);
      res.json({ level: "manage", linking: settings.linking, proposals: await listLinkProposals(prisma, scope, labels) });
    } catch (err) {
      logger.error({ err }, "security link proposals read failed");
      fail(res, 503, "LINKS_UNAVAILABLE", "Droplet's suggestions are unavailable right now");
    }
  });

  // ── 24 / 25. a person decides on Droplet's link (WARP-2979) ─────────────
  for (const [path, decision] of [
    ["/security/links/:linkId/accept", "accept"],
    ["/security/links/:linkId/reject", "reject"],
  ] as const) {
    router.post(path, ...manage(), async (req: Request, res: Response) => {
      const id = zoneIdParam.safeParse(req.params.linkId);
      if (!id.success) {
        fail(res, 404, "LINK_NOT_FOUND", "No such link");
        return;
      }
      const body = emptyBody.safeParse(req.body ?? {});
      if (!body.success) {
        invalid(res, body.error.issues);
        return;
      }
      try {
        const { scope, labels } = await beforeWrite(req);
        const out = await decideDropletLink(prisma, writeContext(req, deps), id.data, decision, { scope, cameraLabels: labels });
        res.json({ zone: writtenView(out.zone, scope, labels), changed: out.changed });
      } catch (err) {
        answerWriteError(res, err, `security link ${decision}`);
      }
    });
  }

  return router;
}
