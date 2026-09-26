/**
 * WARP-2979 (ADR-059 P4 §6.12.2, §7 A1–A4) — what the read-only `security`
 * chat tools read. Mounted at "/api" in app.ts after the other Security
 * routers, under the same `security` module gate (the box toggle answers
 * every principal):
 *
 *   A1  GET /api/security/assistant/incidents       security_list_incidents
 *   A2  GET /api/security/assistant/incidents/:id   security_get_incident
 *   A3  GET /api/security/assistant/events          security_search_events
 *   A4  GET /api/security/assistant/areas           security_zone_status
 *
 * WHY A ROUTER OF ITS OWN. Tools reach the orchestrator from the mcp-server
 * as `_service:mcp`, with `X-Nextcloud-User` naming the person the assistant
 * acts for. Every human Security route refuses that principal on purpose
 * (never `requireRoleOrMcpService`); reading through `ctx.prisma` in
 * tools-core instead would be a second copy of DS-005 in another package.
 *
 * GET ONLY, and nothing else (ADR-055 §11.5 extended by brief §4.6): Droplet's
 * AI never acknowledges, resolves, changes the mode, hours, routing or links.
 * Pinned by security-level-invariant.test.ts's assistant table and by the
 * tools-core registry pin on the domain.
 *
 * THE GUARD CHAIN, on every route, in this order:
 *   1. `requireRoleOrService("_service:mcp")` with NO human role: it admits
 *      exactly the MCP principal; a person gets 403 and an access-denied row.
 *   2. `resolveSecurityActor` — who the assistant acts for:
 *        · `X-Nextcloud-User` is required;
 *        · it is resolved by the shared `resolveAssertedUser` (WARP-3061):
 *          username, nextcloudUsername or id — the header carries a username
 *          on stdio and a User.id over HTTP (WARP-3099), and SSO/SCIM users
 *          have no nextcloudUsername — refusing nobody, ambiguity and a
 *          deactivated person;
 *        · the role must be owner, admin or family, and the resolved §9
 *          catalog must hold `security` at view or above (owners bypass);
 *        · any other outcome, a throwing resolver included, is 404
 *          `{error: 'module_disabled', module: 'security'}` — byte-identical
 *          to the module and feature gates, so the tool reads every refusal
 *          the same way ("switched off, or this person can't use it").
 * The acting person's scope is then `securityScopeForPerson`, the ONE
 * function the dashboard's routes use, and DS-005 is applied by the
 * dashboard's own projections (`listIncidents`, `loadIncidentDetail`,
 * `feedVisibilityWhere` at AND[0], `viewerAreas`, `visibleZoneViews`,
 * `zoneFilterFor`). An area or camera the person cannot see answers exactly
 * like one that does not exist.
 *
 * Outside this file: `mountModuleGates` 404s all of /api/security when the
 * module is off, and the WARP-2988 acting-user gate (`security` in
 * MCP_ACTING_USER_GATED_DOMAINS) also checks the person's tool scope — the
 * mcp-server's HTTP transport runs only write-tier RBAC.
 *
 * What the tools see is built field by field in
 * services/security-assistant-view.ts: no person's name, no stored event
 * summary. The one stored text A2 passes is Droplet's own "Summary by
 * Droplet" (`summaryByDroplet`), under `narrativeVisibleTo` and only once
 * written. A read that cannot be answered is 503, never an empty 200: an
 * empty list reads as a quiet site.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRoleOrService } from "../middleware/auth.js";
import { MCP_PRINCIPAL_ID } from "../middleware/mcp-acting-user-gate.js";
import type { EffectiveAccessResolver } from "../middleware/feature-gate.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveEffectiveAccess } from "../services/effective-access.service.js";
import { FEATURE_LEVEL_RANK, type FeatureLevel } from "../services/access-catalog.js";
import { securityScopeForPerson, type SecurityRouteDeps, type SecurityViewerScope } from "../services/security-access.js";
import {
  incidentListWhere,
  listIncidents,
  loadIncidentDetail,
  parseIncidentCursor,
  type IncidentListFilters,
  type IncidentSummary,
  type IncidentViewer,
} from "../services/security-incident-view.js";
import { SECURITY_EVENT_RETENTION_DAYS, feedVisibilityWhere, listSecurityEvents, parseFeedCursor } from "../services/security-events.service.js";
import { SECURITY_INCIDENT_RETENTION_DAYS } from "../services/security-incidents.service.js";
import { HoursUnreadableError, readModeView, readSiteClock, resolveSecurityTimezone, type ModeView } from "../services/security-mode.service.js";
import {
  SECURITY_ZONE_ACTIVE_LIMIT,
  listLinkProposals,
  loadActiveLinks,
  loadCameraLabels,
  loadZoneRecords,
  parseLinkRef,
  viewerAreas,
  visibleZoneViews,
  zoneChipsFor,
  zoneFilterFor,
  type ViewerAreas,
} from "../services/security-zones.service.js";
import { securityOngoingSource, securityStatusSnapshot } from "../services/camera.service.js";
import {
  ASSISTANT_EVENT_KINDS,
  ASSISTANT_STORED_KINDS,
  ZONE_KIND_WORD,
  assistantKindOf,
  codesOut,
  eventSource,
  eventWhat,
  fitList,
  incidentTitle,
  incidentUrl,
  nameKey,
  severityWord,
  stateWord,
  summaryOut,
} from "../services/security-assistant-view.js";
import {
  ASSISTANT_PERIODS,
  assistantInstant,
  resolveAssistantPeriod,
  type AssistantSite,
  type ResolvedAssistantPeriod,
} from "../lib/security-assistant-period.js";
import type { SiteHours } from "../lib/security-hours.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-assistant-routes");

const DAY_MS = 86_400_000;
/** Per-tool page limits (§6.12.3): each keeps an answer under the 8,000-char tool cap with `fitList`. */
const INCIDENT_LIMIT_MAX = 25;
const EVENT_LIMIT_MAX = 40;
/** Members A2 carries — the rest is on the incident page. */
const INCIDENT_EVENTS_SHOWN = 30;
/** Area names one event carries; an event in more says how many more (the dashboard shows them all). */
const AREAS_PER_EVENT = 3;
/** Evidence rows per code A2 carries. */
const EVIDENCE_PER_CODE = 3;
/**
 * WARP-3194 — A4 reads this many areas at once (two reads each), and only as
 * many batches as its page can hold: never every visible area at once.
 */
