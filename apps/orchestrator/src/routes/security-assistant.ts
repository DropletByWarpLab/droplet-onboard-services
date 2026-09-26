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
 *   A5  GET /api/security/assistant/patterns        security_explain_pattern  (WARP-2980, P5 PR-E)
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
 * services/security-assistant-view.ts: no person's name, no stored summary.
 * A read that cannot be answered is 503, never an empty 200: an empty list
 * reads as a quiet site.
 *
 * A5 (WARP-2980, ADR-059 P5 PR-E, spec §6.18) calls PR-A's
 * `explainSecurityPattern` — the function behind route 31 and the Patterns
 * page — with the acting person's scope, so its numbers are the page's. An
 * area the person sees through some of its cameras but not all of them is
 * named with `usual: null` (DS-005 on derived numbers, D22); an area or
 * camera they cannot see at all answers exactly like one that does not
 * exist. A1/A2 read counted reasons only: a pattern flag, trial or quietened
 * by expected activity, lives in SecurityPatternFlag and never reaches a
 * tool (D30: the model must not narrate an untested flag as a reason).
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
import { HoursUnreadableError, readModeView, readSiteClock } from "../services/security-mode.service.js";
import {
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
import { explainSecurityPattern } from "../services/security-patterns-read.js";
import {
  ASSISTANT_EVENT_KINDS,
  ASSISTANT_STORED_KINDS,
  ZONE_KIND_WORD,
  assistantKindOf,
  codesOut,
  eventSource,
  eventWhat,
  fitList,
  hiddenPatternAnswer,
  incidentTitle,
  incidentUrl,
  nameKey,
  patternAnswer,
  severityWord,
  stateWord,
} from "../services/security-assistant-view.js";
import {
  ASSISTANT_PERIODS,
  assistantInstant,
  parseAssistantInstant,
  resolveAssistantPeriod,
  type AssistantSite,
  type ResolvedAssistantPeriod,
} from "../lib/security-assistant-period.js";
import { PATTERN_RELEASE } from "../lib/security-rules.js";
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
/** Pages A1 reads to fill one answer when a period drops incidents whose VISIBLE span misses it. */
const WINDOW_ROUNDS = 4;
/** A5's `at`: how far back (the event retention; the numbers are the last 4 weeks either way)… */
const PATTERN_AT_BACK_MS = 30 * DAY_MS;
/** …and how far ahead (route 31's bound: a clock a little ahead of the box's). */
const PATTERN_AT_AHEAD_MS = 3_600_000;

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

type ErrorCode = "BAD_REQUEST" | "NO_SITE_TIMEZONE" | "INCIDENT_NOT_FOUND" | "SECURITY_UNAVAILABLE" | "PLACE_NOT_FOUND" | "PATTERNS_NOT_READY";

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

/** The site clock; stored hours that cannot be evaluated read as "no zone known" (the site_mode health row says why). */
async function siteClockOf(prisma: PrismaClient, now: Date): Promise<AssistantSite> {
  try {
    return await readSiteClock(prisma, now);
  } catch (err) {
    if (err instanceof HoursUnreadableError) return { hours: { state: "not_set" } satisfies SiteHours, timezone: null };
    throw err;
  }
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

/**
 * The cameras a name means, among those the person may see: by display name
 * or Frigate name (case-insensitive, trimmed); a name that matches neither is
 * tried as a Frigate name as given. A camera outside the grant is dropped, so
 * it answers exactly like one that does not exist. (A3's filter; A5's place.)
 */
function visibleCamerasNamed(labels: ReadonlyMap<string, string>, scope: SecurityViewerScope, raw: string): string[] {
  const key = nameKey(raw);
  const named = [...labels].filter(([name, label]) => nameKey(label) === key || nameKey(name) === key).map(([name]) => name);
  const candidates = named.length > 0 ? named : [raw.trim()];
  return candidates.filter((c) => scope.visibleCameras === "all" || scope.visibleCameras.has(c));
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
 * A1's page for a period. The SQL prefilter is on the STORED span; an
 * incident is kept only when THIS viewer's span meets the window (a hidden
 * camera's activity must not pull it in). Reads up to WINDOW_ROUNDS pages to
 * fill `limit`, and resumes exactly after the last incident it returns.
 */
async function incidentsFor(
  prisma: PrismaClient,
  viewer: IncidentViewer,
  f: IncidentListFilters,
  limit: number,
  now: Date,
  period: ResolvedAssistantPeriod | null,
): Promise<{ incidents: IncidentSummary[]; nextCursor: string | null }> {
  const presence = securityOngoingSource();
  if (!period) return listIncidents(prisma, viewer, f, limit, now, presence);
  const meets = (s: IncidentSummary): boolean =>
    Date.parse(s.lastActivityAt) >= period.from.getTime() && Date.parse(s.firstActivityAt) <= period.to.getTime();
  const kept: IncidentSummary[] = [];
  let cursor = f.cursor;
  let resumeAt: string | null = null;
  for (let round = 0; round < WINDOW_ROUNDS; round++) {
    const page = await listIncidents(prisma, viewer, { ...f, cursor, activeBetween: { from: period.from, to: period.to } }, limit, now, presence);
    for (const [i, s] of page.incidents.entries()) {
      if (!meets(s)) continue;
      kept.push(s);
      if (kept.length === limit) {
        const last = i === page.incidents.length - 1 && page.nextCursor === null;
        return { incidents: kept, nextCursor: last ? null : incidentCursorOf(s) };
      }
    }
    resumeAt = page.nextCursor;
    if (!resumeAt) break;
    cursor = parseIncidentCursor(resumeAt) ?? undefined;
  }
  return { incidents: kept, nextCursor: resumeAt };
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

const areasQuery = z.object({ area: z.string().max(60).optional() }).strict();

const patternsQuery = z
  .object({
    area: z.string().max(60).optional(),
    camera: z.string().max(64).optional(),
    label: z.enum(["person", "car", "dog", "cat"]).optional(),
    at: z.string().max(40).optional(),
    // The slot is the period's first hour; the other periods are spans, not a time of day.
    period: z.enum(["last_night", "today"]).optional(),
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
        eventsRemoved: detail.eventsKept === "removed",
        acknowledged: lastOf("acknowledge"),
        resolved: lastOf("resolve"),
      };
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
        const cams = visibleCamerasNamed(labels, scope, q.data.camera);
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
        readModeView(prisma, now),
        loadZoneRecords(prisma, false),
        loadActiveLinks(prisma),
        loadCameraLabels(prisma),
      ]);
      const tz = mode.displayTimezone;
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
      const areas = await Promise.all(
        zones.map(async (z) => {
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
        }),
      );
      const upcoming = mode.hours.state === "set" ? mode.hours.upcoming : null;
      const until = mode.until ?? upcoming?.at ?? null;
      const site = {
        mode: mode.mode,
        why: mode.source === "manual" ? "set by hand" : "opening hours",
        until: until ? assistantInstant(new Date(until), tz, now) : null,
        hoursSet: mode.hours.state === "set",
        timezone: tz,
      };
      // Suggestions are a manage-level surface (route 23): below it, not even a count.
      const shown = new Set(zones.map((z) => z.id));
      const suggestionsWaiting =
        who.level === "manage" ? (await listLinkProposals(prisma, scope, labels)).filter((s) => shown.has(s.zone.id)).length : null;
      const n = fitList(areas, (kept) => ({ site, areas: kept, moreAreas: areas.length, suggestionsWaiting }));
      res.json({ site, areas: areas.slice(0, n), moreAreas: areas.length - n, suggestionsWaiting });
    } catch (err) {
      unavailable(res, err, "assistant area status");
    }
  });

  // A5 (WARP-2980, P5 PR-E) — what normal looks like for one area or camera at one time.
  router.get("/security/assistant/patterns", assistantOnly, actor, async (req: Request, res: Response) => {
    const q = patternsQuery.safeParse(req.query);
    if (!q.success) return badQuery(res, q.error.issues);
    if ((q.data.area === undefined) === (q.data.camera === undefined)) return fail(res, 400, "BAD_REQUEST", "Name one area or one camera.");
    if (q.data.at !== undefined && q.data.period !== undefined) return fail(res, 400, "BAD_REQUEST", "Give at or period, not both.");
    const now = clock();
    let at = now;
    if (q.data.at !== undefined) {
      const parsed = parseAssistantInstant(q.data.at);
      if (!parsed) return fail(res, 400, "BAD_REQUEST", "at must be an ISO-8601 time with an offset, like 2026-09-22T02:00:00+01:00.");
      if (parsed.getTime() > now.getTime() + PATTERN_AT_AHEAD_MS) return fail(res, 400, "BAD_REQUEST", "at can be at most an hour ahead.");
      if (parsed.getTime() < now.getTime() - PATTERN_AT_BACK_MS) return fail(res, 400, "BAD_REQUEST", "at can be at most 30 days back.");
      at = parsed;
    }
    try {
      const who = actorOf(res);
      const scope = await securityScopeForPerson(prisma, who, resolver);
      const site = await siteClockOf(prisma, now);
      if (q.data.period !== undefined) {
        const p = resolveAssistantPeriod({ period: q.data.period }, site, now, new Date(now.getTime() - PATTERN_AT_BACK_MS));
        if (!p.ok) {
          const message = p.code === "NO_SITE_TIMEZONE" ? "Droplet doesn't know this site's time zone. Pass at as an exact time with an offset." : p.message;
          return fail(res, 400, "BAD_REQUEST", message);
        }
        at = p.period!.from;
      }
      const [links, labels] = await Promise.all([loadActiveLinks(prisma), loadCameraLabels(prisma)]);
      const areas = viewerAreas(links, scope);
      let zoneId: string | undefined;
      let camera: string | undefined;
      if (q.data.area !== undefined) {
        zoneId = areaIdByName(areas, q.data.area);
      } else {
        const cams = visibleCamerasNamed(labels, scope, q.data.camera!);
        const key = nameKey(q.data.camera!);
        camera = cams.find((c) => nameKey(c) === key) ?? [...cams].sort()[0];
      }
      // Missing, archived, unlinked or hidden: one answer for all of them.
      if (zoneId === undefined && camera === undefined) return fail(res, 404, "PLACE_NOT_FOUND", "There is no such area or camera.");
      const r = await explainSecurityPattern(prisma, scope, { zoneId, camera, label: q.data.label, at }, now);
      switch (r.status) {
        case "ok":
          return res.json(patternAnswer(r.view, now));
        case "no_timezone":
          return fail(res, 409, "PATTERNS_NOT_READY", "Droplet can't learn what's usual until it knows the site's time zone. Set the opening hours to choose it.");
        case "not_built":
          return fail(res, 409, "PATTERNS_NOT_READY", "Droplet hasn't worked out what's usual yet. It needs about two weeks per camera.");
        case "not_found":
          // An area they see (through at least one camera) that PR-A refuses them: some camera behind it is not
          // theirs. Name the place, give no numbers (DS-005 on derived numbers, D22). A camera is theirs or absent.
          if (zoneId !== undefined) return res.json(hiddenPatternAnswer(areas.names.get(zoneId)!, at, site.timezone, PATTERN_RELEASE, now));
          return fail(res, 404, "PLACE_NOT_FOUND", "There is no such area or camera.");
      }
    } catch (err) {
      unavailable(res, err, "assistant pattern read");
    }
  });

  return router;
}
