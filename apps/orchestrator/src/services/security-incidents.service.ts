/**
 * WARP-2978 (ADR-059 P3 §3.5, spec §6.1) — the incident engine: it sorts
 * SecurityEvent rows into incidents, attaches reason codes, seals incidents
 * after quiet, hands `alert` incidents to the notifier, and trims incidents
 * with the events (§6.10). The `incidents` health row is its own (§6.11).
 *
 * The meaning lives in lib/security-rules.ts and lib/security-mode-history.ts
 * (pure); this file does the I/O, in this order, every 10 s on the cron
 * runtime under the `droplet:security-incidents` advisory lock (D15 — never
 * on insert, so the MQTT hot path is unchanged; no while(true), no bare
 * setInterval, no container). The lock transaction only HOLDS the lock: every
 * step below runs its own short transactions on the outer client.
 *
 *   1. State. The engine's singleton row. On first sight it starts at the
 *      current max SecurityEvent id: history is never grouped (D16).
 *      Then early presence (WARP-2978 PR-D, spec §6.12): every person the
 *      in-flight map (security-inflight.ts) says has been tracked for 30 s
 *      gets its ONE `detection_ongoing` row, through `recordSecurityEvent`
 *      — before triage, so the row is triaged (and alerts) in this same tick.
 *   2. Triage. The events in (triageFloor, head] with no triage row (an
 *      anti-join), in id order, at most TRIAGE_BATCH, until TICK_BUDGET_MS is
 *      spent. Each in ONE READ COMMITTED transaction that writes its triage row
 *      (the exactly-once marker — the PK is the claim), the incident change and
 *      the reason rows together. A triage that throws for a reason of its OWN
 *      (a CHECK, a bad row) is recorded `failed` in a separate transaction and
 *      never blocks the queue (D17). A TRANSIENT database error (a pool or
 *      transaction timeout, a dropped connection, a deadlock, a lost CAS) is
 *      not the event's fault: nothing is recorded, the tick stops triaging
 *      there (so the batch is not drained and the floor cannot pass the
 *      event), and the next tick retries it — up to TRIAGE_TRANSIENT_ATTEMPTS
 *      ticks, after which it is recorded `failed` so a poison event still
 *      cannot block the queue.
 *      WARP-2980 P5 PR-B: once an event's triage transaction has COMMITTED
 *      and grouped it (opened or joined), the pattern rules judge it
 *      (security-pattern-rules.ts, `flagPatterns`): trial flags, written
 *      after the commit and unable to throw, so a pattern bug can never turn
 *      a detection `failed` and drop its after-hours alert. The context
 *      (the ready build, learning states, area versions, expected activity)
 *      is read once, on the tick's first grouped event; what was judged,
 *      paused or failed is counted per site date at the end of the triage.
 *   3. Floor. Advanced only when the batch drained AND the floor candidate was
 *      seen at least FLOOR_SETTLE_MS ago: every id at or below a head read two
 *      minutes ago is committed or rolled back by now (every SecurityEvent
 *      writer's transaction ends within 60 s — security-event-writers.test.ts
 *      pins the writer list), and everything visible in (floor, head] has just
 *      been triaged. A late-committing row below the head is therefore still
 *      found by the anti-join, never skipped.
 *   4. Timers. camera_offline for every collecting incident with an offline
 *      member not yet judged.
 *   5. Seal. `collecting` → `closed` once event-time quiet + settle AND the
 *      settle after the last arrival have passed — and only when the backlog
 *      drained this tick, so queued events are never shut out of their own
 *      incident. camera_offline is judged once more first. A sealed incident
 *      never reopens (D22). PR-D: an incident holding the ongoing row of a
 *      person still in view is not sealed while their `end` row could still
 *      join it (within MAX_SPAN_MS of its first activity) — one visit, one
 *      incident, one alert. Who holds what is `presenceHolds`
 *      (security-inflight.ts), the same answer a camera-limited viewer's
 *      "still happening" reads (security-incident-view.ts).
 *   6. Notify (security-alerts.service.ts), then redeliver stuck notices.
 *   7. Health: lastOkAt when 1–6 completed; alerts health every 6th tick.
 *      A failed `incident.alerted` audit from step 6 is rethrown only after
 *      all of this (review #8) — it is an audit problem, not a sorting one.
 *
 * Every incident write is a compare-and-set on `version`, with one re-read
 * and re-plan on a lost race: two overlapping handlers (the lock makes that
 * rare) make the loser roll back, never double-count.
 *
 * Canary (WARP-2203): no `next…` / `…Cursor` keys in this file.
 */
import type { Prisma, PrismaClient, SecurityIncident, SecurityZoneKind } from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { SecurityHealthRow } from "./security-events.service.js";
import type { EffectiveAccessResolver } from "../middleware/feature-gate.js";
import {
  buildZoneIndex,
  loadActiveLinks,
  matchAreasForEvent,
  parseLinkRef,
  zonesForEvent,
  type ActiveZoneLink,
  type ZoneIndex,
  type ZoneMatchableEvent,
} from "./security-zones.service.js";
import { loadSiteHours } from "./security-mode.service.js";
import { recordSecurityEvent } from "./security-events.service.js";
import { frigateOngoingToDraft } from "./security-event-ingest.js";
import { presenceHolds, type OngoingSource } from "./security-inflight.js";
import { notifyPendingIncidents, recomputeAlertsHealth, redeliverStuckNotices } from "./security-alerts.service.js";
import {
  PatternTally,
  flagPatterns,
  loadPatternContextSafe,
  recordPatternDays,
  type GroupedInto,
  type PatternContext,
} from "./security-pattern-rules.js";
import { READ_COMMITTED_TX, REPEATABLE_READ_TX } from "../lib/prisma-tx.js";
import {
  RULESET,
  SECURITY_RULESET_VERSION,
  QUIET_MS,
  SETTLE_MS,
  MAX_SPAN_MS,
  afterHoursPresence,
  cameraOfflineDuringActivity,
  cameraOfflineVerdict,
  capEvidence,
  eventSpan,
  joinPatch,
  onlineKindFor,
  openingFields,
  parseActivityRef,
  planTriage,
  reasonPatch,
  scopeFor,
  threatSignal,
  type ReasonDraft,
  type ReasonState,
  type ScopeDecision,
  type TriageEvent,
} from "../lib/security-rules.js";
import { modeAt, parseModeRow, type ModeHistoryRow, type ModeTimeline } from "../lib/security-mode-history.js";
import type { ModeFields } from "../lib/security-mode.js";
import { siteDayClockCopy, type SiteHours } from "../lib/security-hours.js";
import { isValidIanaZone } from "../lib/zoned-time.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-incidents");