export const AREA_READ_BATCH = 8;

const HUMAN_ROLES = new Set(["owner", "admin", "family"]);

/** The live camera / Frigate readings (camera.service's tracker, `SourceHealth`): null key = Frigate itself. */
export type CameraStatusSource = () => ReadonlyMap<string | null, { health: "online" | "offline" | "disabled" }>;

export interface SecurityAssistantDeps extends SecurityRouteDeps {
  /** Whether each camera is reporting, for A4. Tests inject; production reads camera.service. */
  cameraStatus?: CameraStatusSource;
}

/** The person the assistant acts for, once `resolveSecurityActor` has let the call through. */
interface SecurityActor {
  id: string;
  role: string;
  level: FeatureLevel;
}

type ErrorCode = "BAD_REQUEST" | "NO_SITE_TIMEZONE" | "INCIDENT_NOT_FOUND" | "SECURITY_UNAVAILABLE";

function fail(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function unavailable(res: Response, err: unknown, what: string): void {
  logger.error({ err }, `${what} failed`);
  fail(res, 503, "SECURITY_UNAVAILABLE", "Security can't be read right now.");
}

// ── the acting person ─────────────────────────────────────────────────────

const SECURITY_ACTOR_MARKER = Symbol.for("droplet.securityAssistantActor");

/** True for the middleware `resolveSecurityActor` returns — how the level invariant finds it in a stack. */
export function isSecurityActorResolver(fn: unknown): boolean {
  return typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[SECURITY_ACTOR_MARKER] === true;
}

/**
 * Step 2 of the chain (see the header): resolve the acting person, or refuse
 * with the module gate's own 404. Never a 503: an unresolvable person is a
 * refusal, whatever the reason, so no answer depends on WHY.
 */
export function resolveSecurityActor(prisma: PrismaClient, resolve: EffectiveAccessResolver): RequestHandler {
  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const refuse = (reason: string): void => {
      logger.warn({ reason }, "security_assistant_refused");
      res.status(404).json({ error: "module_disabled", module: "security" });
    };
    // Belt and braces: step 1 already admitted only this principal.
    if (req.user?.id !== MCP_PRINCIPAL_ID || req.user.role !== "service") return refuse("not_the_mcp_principal");
    const asserted = (req.header("x-nextcloud-user") ?? "").trim();
    if (!asserted) return refuse("no_acting_user");
    try {
      const who = await resolveAssertedUser(prisma, asserted);
      if (!who.ok) return refuse(who.reason);
      if (!HUMAN_ROLES.has(who.user.role)) return refuse("role");
      let level: FeatureLevel = "manage";
      if (who.user.role !== "owner") {
        const access = await resolve(who.user.id);
        const held = access?.features.find((f) => f.moduleId === "security");
        if (!held || FEATURE_LEVEL_RANK[held.level] < FEATURE_LEVEL_RANK.view) return refuse("level");
        level = held.level;
      }
      res.locals.securityActor = { id: who.user.id, role: who.user.role, level } satisfies SecurityActor;
      next();
    } catch (err) {
      logger.error({ err }, "security_assistant_actor_failed");
      refuse("resolve_failed");
    }
  };
  Object.defineProperty(handler, SECURITY_ACTOR_MARKER, { value: true, enumerable: false, writable: false });
  return handler;
}

function actorOf(res: Response): SecurityActor {
  return res.locals.securityActor as SecurityActor;
}

function viewerOf(actor: SecurityActor, scope: SecurityViewerScope): IncidentViewer {
  return {
    userId: actor.id,
    visibleCameras: scope.visibleCameras,
    mayReadThreats: scope.mayReadThreats,
    ownerOrAdmin: actor.role === "owner" || actor.role === "admin",
  };
}

// ── shared pieces ─────────────────────────────────────────────────────────

/**
 * WARP-3194 — the zone when the stored opening hours cannot be evaluated (the
 * site_mode health row says why). The site's own zone when the runtime knows
 * it — the rows are broken, not the zone, and THE display rule
 * (`resolveSecurityTimezone`) keeps it — else the workspace's: the rule
 * answers null for a site zone it cannot read, which cost `today`,
 * `last_night` and A4 their answers altogether. Nothing is swapped silently:
 * every answer names the zone it used (`timezone`). Null only when neither is
 * known.
 */
async function unreadableHoursZone(prisma: PrismaClient): Promise<string | null> {
  return (await resolveSecurityTimezone(prisma)) ?? resolveSecurityTimezone(prisma, { state: "not_set" });
}

/** The site clock; stored hours that cannot be evaluated read as not set, in `unreadableHoursZone`. */
async function siteClockOf(prisma: PrismaClient, now: Date): Promise<AssistantSite> {
  try {
    return await readSiteClock(prisma, now);
  } catch (err) {
    if (err instanceof HoursUnreadableError) return { hours: { state: "not_set" } satisfies SiteHours, timezone: await unreadableHoursZone(prisma) };
    throw err;
  }
}

/**
 * A4's `site`: the effective mode and why (never who). `mode` null = the
 * stored hours cannot be evaluated (WARP-3194): the mode is then "unknown" —
 * route 5 answers 503 rather than a fake "open", and so does this field —
 * while the areas still answer.
 */