export const SECURITY_INCIDENT_INTERVAL_MS = 10_000;
export const SECURITY_INCIDENT_LOCK_KEY = "droplet:security-incidents";
/** Events triaged per tick at most. */
export const TRIAGE_BATCH = 200;
/** A tick stops triaging after this long — well inside the cron lock transaction's 60 s. */
export const TICK_BUDGET_MS = 30_000;
/**
 * Review #6 — nothing new is started after this (no notify, no delivery, no
 * redelivery): with one push dial of at most 10 s still in flight, the tick
 * ends inside the cron lock transaction's 60 s.
 */
export const TICK_DEADLINE_MS = 45_000;
/** The floor only advances to a head seen at least this long ago (§6.1 step 3). */
export const FLOOR_SETTLE_MS = 120_000;
/** The grouping numbers (D13) and the evidence cap live with the rules they belong to (lib/security-rules.ts). */
export { QUIET_MS, SETTLE_MS, MAX_SPAN_MS, EVIDENCE_PER_CAMERA } from "../lib/security-rules.js";
/** camera_offline: a camera must stay down this long (§6.5) — the ruleset's number. */
export const OFFLINE_MIN_MS = RULESET.camera_offline.minOfflineMs;
/** A coded incident is kept a year; plain activity follows its events (D30). */
export const SECURITY_INCIDENT_RETENTION_DAYS = 365;
/** `incidents` health: registered longer than this with no completed tick reads down (§6.11). */
export const INCIDENT_HEALTH_STALE_MS = 120_000;
/** The alerts health row is recomputed on the first tick and every this-many ticks after (§6.11). */
export const ALERTS_HEALTH_EVERY_TICKS = 6;
/** Ticks an event may fail TRANSIENTLY before it is recorded `failed` (review #3). */
export const TRIAGE_TRANSIENT_ATTEMPTS = 3;

const SINGLETON = "singleton";
const DAY_MS = 86_400_000;

/** What index.ts hands the engine (spec §6.1). */
export interface SecurityIncidentDeps {
  /** The box-wide `security` toggle (D29: incidents are still grouped when it is off; nothing is sent). */
  isSecurityModuleOn: () => Promise<boolean>;
  /** The §9 resolver — alert eligibility is re-checked at send time (§6.7). */
  resolveAccess: EffectiveAccessResolver;
  /**
   * WARP-2978 PR-D — the people Frigate is tracking right now
   * (camera.service's in-flight map). Absent: no early presence, and nothing
   * is held open — every alert waits for Frigate's `end`, as before PR-D.
   */
  ongoing?: OngoingSource;
  now?: () => Date;
}

// ── health (§6.11) ─────────────────────────────────────────────────────────

export interface IncidentHealthState {
  /** Set by `registerSecurityIncidentJobs`. Null = the engine is not running (§7's boot assertion). */
  registeredAt: Date | null;
  /** The last tick that completed every step. */
  lastOkAt: Date | null;
  lastError: { at: Date; message: string } | null;
  /** `failed` triage rows in the last 24 h, counted each tick. */
  failedLastDay: number;
}

const incidentHealth: IncidentHealthState = { registeredAt: null, lastOkAt: null, lastError: null, failedLastDay: 0 };
let ticks = 0;
/** Event id → transient failures so far. In memory: a restart just gives an event its attempts again. */
const transientAttempts = new Map<string, number>();

export function incidentHealthState(): Readonly<IncidentHealthState> {
  return incidentHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetIncidentHealthForTests(): void {
  Object.assign(incidentHealth, {
    registeredAt: null,
    lastOkAt: null,
    lastError: null,
    failedLastDay: 0,
  } satisfies IncidentHealthState);
  ticks = 0;
  transientAttempts.clear();
}

/**
 * The `incidents` row, every viewer (spec §6.11):
 *   · down "Not running" — not registered (§7's boot-time assertion);
 *   · down "Hasn't sorted new events since 2:14 AM" — registered more than
 *     2 min ago and no completed tick in the last 2 min (site-local clock;
 *     without a site zone "for N minutes" — never UTC);
 *   · down "Couldn't sort N events in the last day" — `failed` triage rows;
 *   · ok "Sorting events into incidents". `lastSeenAt` = the last completed tick.
 */
export function incidentHealthRow(health: Readonly<IncidentHealthState>, tz: string | null, now: Date): SecurityHealthRow {
  const lastSeenAt = health.lastOkAt ? health.lastOkAt.toISOString() : null;
  const down = (detail: string): SecurityHealthRow => ({ id: "incidents", state: "down", detail, lastSeenAt });
  if (!health.registeredAt) return down("Not running");
  const nowMs = now.getTime();
  const lastOk = health.lastOkAt;
  if (
    nowMs - health.registeredAt.getTime() > INCIDENT_HEALTH_STALE_MS &&
    (!lastOk || nowMs - lastOk.getTime() > INCIDENT_HEALTH_STALE_MS)
  ) {
    const since = lastOk ?? health.registeredAt;
    return down(
      tz
        ? `Hasn't sorted new events since ${siteDayClockCopy(since, tz, now)}`
        : `Hasn't sorted new events for ${Math.floor((nowMs - since.getTime()) / 60_000)} minutes`,
    );
  }
  if (health.failedLastDay > 0) {
    const n = health.failedLastDay;
    return down(`Couldn't sort ${n} ${n === 1 ? "event" : "events"} in the last day`);
  }
  return { id: "incidents", state: "ok", detail: "Sorting events into incidents", lastSeenAt };
}

/** The site's own zone for health copy, or null (never the process zone, never UTC). */
async function siteZone(prisma: Pick<PrismaClient, "securitySiteHours">): Promise<string | null> {
  const h = await prisma.securitySiteHours.findUnique({ where: { id: SINGLETON }, select: { state: true, timezone: true } });
  return h && h.state === "set" && h.timezone && isValidIanaZone(h.timezone) ? h.timezone : null;
}

/** The row the /security/health handler shows. Never throws. */
export async function securityIncidentsHealth(
  prisma: Pick<PrismaClient, "securitySiteHours">,
  now: Date,
): Promise<SecurityHealthRow> {
  let tz: string | null = null;
  try {
    tz = await siteZone(prisma);
  } catch (err) {
    logger.warn({ err }, "incidents health: the site zone could not be read; minutes instead of a clock time");
  }
  return incidentHealthRow(incidentHealth, tz, now);
}

// ── step 1: the engine's own row ──────────────────────────────────────────

type EngineState = Prisma.SecurityIncidentEngineStateGetPayload<Record<string, never>>;

/**
 * The singleton, created on first sight at the current max id (D16) with
 * INSERT … ON CONFLICT DO NOTHING and a read — never upsert({update:{}}).
 */
export async function ensureEngineState(prisma: PrismaClient, now: Date): Promise<EngineState> {
  const row = await prisma.securityIncidentEngineState.findUnique({ where: { id: SINGLETON } });
  if (row) return row;
  const { _max } = await prisma.securityEvent.aggregate({ _max: { id: true } });
  const start = _max.id ?? 0n;
  await prisma.securityIncidentEngineState.createMany({
    data: [{ id: SINGLETON, startedAtId: start, startedAt: now, triageFloor: start, floorCandidate: start, floorCandidateAt: now }],
    skipDuplicates: true,
  });
  return prisma.securityIncidentEngineState.findUniqueOrThrow({ where: { id: SINGLETON } });
}

// ── the mode timeline (§6.4) ──────────────────────────────────────────────

/** The stored mode row's defaults (what the first write creates). */
const DEFAULT_MODE: ModeFields = { mode: "open", modeSource: "schedule", manualEnd: "none", manualUntil: null };

/**
 * ONE REPEATABLE READ snapshot, in P2b's order (the mode row, then the hours):
 * the stored SecurityModeState, the evaluable hours (null when
 * `loadSiteHours` says ok:false), and every mode_changed row from one second
 * before `from` — plus the one row in force at that edge, so a history answer
 * can say how its mode was set. Creates nothing.
 */
export async function loadModeTimeline(prisma: PrismaClient, from: Date, now: Date): Promise<ModeTimeline> {
  return prisma.$transaction(async (tx) => {
    const stored = await tx.securityModeState.findUnique({ where: { id: SINGLETON } });
    const header = await tx.securitySiteHours.findUnique({ where: { id: SINGLETON } });
    let hours: SiteHours | null = { state: "not_set" };
    if (header) {
      const load = await loadSiteHours(tx, header, now);
      hours = load.ok ? load.hours : null;
    }
    const edge = new Date(from.getTime() - 1000);
    const prior = await tx.securityEvent.findFirst({
      where: { kind: "mode_changed", startedAt: { lt: edge } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { startedAt: true, labels: true },
    });
    const since = await tx.securityEvent.findMany({
      where: { kind: "mode_changed", startedAt: { gte: edge } },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: { startedAt: true, labels: true },
    });
    const rows: ModeHistoryRow[] = [];
    for (const r of prior ? [prior, ...since] : since) {
      const parsed = parseModeRow(r);
      if (parsed) rows.push(parsed);
    }
    const fields: ModeFields = stored
      ? { mode: stored.mode, modeSource: stored.modeSource, manualEnd: stored.manualEnd, manualUntil: stored.manualUntil }
      : DEFAULT_MODE;
    return { stored: fields, hours, rows };
  }, REPEATABLE_READ_TX);
}

// ── step 1b: early presence (PR-D, spec §6.12) ────────────────────────────

/**
 * One `detection_ongoing` row per person tracked for 30 s (the in-flight map
 * decides who is due), through the one writer. A row that already exists (a
 * restart re-learned the person; the key is unique) is found by its key and
 * never written twice; a write that failed is retried next tick. Returns the
 * rows written.
 */
export async function writeOngoingRows(
  prisma: Pick<PrismaClient, "securityEvent">,
  source: OngoingSource,
  now: Date,
): Promise<number> {
  let written = 0;
  for (const o of source.due(now)) {
    const draft = frigateOngoingToDraft(o);
    if (await recordSecurityEvent(prisma, draft)) {
      source.markWritten(o.id);
      written++;
      continue;
    }
    try {
      const stored = await prisma.securityEvent.findUnique({ where: { dedupeKey: draft.dedupeKey }, select: { id: true } });
      if (stored) source.markWritten(o.id);
    } catch (err) {
      logger.warn({ err, dedupeKey: draft.dedupeKey }, "early presence: couldn't check for the ongoing row — retried next tick");
    }
  }
  return written;
}

// ── step 2: triage ─────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

/** The incident columns the join window, the join patch and the reasons read. */
const CANDIDATE_SELECT = {
  id: true,
  grouping: true,
  scope: true,
  zoneKind: true,
  openedInMode: true,
  firstActivityAt: true,
  lastActivityAt: true,
  lastArrivalAt: true,
  eventCount: true,
  countsByCamera: true,
  cameras: true,
  spanByCamera: true,
  severity: true,
  reasonCodes: true,
  state: true,
  notifyState: true,
  alertedAt: true,
  version: true,
} as const satisfies Prisma.SecurityIncidentSelect;

type Candidate = Prisma.SecurityIncidentGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/** Lost the incident's CAS twice: the event is recorded `failed` (D17), never looped on. */
export class IncidentConflictError extends Error {
  constructor(incidentId: string) {
    super(`the incident ${incidentId} changed twice while this event was being added`);
    this.name = "IncidentConflictError";
  }
}

interface TriageContext {
  links: readonly ActiveZoneLink[];
  timeline: ModeTimeline;
  now: Date;
}

export type TriageResult = "low" | "context" | "opened" | "joined" | "already";

/** What `triageOne` did, and — for `opened` / `joined` — where the event went (the pattern rules' input). */
export interface TriageOutcome {
  result: TriageResult;
  grouped: GroupedInto | null;
}

/**
 * The reasons an event earns at triage (after_hours_presence, threat_signal).
 * camera_offline and camera_offline_during_activity are the timers' (§6.5).
 * `personLinked` (WARP-2979): the event's primary area was matched through a
 * link a PERSON made or kept — the only way after_hours_presence can fire.
 */
async function triageReasons(
  tx: Tx,
  event: TriageEvent,
  scope: { scope: SecurityIncident["scope"]; zoneKind: SecurityZoneKind | null; personLinked: boolean },
  timeline: ModeTimeline,
): Promise<ReasonDraft[]> {
  const out: ReasonDraft[] = [];
  const ahp = afterHoursPresence({ scope: scope.scope, zoneKind: scope.zoneKind, personLinked: scope.personLinked, event, timeline });
  if (ahp) out.push(ahp);
  if (event.kind === "threat") {
    const id = parseActivityRef(event.sourceRef);
    const row = id === null ? null : await tx.activityRow.findUnique({ where: { id }, select: { sub: true } });
    const t = threatSignal(event, row);
    if (t) out.push(t);
  }
  return out;
}

function reasonRows(incidentId: string, drafts: readonly ReasonDraft[]): Prisma.SecurityIncidentReasonCreateManyInput[] {
  return drafts.map((d) => ({
    incidentId,
    code: d.code,
    severity: d.severity,
    rulesetVersion: SECURITY_RULESET_VERSION,
    evidenceEventId: d.evidenceEventId,
    evidenceCamera: d.evidenceCamera,
    evidenceSource: d.evidenceSource as Prisma.SecurityIncidentReasonCreateManyInput["evidenceSource"],
    evidenceKind: d.evidenceKind as Prisma.SecurityIncidentReasonCreateManyInput["evidenceKind"],
    evidenceLabel: d.evidenceLabel,
    evidenceAt: d.evidenceAt,
    evidenceSummary: d.evidenceSummary,
    detail: d.detail,
    // WARP-2979 — where the person was seen (camera_offline_during_activity); CHECK SecurityIncidentReason_related.
    relatedCamera: d.relatedCamera ?? null,
  }));
}

const PLAIN: ReasonState = { severity: "info", reasonCodes: [], state: "no_action", notifyState: "not_needed", alertedAt: null };

/**
 * Review R4 — late evidence. `pending` is set when an incident first reaches
 * alert; a person the notifier skipped then because they could see none of
 * its evidence (`skipped_not_visible`) would never hear of it again. So an
 * alert already notified (`done`) that gains alert evidence on a camera none
 * of its alert evidence was on goes back to `pending` while such a notice
 * exists — and the notifier re-plans exactly those people
 * (security-alerts.service). `module_off` and `failed` are left alone; so is
 * an incident not yet notified (`pending` already plans everyone).
 */
async function lateEvidencePatch(
  tx: Tx,
  i: Pick<Candidate, "id" | "severity" | "notifyState">,
  existing: ReadonlyArray<{ severity: string; evidenceCamera: string | null }>,
  kept: readonly ReasonDraft[],
): Promise<{ notifyState?: "pending" }> {
  if (i.severity !== "alert" || i.notifyState !== "done") return {};
  const had = new Set(existing.filter((r) => r.severity === "alert").map((r) => r.evidenceCamera));
  if (!kept.some((d) => d.severity === "alert" && d.evidenceCamera !== null && !had.has(d.evidenceCamera))) return {};
  const skipped = await tx.securityIncidentNotice.count({ where: { incidentId: i.id, outcome: "skipped_not_visible" } });
  return skipped > 0 ? { notifyState: "pending" } : {};
}

/**
 * Triage ONE event in ONE READ COMMITTED transaction (§6.2–6.5): its scope,
 * the incident it joins (CAS on version, one re-read on a lost race) or opens,
 * the reasons it earns, and its triage row — together or not at all. The
 * triage row is written last: if another engine triaged the event first, its
 * PK makes this transaction roll back.
 */
export async function triageOne(
  prisma: PrismaClient,
  event: TriageEvent & ZoneMatchableEvent,
  ctx: TriageContext,
): Promise<TriageOutcome> {
  const decision: ScopeDecision = scopeFor(event, event.camera ? matchAreasForEvent(event, ctx.links) : []);
  const span = eventSpan(event);
  const mode = modeAt(ctx.timeline, span.s).mode;
  return prisma.$transaction(async (tx) => {
    if (await tx.securityEventTriage.findUnique({ where: { eventId: event.id }, select: { eventId: true } })) {
      return { result: "already", grouped: null };
    }
    const ledger = async (outcome: "low" | "context" | "grouped", incidentId: string | null) =>
      tx.securityEventTriage.create({
        data: {
          eventId: event.id,
          outcome,
          incidentId,
          matchedLinkIds: outcome === "grouped" && decision.outcome === "group" ? decision.matchedLinkIds : [],
          alsoZoneIds: outcome === "grouped" && decision.outcome === "group" ? decision.alsoZoneIds : [],
          rulesetVersion: SECURITY_RULESET_VERSION,
        },
        select: { eventId: true },
      });

    for (let attempt = 0; attempt < 2; attempt++) {
      const candidates: Candidate[] =
        decision.outcome === "group"
          ? await tx.securityIncident.findMany({
              where: {
                grouping: "collecting",
                scope: decision.key.scope,
                zoneId: decision.key.zoneId,
                scopeCamera: decision.key.scopeCamera,
              },
              select: CANDIDATE_SELECT,
            })
          : [];
      const plan = planTriage(decision, candidates, span, mode);
      if (plan.action === "low" || plan.action === "context") {
        await ledger(plan.action, null);
        return { result: plan.action, grouped: null };
      }
      if (decision.outcome !== "group") throw new Error("unreachable: a join or open without a scope");

      if (plan.action === "open") {
        const area = decision.area;
        const drafts = await triageReasons(
          tx,
          event,
          { scope: decision.key.scope, zoneKind: area?.zoneKind ?? null, personLinked: area?.personLinked ?? false },
          ctx.timeline,
        );
        const kept = capEvidence([], drafts);
        const created = await tx.securityIncident.create({
          data: {
            scope: decision.key.scope,
            zoneId: decision.key.zoneId,
            zoneName: area?.zoneName ?? null,
            zoneKind: area?.zoneKind ?? null,
            zoneLinkIds: area
              ? ctx.links
                  .filter((l) => l.zoneId === area.zoneId)
                  .map((l) => l.linkId)
                  .sort()
              : [],
            scopeCamera: decision.key.scopeCamera,
            openedInMode: mode,
            rulesetVersion: SECURITY_RULESET_VERSION,
            openedAt: ctx.now,
            stateChangedAt: ctx.now,
            ...openingFields(event, span),
            // Every list column is written explicitly: Prisma stores an omitted
            // scalar list as NULL, which SecurityIncident_scope_shape refuses.
            reasonCodes: [],
            ...reasonPatch(PLAIN, kept, ctx.now),
          },
          select: { id: true },
        });
        if (kept.length > 0) await tx.securityIncidentReason.createMany({ data: reasonRows(created.id, kept), skipDuplicates: true });
        await ledger("grouped", created.id);
        return { result: "opened", grouped: { incidentId: created.id, key: decision.key, zoneKind: area?.zoneKind ?? null, mode } };
      }

      const i = plan.incident;
      const existing = await tx.securityIncidentReason.findMany({
        where: { incidentId: i.id },
        select: { code: true, severity: true, evidenceCamera: true, evidenceEventId: true },
      });
      // The event's primary area IS the incident's (the candidate query is keyed on it).
      const drafts = await triageReasons(
        tx,
        event,
        { scope: i.scope, zoneKind: i.zoneKind, personLinked: decision.area?.personLinked ?? false },
        ctx.timeline,
      );
      const kept = capEvidence(existing, drafts);
      const late = await lateEvidencePatch(tx, i, existing, kept);
      const { count } = await tx.securityIncident.updateMany({
        where: { id: i.id, version: i.version, grouping: "collecting" },
        data: { ...joinPatch(i, event, span), ...reasonPatch(i, kept, ctx.now), ...late, version: { increment: 1 } },
      });
      if (count !== 1) continue;
      if (kept.length > 0) await tx.securityIncidentReason.createMany({ data: reasonRows(i.id, kept), skipDuplicates: true });
      await ledger("grouped", i.id);
      // decision.key is the incident's (the candidate query); its mode is the event's (fitsIncident).
      return { result: "joined", grouped: { incidentId: i.id, key: decision.key, zoneKind: i.zoneKind, mode: i.openedInMode } };
    }
    throw new IncidentConflictError(
      decision.outcome === "group" ? `${decision.key.scope}:${decision.key.zoneId ?? decision.key.scopeCamera ?? "site"}` : "?",
    );
  }, READ_COMMITTED_TX);
}

/**
 * Step 2's candidates: the events in (floor, head] with no triage row, in id
 * order, at most TRIAGE_BATCH. Spec §6.1 asks for a NOT EXISTS anti-join;
 * Prisma 5.22 emits `LEFT JOIN "SecurityEventTriage" … WHERE "eventId" IS
 * NULL` (never `NOT IN`), which Postgres plans as the same anti-join (review
 * #5: a Hash Anti Join over 100k triaged rows at floor 0, a Nested Loop Anti
 * Join on the two primary keys at a realistic floor). The pg lane EXPLAINs
 * this exact query and fails if a Prisma upgrade ever changes that.
 */
export function triageCandidates(prisma: Pick<PrismaClient, "securityEvent">, floor: bigint, head: bigint) {
  return prisma.securityEvent.findMany({
    where: { id: { gt: floor, lte: head }, triage: { is: null } },
    orderBy: { id: "asc" },
    take: TRIAGE_BATCH,
  });
}

/** Prisma error codes that say nothing about the event: the pool, the connection, the transaction. */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set([
  "P1001", // can't reach the database server
  "P1002", // the database server timed out
  "P1008", // operation timed out
  "P1017", // the server closed the connection
  "P2024", // timed out fetching a connection from the pool
  "P2028", // transaction API error (expired, or could not start within maxWait)
  "P2034", // write conflict or deadlock — retry
]);

/** SQLSTATE classes that are about the server, not the row: connection (08), rollback (40 — deadlock, serialization), resources (53), operator intervention (57P). */
const TRANSIENT_SQLSTATE = /^(08|40|53|57P)/;

/**
 * Whether a triage failure is the database's, not the event's (review #3).
 * Keyed on Prisma's code, a raw query's SQLSTATE, or — for an unknown request
 * error, which carries the SQLSTATE only in its message — the message text.
 */
export function isTransientTriageError(err: unknown): boolean {
  if (err instanceof IncidentConflictError) return true;
  const e = err as { code?: unknown; name?: unknown; meta?: { code?: unknown }; message?: unknown } | null | undefined;
  if (!e) return false;
  if (e.name === "PrismaClientInitializationError" || e.name === "PrismaClientRustPanicError") return true;
  if (typeof e.code === "string" && TRANSIENT_PRISMA_CODES.has(e.code)) return true;
  if (typeof e.meta?.code === "string" && TRANSIENT_SQLSTATE.test(e.meta.code)) return true;
  if (e.name === "PrismaClientUnknownRequestError" && typeof e.message === "string") {
    const m = /code: "([0-9A-Z]{5})"/.exec(e.message);
    if (m && TRANSIENT_SQLSTATE.test(m[1]!)) return true;
  }
  return false;
}

/** A triage that threw: its `failed` row, in its own transaction. False when the event already had a row (another engine won). */
async function recordFailed(prisma: PrismaClient, eventId: bigint, err: unknown): Promise<boolean> {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\u0000/g, "").slice(0, 500) || "unknown error";
  const { count } = await prisma.securityEventTriage.createMany({
    data: [{ eventId, outcome: "failed", incidentId: null, matchedLinkIds: [], alsoZoneIds: [], rulesetVersion: SECURITY_RULESET_VERSION, error: message }],
    skipDuplicates: true,
  });
  return count > 0;
}

// ── steps 4–5: reasons after triage, and sealing ──────────────────────────

const OFFLINE_KINDS = ["camera_offline", "source_offline"] as const;

/**
 * WARP-2979 — what camera_offline_during_activity reads besides the incident:
 * every active link (with who set it), the person-only matcher over them, and
 * the mode timeline back to the earliest offline member. Loaded once per tick,
 * only when some collecting incident has an offline member.
 */
export interface OfflineRuleContext {
  links: readonly ActiveZoneLink[];
  personIndex: ZoneIndex;
  timeline: ModeTimeline;
}

/** How far before a drop a sighting may have STARTED and still overlap the window (a long visit). */
const ACTIVITY_LOOKBACK_MS = MAX_SPAN_MS;
/** At most this many candidate sightings are read per drop (the latest ones). */
const ACTIVITY_ROWS = 200;

/**
 * camera_offline_during_activity for one offline member (§6.7.2): Areas(C) from
 * the PERSON-set links on C (a part of C counts), the person sightings on every
 * camera person-linked to those areas — read from the store by (camera,
 * startedAt), not from the incident's members, so activity that went to
 * another incident still counts — each matched through the person-only index.
 */
async function activityReason(
  prisma: PrismaClient | Tx,
  event: TriageEvent,
  onlines: ReadonlyArray<{ startedAt: Date }>,
  now: Date,
  ctx: OfflineRuleContext,
): Promise<ReasonDraft | null> {
  if (event.kind !== "camera_offline" || event.camera === null) return null;
  const personAreas = new Map<string, string>();
  for (const l of ctx.links) {
    if (l.setBy === "person" && parseLinkRef(l.sourceKind, l.sourceRef)?.camera === event.camera) personAreas.set(l.zoneId, l.zoneName);
  }
  if (personAreas.size === 0) return null;
  const cameras = [
    ...new Set(
      ctx.links
        .filter((l) => l.setBy === "person" && personAreas.has(l.zoneId))
        .map((l) => parseLinkRef(l.sourceKind, l.sourceRef)?.camera)
        .filter((c): c is string => c !== undefined),
    ),
  ].sort();
  const rule = RULESET.camera_offline_during_activity;
  const drop = event.startedAt.getTime();
  const rows = await prisma.securityEvent.findMany({
    where: {
      camera: { in: cameras },
      kind: { in: [...rule.kinds] },
      labels: { has: rule.label },
      startedAt: { gte: new Date(drop - rule.activityBeforeMs - ACTIVITY_LOOKBACK_MS), lte: new Date(drop + rule.activityAfterMs) },
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: ACTIVITY_ROWS,
  });
  return cameraOfflineDuringActivity({
    offline: event,
    onlines,
    now,
    personAreas,
    activity: rows.map((r) => ({ ...r, personZoneIds: zonesForEvent(r, ctx.personIndex) })),
    timeline: ctx.timeline,
  });
}

/**
 * The timer drafts for one incident's offline members that no reason covers
 * yet (§6.5): camera_offline, and (WARP-2979, with `ctx`)
 * camera_offline_during_activity — each judged per member, once.
 */
async function offlineReasons(
  prisma: PrismaClient | Tx,
  incidentId: string,
  now: Date,
  ctx: OfflineRuleContext | null,
): Promise<ReasonDraft[]> {
  const members = await prisma.securityEventTriage.findMany({
    where: { incidentId, outcome: "grouped", event: { is: { kind: { in: [...OFFLINE_KINDS] } } } },
    select: { event: true },
  });
  if (members.length === 0) return [];
  const covered = await prisma.securityIncidentReason.findMany({
    where: { incidentId, code: { in: ["camera_offline", "camera_offline_during_activity"] } },
    select: { code: true, evidenceEventId: true },
  });
  const judged = new Set(covered.filter((r) => r.code === "camera_offline").map((r) => r.evidenceEventId.toString()));
  const judgedActivity = new Set(covered.filter((r) => r.code === "camera_offline_during_activity").map((r) => r.evidenceEventId.toString()));
  const out: ReasonDraft[] = [];
  for (const { event } of members) {
    const id = event.id.toString();
    const wantActivity = ctx !== null && event.kind === "camera_offline" && event.camera !== null && !judgedActivity.has(id);
    if (judged.has(id) && !wantActivity) continue;
    const onlines = await prisma.securityEvent.findMany({
      where: { camera: event.camera, kind: onlineKindFor(event.kind), startedAt: { gte: event.startedAt } },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: 3,
      select: { startedAt: true },
    });
    if (!judged.has(id)) {
      const v = cameraOfflineVerdict(event, onlines, now);
      if (v.verdict === "fire") out.push(v.reason);
    }
    if (wantActivity) {
      const d = await activityReason(prisma, event, onlines, now, ctx!);
      if (d) out.push(d);
    }
  }
  return out;
}

/**
 * Add the timers' reasons to one collecting incident and, when `seal`, close
 * it — ONE READ COMMITTED transaction, CAS on version with one re-read.
 * Returns whether anything was written.
 */
async function updateCollecting(
  prisma: PrismaClient,
  incidentId: string,
  now: Date,
  seal: boolean,
  ctx: OfflineRuleContext | null,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const i = await tx.securityIncident.findUnique({ where: { id: incidentId }, select: CANDIDATE_SELECT });
      if (!i || i.grouping !== "collecting") return false;
      if (seal && !sealDue(i, now)) return false;
      const existing = await tx.securityIncidentReason.findMany({
        where: { incidentId },
        select: { code: true, evidenceCamera: true, evidenceEventId: true },
      });
      const kept = capEvidence(existing, await offlineReasons(tx, incidentId, now, ctx));
      const patch = reasonPatch(i, kept, now);
      if (!seal && Object.keys(patch).length === 0 && kept.length === 0) return false;
      const { count } = await tx.securityIncident.updateMany({
        where: { id: incidentId, version: i.version, grouping: "collecting" },
        data: { ...patch, ...(seal ? { grouping: "closed" as const, closedAt: now } : {}), version: { increment: 1 } },
      });
      if (count !== 1) continue;
      if (kept.length > 0) await tx.securityIncidentReason.createMany({ data: reasonRows(incidentId, kept), skipDuplicates: true });
      return true;
    }
    return false;
  }, READ_COMMITTED_TX);
}