function siteOut(mode: ModeView | null, tz: string | null, now: Date) {
  if (!mode) return { mode: "unknown", why: "opening hours can't be read", until: null, hoursSet: true, timezone: tz };
  const upcoming = mode.hours.state === "set" ? mode.hours.upcoming : null;
  const until = mode.until ?? upcoming?.at ?? null;
  return {
    mode: mode.mode,
    why: mode.source === "manual" ? "set by hand" : "opening hours",
    until: until ? assistantInstant(new Date(until), tz, now) : null,
    hoursSet: mode.hours.state === "set",
    timezone: tz,
  };
}

function periodOut(p: ResolvedAssistantPeriod | null, tz: string | null, now: Date) {
  return p ? { from: assistantInstant(p.from, tz, now), to: assistantInstant(p.to, tz, now), label: p.label } : null;
}

/** An area the person can see, by name (case-insensitive, trimmed), among areas with a visible link; else undefined. */
function areaIdByName(areas: ViewerAreas, name: string): string | undefined {
  const key = nameKey(name);
  for (const [id, areaName] of areas.names) if (nameKey(areaName) === key) return id;
  return undefined;
}

const periodFields = {
  period: z.enum(ASSISTANT_PERIODS).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
};

function badQuery(res: Response, issues: z.ZodIssue[]): void {
  const first = issues[0];
  fail(res, 400, "BAD_REQUEST", first ? `${first.path.join(".") || "query"}: ${first.message}` : "That request isn't in a shape Droplet understands.");
}

// ── A1 / A2 builders ──────────────────────────────────────────────────────

function incidentItem(s: IncidentSummary, labels: ReadonlyMap<string, string>, tz: string | null, now: Date) {
  return {
    id: s.id,
    title: incidentTitle(s, labels),
    severity: severityWord(s.severity),
    state: stateWord(s.state),
    codes: codesOut(s.reasonCodes),
    first: assistantInstant(new Date(s.firstActivityAt), tz, now),
    last: assistantInstant(new Date(s.lastActivityAt), tz, now),
    events: s.eventCount,
    stillHappening: s.grouping === "collecting",
    url: incidentUrl(s.id),
  };
}

/** The list's own keyset position of one summary: the viewer's last activity, then the id. */
function incidentCursorOf(s: IncidentSummary): string {
  return `${Date.parse(s.lastActivityAt)}.${s.id}`;
}

interface EventLike {
  id: string;
  source: string;
  kind: string;
  labels: readonly string[];
  camera: string | null;
  cameraZones: readonly string[];
  startedAt: string;
  endedAt: string | null;
}

function areaNames(chips: ReadonlyArray<{ name: string }>): string[] {
  const names = chips.slice(0, AREAS_PER_EVENT).map((z) => z.name);
  return chips.length > AREAS_PER_EVENT ? [...names, `and ${chips.length - AREAS_PER_EVENT} more`] : names;
}

function eventItem(e: EventLike, areas: ViewerAreas, labels: ReadonlyMap<string, string>, tz: string | null, now: Date) {
  return {
    at: assistantInstant(new Date(e.startedAt), tz, now),
    until: e.endedAt ? assistantInstant(new Date(e.endedAt), tz, now) : null,
    kind: assistantKindOf(e.kind),
    what: eventWhat(e.kind, e.labels, e.camera),
    source: eventSource(e.kind, e.camera, labels),
    part: e.cameraZones.length > 0 ? e.cameraZones.join(", ") : null,
    areas: areaNames(zoneChipsFor({ source: e.source as never, kind: e.kind as never, camera: e.camera, cameraZones: e.cameraZones }, areas)),
  };
}

/**
 * A1's page — for a period too. The period is judged in the query on THIS
 * viewer's span (`activeBetween`, review #2420), so the page and its cursor
 * are exactly the list she may see: a hidden camera's activity in the window
 * can neither pull an incident in nor leave a cursor that leads nowhere.
 */