/** §6.1 step 5's two clocks: event-time quiet + settle, and the settle after the last arrival. */
function sealDue(i: Pick<Candidate, "lastActivityAt" | "lastArrivalAt">, now: Date): boolean {
  const t = now.getTime();
  return t >= i.lastActivityAt.getTime() + QUIET_MS + SETTLE_MS && t >= i.lastArrivalAt.getTime() + SETTLE_MS;
}

// ── the tick ──────────────────────────────────────────────────────────────

export interface TickResult {
  triaged: number;
  failed: number;
  drained: boolean;
  floorAdvanced: boolean;
  sealed: number;
}

export interface TickOptions {
  /** Wall-clock budget for triage; TICK_BUDGET_MS by default. */
  budgetMs?: number;
}

/** One tick (steps 1–7 above). Throws into safeRun's canary; `lastError` says why. */
export async function tickSecurityIncidents(
  prisma: PrismaClient,
  deps: SecurityIncidentDeps,
  opts: TickOptions = {},
): Promise<TickResult> {
  const now = deps.now?.() ?? new Date();
  const startedAt = Date.now();
  const deadline = startedAt + (opts.budgetMs ?? TICK_BUDGET_MS);
  const hardDeadline = startedAt + TICK_DEADLINE_MS;
  ticks++;
  try {
    return await runTick(prisma, deps, now, deadline, () => Date.now() > hardDeadline);
  } catch (err) {
    incidentHealth.lastError = { at: now, message: err instanceof Error ? err.message : String(err) };
    throw err;
  }
}

async function runTick(
  prisma: PrismaClient,
  deps: SecurityIncidentDeps,
  now: Date,
  deadline: number,
  pastHardDeadline: () => boolean,
): Promise<TickResult> {
  // 1. State.
  const state = await ensureEngineState(prisma, now);
  // 1b. Early presence (PR-D) — before triage, so this tick triages the rows.
  if (deps.ongoing) await writeOngoingRows(prisma, deps.ongoing, now);

  // 2. Triage.
  const { _max } = await prisma.securityEvent.aggregate({ _max: { id: true } });
  const head = _max.id ?? state.triageFloor;
  const rows = await triageCandidates(prisma, state.triageFloor, head);
  let triaged = 0;
  let failed = 0;
  let processed = 0;
  if (rows.length > 0) {
    const links = await loadActiveLinks(prisma);
    const from = rows.reduce((m, r) => (r.startedAt < m ? r.startedAt : m), rows[0]!.startedAt);
    const timeline = await loadModeTimeline(prisma, from, now);
    // WARP-2980 PR-B — read on the first grouped event, then shared by the tick.
    let patterns: { ctx: PatternContext; tally: PatternTally } | null = null;
    for (const row of rows) {
      if (Date.now() > deadline) break;
      const key = row.id.toString();
      let grouped: GroupedInto | null = null;
      try {
        const r = await triageOne(prisma, row, { links, timeline, now });
        transientAttempts.delete(key);
        if (r.result !== "already") triaged++;
        grouped = r.grouped;
      } catch (err) {
        if (isTransientTriageError(err)) {
          const attempts = (transientAttempts.get(key) ?? 0) + 1;
          if (attempts < TRIAGE_TRANSIENT_ATTEMPTS) {
            // Not the event's fault. Stop here: the batch is not drained, so
            // neither the floor nor sealing moves past it; the next tick retries.
            transientAttempts.set(key, attempts);
            logger.warn({ err, eventId: key, attempts }, "security incident triage hit a transient database error — retried next tick");
            break;
          }
          transientAttempts.delete(key);
        }
        if (await recordFailed(prisma, row.id, err)) {
          failed++;
          logger.error({ err, eventId: row.id.toString() }, "security incident triage failed — recorded as failed; the queue continues");
        } else {
          logger.debug?.({ eventId: row.id.toString() }, "security incident triage lost to another engine");
        }
      }
      processed++;
      // After the commit, never inside it (D4); flagPatterns never throws.
      if (grouped) {
        patterns ??= { ctx: await loadPatternContextSafe(prisma, now), tally: new PatternTally() };
        await flagPatterns(prisma, row, grouped, patterns.ctx, links, now, patterns.tally);
      }
    }
    if (patterns) await recordPatternDays(prisma, patterns.tally, now);
  }
  const drained = processed === rows.length && rows.length < TRIAGE_BATCH;

  // 3. Floor.
  let floorAdvanced = false;
  if (drained && now.getTime() - state.floorCandidateAt.getTime() >= FLOOR_SETTLE_MS) {
    const candidate = head > state.floorCandidate ? head : state.floorCandidate;
    const { count } = await prisma.securityIncidentEngineState.updateMany({
      where: { id: SINGLETON, triageFloor: state.triageFloor, floorCandidate: state.floorCandidate },
      data: { triageFloor: state.floorCandidate, floorCandidate: candidate, floorCandidateAt: now },
    });
    floorAdvanced = count === 1;
  }

  // 4. Timers: collecting incidents with an offline member.
  const offline = await prisma.securityEventTriage.findMany({
    where: {
      outcome: "grouped",
      incident: { is: { grouping: "collecting" } },
      event: { is: { kind: { in: [...OFFLINE_KINDS] } } },
    },
    select: { incidentId: true, event: { select: { startedAt: true } } },
  });
  // WARP-2979 — camera_offline_during_activity's context, read once, only when needed.
  let offlineCtx: OfflineRuleContext | null = null;
  if (offline.length > 0) {
    const links = await loadActiveLinks(prisma);
    const from = offline.reduce((m, o) => (o.event.startedAt < m ? o.event.startedAt : m), offline[0]!.event.startedAt);
    offlineCtx = { links, personIndex: buildZoneIndex(links, { personOnly: true }), timeline: await loadModeTimeline(prisma, from, now) };
  }
  for (const id of new Set(offline.map((o) => o.incidentId).filter((x): x is string => x !== null))) {
    await updateCollecting(prisma, id, now, false, offlineCtx);
  }

  // 5. Seal — only with the backlog drained.
  let sealed = 0;
  if (drained) {
    const due = await prisma.securityIncident.findMany({
      where: {
        grouping: "collecting",
        lastActivityAt: { lte: new Date(now.getTime() - QUIET_MS - SETTLE_MS) },
        lastArrivalAt: { lte: new Date(now.getTime() - SETTLE_MS) },
      },
      select: { id: true, firstActivityAt: true },
    });
    // PR-D: a person still in view holds their incident open (presenceHolds).
    const held = await presenceHolds(prisma, due, deps.ongoing, now);
    for (const { id } of due) {
      if (held.has(id)) continue;
      if (await updateCollecting(prisma, id, now, true, offlineCtx)) sealed++;
    }
  }

  // 6. Notify, then redeliver — each stops at the tick's hard deadline (review #6).
  const notified = await notifyPendingIncidents(prisma, deps, now, { deadline: pastHardDeadline });
  await redeliverStuckNotices(prisma, now, { deadline: pastHardDeadline });

  // 7. Health.
  incidentHealth.failedLastDay = await prisma.securityEventTriage.count({
    where: { outcome: "failed", triagedAt: { gte: new Date(now.getTime() - DAY_MS) } },
  });
  if (ticks % ALERTS_HEALTH_EVERY_TICKS === 1) await recomputeAlertsHealth(prisma, deps.resolveAccess, now);
  incidentHealth.lastOkAt = now;

  // Review #8: the tick's work is done; an alert's failed audit reaches safeRun now.
  if (notified.auditError !== undefined) throw notified.auditError;
  return { triaged, failed, drained, floorAdvanced, sealed };
}