async function incidentsFor(
  prisma: PrismaClient,
  viewer: IncidentViewer,
  f: IncidentListFilters,
  limit: number,
  now: Date,
  period: ResolvedAssistantPeriod | null,
): Promise<{ incidents: IncidentSummary[]; nextCursor: string | null }> {
  const activeBetween = period ? { from: period.from, to: period.to } : undefined;
  return listIncidents(prisma, viewer, { ...f, ...(activeBetween ? { activeBetween } : {}) }, limit, now, securityOngoingSource());
}

// ── the router ────────────────────────────────────────────────────────────

const incidentsQuery = z
  .object({
    ...periodFields,
    area: z.string().max(60).optional(),
    severity: z.enum(["alert", "notice"]).optional(),
    state: z.enum(["attention", "open", "acknowledged", "resolved", "activity", "all"]).default("all"),
    limit: z.coerce.number().int().min(1).max(INCIDENT_LIMIT_MAX).default(10),
    cursor: z.string().max(60).optional(),
  })
  .strict();

const eventsQuery = z
  .object({
    ...periodFields,
    area: z.string().max(60).optional(),
    camera: z.string().max(64).optional(),
    label: z.enum(["person", "car", "dog", "cat"]).optional(),
    kind: z.enum(Object.keys(ASSISTANT_EVENT_KINDS) as [keyof typeof ASSISTANT_EVENT_KINDS, ...Array<keyof typeof ASSISTANT_EVENT_KINDS>]).optional(),
    limit: z.coerce.number().int().min(1).max(EVENT_LIMIT_MAX).default(20),
    cursor: z.string().max(40).optional(),
  })
  .strict();

const areasQuery = z
  .object({
    area: z.string().max(60).optional(),
    // WARP-3194 — A4's `nextOffset`: where the next page starts among this viewer's visible areas.
    offset: z.coerce.number().int().min(0).max(SECURITY_ZONE_ACTIVE_LIMIT).default(0),
  })
  .strict();

const UUID = z.string().uuid();

export function createSecurityAssistantRouter(prisma: PrismaClient, deps: SecurityAssistantDeps = {}): Router {
  const router = Router();
  const clock = (): Date => (deps.now ? deps.now() : new Date());
  const resolver = deps.resolve ?? resolveEffectiveAccess;
  const cameraStatus: CameraStatusSource = deps.cameraStatus ?? securityStatusSnapshot;
  // Step 1: exactly the MCP principal, no human role (a person gets 403).
  const assistantOnly = requireRoleOrService(MCP_PRINCIPAL_ID);
  const actor = resolveSecurityActor(prisma, resolver);

  // A1 — incidents, newest first by the person's own last activity.
  router.get("/security/assistant/incidents", assistantOnly, actor, async (req: Request, res: Response) => {
    const q = incidentsQuery.safeParse(req.query);
    if (!q.success) return badQuery(res, q.error.issues);
    const cursor = q.data.cursor ? parseIncidentCursor(q.data.cursor) : undefined;
    if (cursor === null) return fail(res, 400, "BAD_REQUEST", "cursor: not one Droplet gave out.");
    const now = clock();
    try {
      const who = actorOf(res);
      const scope = await securityScopeForPerson(prisma, who, resolver);
      const viewer = viewerOf(who, scope);
      const site = await siteClockOf(prisma, now);
      const p = resolveAssistantPeriod(q.data, site, now, new Date(now.getTime() - SECURITY_INCIDENT_RETENTION_DAYS * DAY_MS));
      if (!p.ok) return fail(res, 400, p.code, p.message);
      const head = { period: periodOut(p.period, site.timezone, now), timezone: site.timezone };
      let zoneId: string | undefined;
      if (q.data.area !== undefined) {
        zoneId = areaIdByName(viewerAreas(await loadActiveLinks(prisma), scope), q.data.area);
        // Missing, archived, unlinked or hidden: the same empty answer.
        if (!zoneId) return res.json({ ...head, incidents: [], nextCursor: null });
      }
      const page = await incidentsFor(
        prisma,
        viewer,
        { state: q.data.state, severity: q.data.severity, zoneId, cursor },
        q.data.limit,
        now,
        p.period,
      );
      const labels = await loadCameraLabels(prisma);
      const items = page.incidents.map((s) => incidentItem(s, labels, site.timezone, now));
      const n = fitList(items, (kept) => ({ ...head, incidents: kept, nextCursor: "0000000000000.00000000-0000-0000-0000-000000000000" }));
      res.json({
        ...head,
        incidents: items.slice(0, n),
        nextCursor: n < items.length ? incidentCursorOf(page.incidents[n - 1]!) : page.nextCursor,
      });
    } catch (err) {
      unavailable(res, err, "assistant incident list");
    }
  });

  // A2 — one incident. Missing and hidden are the same answer.
  router.get("/security/assistant/incidents/:id", assistantOnly, actor, async (req: Request, res: Response) => {
    if (!UUID.safeParse(req.params.id).success) return fail(res, 400, "BAD_REQUEST", "incident_id: not an incident id.");
    const now = clock();
    try {
      const who = actorOf(res);
      const scope = await securityScopeForPerson(prisma, who, resolver);
      const viewer = viewerOf(who, scope);
      const detail = await loadIncidentDetail(prisma, req.params.id!, viewer, "view", now, securityOngoingSource());
      if (!detail) return fail(res, 404, "INCIDENT_NOT_FOUND", "There is no such incident.");
      const [site, labels, links] = await Promise.all([siteClockOf(prisma, now), loadCameraLabels(prisma), loadActiveLinks(prisma)]);
      const tz = site.timezone;
      const areas = viewerAreas(links, scope);
      const area = detail.zone?.name ?? null;
      const codes = codesOut(detail.reasonCodes).map((c) => ({
        ...c,
        evidence: detail.reasons
          .filter((r) => r.code === c.code)
          .slice(0, EVIDENCE_PER_CODE)
          .map((r) => ({
            at: assistantInstant(new Date(r.evidence.at), tz, now),
            source: eventSource(r.evidence.kind, r.evidence.camera, labels),
            what: eventWhat(r.evidence.kind, r.evidence.label ? [r.evidence.label] : [], r.evidence.camera),
            area,
          })),
      }));
      const members = detail.events.filter((e) => assistantKindOf(e.kind) !== null);
      const events = members.slice(0, INCIDENT_EVENTS_SHOWN).map((e) => eventItem(e, areas, labels, tz, now));
      const lastOf = (action: "acknowledge" | "resolve") => {
        const a = [...detail.acks].reverse().find((x) => x.action === action);
        return a ? { at: assistantInstant(new Date(a.at), tz, now) } : null;
      };
      const base = {
        ...incidentItem(detail, labels, tz, now),
        codes,
        // Route 18's `narrative` for this viewer (narrativeVisibleTo), written text only.
        summaryByDroplet: summaryOut(detail.narrative, tz, now),
        eventsRemoved: detail.eventsKept === "removed",
        acknowledged: lastOf("acknowledge"),
        resolved: lastOf("resolve"),
      };
      // The summary is in `base`, so it counts toward the budget: the events give way, never the summary.
      const n = fitList(events, (kept) => ({ incident: { ...base, events: kept, moreEvents: true } }));
      res.json({
        incident: { ...base, events: events.slice(0, n), moreEvents: detail.moreEvents || members.length > n },
      });
    } catch (err) {
      unavailable(res, err, "assistant incident read");
    }
  });

  // A3 — events, newest first; DS-005 is feedVisibilityWhere at AND[0].
  router.get("/security/assistant/events", assistantOnly, actor, async (req: Request, res: Response) => {
    const q = eventsQuery.safeParse(req.query);
    if (!q.success) return badQuery(res, q.error.issues);
    const cursor = q.data.cursor ? parseFeedCursor(q.data.cursor) : undefined;
    if (cursor === null) return fail(res, 400, "BAD_REQUEST", "cursor: not one Droplet gave out.");
    const now = clock();
    try {
      const who = actorOf(res);
      const scope = await securityScopeForPerson(prisma, who, resolver);
      const site = await siteClockOf(prisma, now);
      const p = resolveAssistantPeriod(q.data, site, now, new Date(now.getTime() - SECURITY_EVENT_RETENTION_DAYS * DAY_MS));
      if (!p.ok) return fail(res, 400, p.code, p.message);
      const head = { period: periodOut(p.period, site.timezone, now), timezone: site.timezone };
      const empty = () => res.json({ ...head, events: [], nextCursor: null });
      const [labels, links] = await Promise.all([loadCameraLabels(prisma), loadActiveLinks(prisma)]);
      const extraWhere: Prisma.SecurityEventWhereInput[] = [];
      if (q.data.camera !== undefined) {
        // By display name or Frigate name; a camera outside the grant is the same empty page as one that does not exist.
        const key = nameKey(q.data.camera);
        const named = [...labels].filter(([name, label]) => nameKey(label) === key || nameKey(name) === key).map(([name]) => name);
        const candidates = named.length > 0 ? named : [q.data.camera.trim()];
        const cams = candidates.filter((c) => scope.visibleCameras === "all" || scope.visibleCameras.has(c));
        if (cams.length === 0) return empty();
        extraWhere.push({ camera: { in: cams } });
      }
      if (q.data.area !== undefined) {
        const zoneId = areaIdByName(viewerAreas(links, scope), q.data.area);
        const clause = zoneId ? zoneFilterFor(links, zoneId, scope) : "none";
        if (clause === "none") return empty();
        extraWhere.push(clause);
      }
      if (q.data.label) extraWhere.push({ labels: { has: q.data.label } });
      if (p.period) extraWhere.push({ startedAt: { gte: p.period.from, lte: p.period.to } });
      const kinds = q.data.kind ? ASSISTANT_EVENT_KINDS[q.data.kind] : q.data.label ? ASSISTANT_EVENT_KINDS.detection : ASSISTANT_STORED_KINDS;
      const page = await listSecurityEvents(
        prisma,
        feedVisibilityWhere(scope.visibleCameras, scope.mayReadThreats),
        { limit: q.data.limit, cursor: cursor ?? undefined, kinds: { in: [...kinds] }, includeLow: false },
        extraWhere,
      );
      const areas = viewerAreas(links, scope);
      const items = page.events.map((e) => eventItem(e, areas, labels, site.timezone, now));
      const n = fitList(items, (kept) => ({ ...head, events: kept, nextCursor: "0000000000000.9223372036854775807" }));
      const tail = page.events[n - 1];
      res.json({
        ...head,
        events: items.slice(0, n),
        nextCursor: n < items.length && tail ? `${Date.parse(tail.startedAt)}.${tail.id}` : page.nextCursor,
      });
    } catch (err) {
      unavailable(res, err, "assistant event search");
    }
  });

  // A4 — the site mode and, per visible area, what covers it right now.
  router.get("/security/assistant/areas", assistantOnly, actor, async (req: Request, res: Response) => {
    const q = areasQuery.safeParse(req.query);
    if (!q.success) return badQuery(res, q.error.issues);
    const now = clock();
    try {
      const who = actorOf(res);
      const scope = await securityScopeForPerson(prisma, who, resolver);
      const viewer = viewerOf(who, scope);
      const [mode, records, links, labels] = await Promise.all([
        // WARP-3194: hours that cannot be evaluated leave the mode unknown, not the whole answer a 503.
        readModeView(prisma, now).catch((err: unknown) => {
          if (err instanceof HoursUnreadableError) return null;
          throw err;
        }),
        loadZoneRecords(prisma, false),
        loadActiveLinks(prisma),
        loadCameraLabels(prisma),
      ]);
      const tz = mode ? mode.displayTimezone : await unreadableHoursZone(prisma);
      let zones = visibleZoneViews(records, scope, labels);
      if (q.data.area !== undefined) {
        const key = nameKey(q.data.area);
        zones = zones.filter((z) => nameKey(z.name) === key);
      }
      const status = cameraStatus();
      const frigateDown = status.get(null)?.health === "offline";
      // "detection off": Frigate says the camera is there but not detecting — neither reporting nor offline.
      const reporting = (camera: string | undefined): "yes" | "offline" | "detection off" | "not set up" | "unknown" => {
        if (!camera || !labels.has(camera)) return "not set up";
        if (frigateDown) return "offline";
        const r = status.get(camera);
        if (!r) return "unknown";
        return r.health === "online" ? "yes" : r.health === "disabled" ? "detection off" : "offline";
      };
      const visibility = feedVisibilityWhere(scope.visibleCameras, scope.mayReadThreats);
      // One area's answer: its last visible activity and its open incidents (two reads), and what covers it.
      const readArea = async (z: (typeof zones)[number]) => {
        const clause = zoneFilterFor(links, z.id, scope);
        const latest =
          clause === "none"
            ? null
            : (await listSecurityEvents(prisma, visibility, { limit: 1, kinds: { in: ["detection"] }, includeLow: false }, [clause])).events[0] ?? null;
        const openIncidents = await prisma.securityIncident.count({ where: incidentListWhere(viewer, { state: "open", zoneId: z.id }) });
        return {
          name: z.name,
          kind: ZONE_KIND_WORD[z.kind],
          lastActivity: latest
            ? { at: assistantInstant(new Date(latest.startedAt), tz, now), what: eventWhat(latest.kind, latest.labels, latest.camera), source: eventSource(latest.kind, latest.camera, labels) }
            : null,
          openIncidents,
          coveredBy: z.links.map((l) => {
            const parsed = parseLinkRef(l.sourceKind, l.sourceRef);
            return {
              source: l.label,
              part: parsed?.frigateZone ?? null,
              reporting: reporting(parsed?.camera),
              linkedBy: l.setBy === "droplet" ? "Droplet" : "a person",
            };
          }),
        };
      };
      const site = siteOut(mode, tz, now);
      // Suggestions are a manage-level surface (route 23): below it, not even a count. Over every area shown, not the page.
      const shown = new Set(zones.map((z) => z.id));
      const suggestionsWaiting =
        who.level === "manage" ? (await listLinkProposals(prisma, scope, labels)).filter((s) => shown.has(s.zone.id)).length : null;
      // WARP-3194 — the page: `offset` counts THIS viewer's visible areas only (DS-005), so no offset, count or
      // page says anything about an area she cannot see. `wrap` is the exact body for a page of `kept`.
      const offset = q.data.offset;
      const page = zones.slice(offset);
      const wrap = (kept: readonly unknown[]) => ({
        site,
        areas: kept,
        moreAreas: page.length - kept.length,
        nextOffset: kept.length < page.length ? offset + kept.length : null,
        suggestionsWaiting,
      });
      // WARP-3194 — read the page's areas only, AREA_READ_BATCH at a time, and stop at the first batch the body
      // overflows: a longer prefix never fits once a shorter one does not, so the page is exactly what fitting
      // every area would give.
      const items: Array<Awaited<ReturnType<typeof readArea>>> = [];
      for (let i = 0; i < page.length; i += AREA_READ_BATCH) {
        items.push(...(await Promise.all(page.slice(i, i + AREA_READ_BATCH).map(readArea))));
        if (fitList(items, wrap) < items.length) break;
      }
      res.json(wrap(items.slice(0, fitList(items, wrap))));
    } catch (err) {
      unavailable(res, err, "assistant area status");
    }
  });

  return router;
}