// ── registration ──────────────────────────────────────────────────────────

/**
 * Register the engine on the cron runtime — every 10 s, single-flighted on
 * SECURITY_INCIDENT_LOCK_KEY — and set `registeredAt`, the `incidents` health
 * row's boot assertion. Not a cron spec (specs fire in process UTC).
 */
export function registerSecurityIncidentJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  prisma: PrismaClient,
  deps: SecurityIncidentDeps,
): void {
  cronRuntime.scheduleInterval(
    SECURITY_INCIDENT_INTERVAL_MS,
    async () => {
      const r = await tickSecurityIncidents(prisma, deps);
      if (r.triaged > 0 || r.failed > 0 || r.sealed > 0) logger.debug?.(r, "security incident tick");
    },
    { lockKey: SECURITY_INCIDENT_LOCK_KEY },
  );
  incidentHealth.registeredAt = new Date();
}

// ── retention (§6.10) ─────────────────────────────────────────────────────

export interface IncidentTrimResult {
  /** Incidents whose `eventsKept` changed. */
  marked: number;
  /** Incidents deleted (plain activity past the events' horizon, coded ones past a year). */
  deleted: number;
}

/**
 * Runs in the 03:50 retention leg right after `trimSecurityEvents`, with the
 * SAME `before` (its events are gone, and their triage rows with them):
 *   1. plain activity (severity info) whose events are all gone and whose
 *      activity ended before `before` is deleted — it follows its events —
 *      unless a person gave it a verdict (WARP-2980 PR-B, D19): precision
 *      needs marks older than the 30-day event horizon, so a marked incident
 *      is kept a year like a coded one. Its pattern flags cascade with it;
 *   2. any incident whose activity ended more than a year ago and whose events
 *      are all gone is deleted (Cascade: its reasons, acks and notices);
 *   3. `eventsKept` follows what is left: `removed` when no member remains,
 *      `partly_removed` when the earliest member was trimmed but some remain —
 *      exact, from the members themselves.
 * Every delete carries `members: {none: {}}`, so the Restrict FK from
 * SecurityEventTriage can never fail the nightly job.
 */
export async function trimSecurityIncidents(prisma: PrismaClient, before: Date, now: Date): Promise<IncidentTrimResult> {
  const plain = await prisma.securityIncident.deleteMany({
    where: { severity: "info", verdict: "unreviewed", lastActivityAt: { lt: before }, members: { none: {} } },
  });
  const old = await prisma.securityIncident.deleteMany({
    where: { lastActivityAt: { lt: new Date(now.getTime() - SECURITY_INCIDENT_RETENTION_DAYS * DAY_MS) }, members: { none: {} } },
  });
  const removed = await prisma.securityIncident.updateMany({
    where: { eventsKept: { not: "removed" }, firstActivityAt: { lt: before }, members: { none: {} } },
    data: { eventsKept: "removed", version: { increment: 1 } },
  });
  const partly = await prisma.securityIncident.updateMany({
    where: { eventsKept: "kept", firstActivityAt: { lt: before }, members: { some: {} } },
    data: { eventsKept: "partly_removed", version: { increment: 1 } },
  });
  return { marked: removed.count + partly.count, deleted: plain.count + old.count };
}
