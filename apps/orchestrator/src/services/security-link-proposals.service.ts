/**
 * WARP-2979 (ADR-059 P4 §6.3, DS-006) — Droplet's link proposals: an hourly
 * job that counts co-occurrence between a source a PERSON placed in an area
 * and every other camera or part of a view, suggests links above a floor and
 * activates links above a higher bar ("Linked by Droplet", one-tap Undo).
 *
 * PR-1 scores the camera ↔ camera arm only (both directions must pass); the
 * lock arm is P4 PR-4, once P2b PR-2's lock rows exist.
 *
 * What it may write, and nothing else (security-link-proposals.imports.test.ts):
 * `SecurityZoneLink` rows it created (`origin = droplet`), the area version it
 * CASes, and one ActivityRow per state change, audited IN the transaction as
 * the system actor (`auditSecuritySystemInTx`, never `ai`: this is counting,
 * not a model). It never removes, rejects, demotes or re-scores an active
 * link, never touches a row a person set, never builds on its own unconfirmed
 * links (anchors are `stateSetBy = person` only), never re-proposes a
 * `removed` or `rejected` source, and never exceeds 32 active links or 8 open
 * suggestions per area (§6.6). `SecurityAiSettings.linking` decides: `off`
 * looks for nothing, `suggest_only` never activates.
 *
 * The tick (§6.3):
 *   1. settings — `off` → done (existing suggestions stay decidable);
 *   2. anchors — active person-set camera / camera_zone links of active areas;
 *   3. ONE load of the window: person `detection` rows (the `(kind,
 *      startedAt)` index), camera and Frigate-wide status rows, Camera rows;
 *   4–5. coverage, blind spells and every score (lib/security-cooccurrence);
 *   6. plan per area against its existing rows (`planLinkChanges`);
 *   7. apply per area in ONE READ_COMMITTED transaction: CAS the area version
 *      (count 0 → skip the area this hour), write the rows — every update
 *      guarded on `{state: <from>, origin: 'droplet', stateSetBy: 'droplet'}`
 *      — then audit each state change LAST. Lock order is P2b's: the area,
 *      then its links, then the chain lock;
 *   8. a 30 s budget: stop at an area boundary and start the next hour after
 *      the last area done (in memory), so no area starves;
 *   9. health: `lastOkAt` and `lastRun`; a throw sets `lastError` and
 *      rethrows into `safeRun`'s canary.
 *
 * DECISION (the spec is silent): an evidence REFRESH on an open suggestion is
 * not a state change — it is written guarded like every other update but does
 * NOT bump the area version (a person with the area's links dialog open must
 * not get a conflict every hour because a number behind a suggestion moved).
 * Only creates and activations CAS the area.
 *
 * Registration: `cronRuntime.scheduleInterval(1 h, tick, {lockKey})`. The work
 * is plain reads plus arithmetic, bounded to 30 s, so it fits the cron lock's
 * 60 s transaction. There is no first tick; health reads "First look by …"
 * for the first hour. `registeredAt` is the `links` health row's boot
 * assertion.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, SecurityAiLinking, SecurityZoneLinkState, SecurityLinkActor } from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { SecurityHealthRow } from "./security-events.service.js";
import { readSecurityAiSettings, SECURITY_AI_SETTINGS_ID, type SecurityAiSettingsView } from "./security-ai-settings.js";
import { auditSecuritySystemInTx, isSecurityAuditUnavailable, stripUnsafeDisplayChars } from "./security-audit.js";
import {
  LINK_RULES,
  LINK_RULES_VERSION,
  blindSpells,
  buildCameraSeries,
  cameraPairEvidence,
  linkWindow,
  scoreCameraPairs,
  type LinkAnchor,
  type PairCandidateResult,
  type PersonSighting,
  type StatusMark,
} from "../lib/security-cooccurrence.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { siteDayClockCopy } from "../lib/security-hours.js";
import { isValidIanaZone } from "../lib/zoned-time.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-link-proposals");

/** Hourly (D8). A bare `scheduleInterval` has no first tick. */
export const SECURITY_LINK_INTERVAL_MS = 3_600_000;
export const SECURITY_LINK_LOCK_KEY = "droplet:security-link-proposals";
/** Work budget per tick: stop at the next area boundary and resume there next hour (rotation). */
export const SECURITY_LINK_BUDGET_MS = 30_000;
/** The `links` row reads down when registered over this long and no run completed within it (§6.15). */
export const LINK_HEALTH_STALE_MS = 70 * 60_000;
/** Open suggestions per area, and new rows per run (§6.3 step 6). */
export const MAX_OPEN_SUGGESTIONS_PER_AREA = 8;
export const MAX_NEW_LINK_ROWS_PER_RUN = 20;
/** Mirrors security-zones.service's SECURITY_ZONE_LINK_LIMIT (route 12's cap): Droplet never exceeds it. */
export const MAX_ACTIVE_LINKS_PER_AREA = 32;

/** What one tick did (health's `lastRun`, and the tick's log line). */
export interface LinkRunSummary {
  /** (anchor, candidate view, direction) scorings — the run's m. */
  scored: number;
  /** New `proposed` rows. */
  proposed: number;
  /** Links made `active` by Droplet (new, or from `proposed`). */
  activated: number;
  /** `proposed` rows whose evidence was refreshed (not a state change; not audited). */
  refreshed: number;
  ms: number;
}

/** In-memory health state (one orchestrator process per box). */
export interface LinkHealthState {
  /** Set by `registerSecurityLinkJobs`. Null = the job is not running (the boot assertion). */
  registeredAt: Date | null;
  /** The last tick that completed (including a `linking = off` tick, which only records this). */
  lastOkAt: Date | null;
  lastError: { at: Date; message: string } | null;
  lastRun: LinkRunSummary | null;
}

const linkHealth: LinkHealthState = { registeredAt: null, lastOkAt: null, lastError: null, lastRun: null };
/** The area the last budget-stopped run finished with; the next run starts after it. */
let resumeAfterZoneId: string | null = null;

export function linkHealthState(): Readonly<LinkHealthState> {
  return linkHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetLinkHealthForTests(): void {
  Object.assign(linkHealth, { registeredAt: null, lastOkAt: null, lastError: null, lastRun: null } satisfies LinkHealthState);
  resumeAfterZoneId = null;
}

// ── health (§6.15) ────────────────────────────────────────────────────────

/**
 * The `links` row, pure. Every viewer; it names no area, camera or incident.
 * `tz` is the site's own zone for clock copy (never UTC; without one,
 * minutes), exactly as P3's incidents row.
 *
 *   · down "Not running" — not registered (the boot assertion);
 *   · down "Couldn't look for links: <reason>" — `lastError` newer than `lastOkAt`;
 *   · down "Hasn't looked for links since 3:14 PM" — registered over 70 min
 *     ago and no completed run in the last 70 min;
 *   · not_configured "Turned off in Security settings" — `linking = off`;
 *   · ok "Looks every hour for cameras that cover your areas" (`link_and_suggest`)
 *     / "…and only suggests them" (`suggest_only`); "First look by 4:14 PM" in
 *     the first hour. `lastSeenAt` = `lastOkAt`.
 */
export function linkHealthRow(
  state: Readonly<LinkHealthState>,
  settings: Pick<SecurityAiSettingsView, "linking"> | null,
  tz: string | null,
  now: Date,
): SecurityHealthRow {
  const lastSeenAt = state.lastOkAt ? state.lastOkAt.toISOString() : null;
  const row = (st: SecurityHealthRow["state"], detail: string): SecurityHealthRow => ({ id: "links", state: st, detail, lastSeenAt });
  if (!state.registeredAt) return row("down", "Not running");
  const lastOk = state.lastOkAt;
  if (state.lastError && (!lastOk || state.lastError.at.getTime() > lastOk.getTime())) {
    return row("down", `Couldn't look for links: ${state.lastError.message}`);
  }
  const nowMs = now.getTime();
  const registeredFor = nowMs - state.registeredAt.getTime();
  if (registeredFor > LINK_HEALTH_STALE_MS && (!lastOk || nowMs - lastOk.getTime() > LINK_HEALTH_STALE_MS)) {
    const since = lastOk ?? state.registeredAt;
    return row(
      "down",
      tz
        ? `Hasn't looked for links since ${siteDayClockCopy(since, tz, now)}`
        : `Hasn't looked for links for ${Math.floor((nowMs - since.getTime()) / 60_000)} minutes`,
    );
  }
  if (settings?.linking === "off") return row("not_configured", "Turned off in Security settings");
  if (!lastOk) {
    const first = new Date(state.registeredAt.getTime() + SECURITY_LINK_INTERVAL_MS);
    return row("ok", tz ? `First look by ${siteDayClockCopy(first, tz, now)}` : "First look within the hour");
  }
  return row(
    "ok",
    settings?.linking === "suggest_only"
      ? "Looks every hour for cameras that cover your areas, and only suggests them"
      : "Looks every hour for cameras that cover your areas",
  );
}

/** The failure's reason for the health row — a fixed phrase, never the raw error (it can name internals). */
function healthReason(err: unknown): string {
  if (isSecurityAuditUnavailable(err)) return "its activity log couldn't be written";
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^P10\d\d$/.test(code)) return "the database didn't answer";
  return "something went wrong on this Droplet";
}

/**
 * The row /security/health shows. NEVER throws: settings or the site zone
 * that cannot be read degrade the row (settings null, minutes instead of a
 * clock time), never the header. A missing settings row reads as its column
 * defaults (link_and_suggest) — that IS what the job would do; nothing is
 * created from a GET.
 */
export async function securityLinksHealth(
  prisma: Pick<PrismaClient, "securityAiSettings" | "securitySiteHours">,
  now: Date,
): Promise<SecurityHealthRow> {
  let settings: Pick<SecurityAiSettingsView, "linking"> | null = null;
  let tz: string | null = null;
  try {
    const row = await prisma.securityAiSettings.findUnique({ where: { id: SECURITY_AI_SETTINGS_ID }, select: { linking: true } });
    settings = { linking: row?.linking ?? "link_and_suggest" };
  } catch (err) {
    logger.warn({ err }, "links health: the AI settings could not be read");
  }
  try {
    const h = await prisma.securitySiteHours.findUnique({ where: { id: "singleton" }, select: { state: true, timezone: true } });
    tz = h && h.state === "set" && h.timezone && isValidIanaZone(h.timezone) ? h.timezone : null;
  } catch (err) {
    logger.warn({ err }, "links health: the site zone could not be read; minutes instead of a clock time");
  }
  return linkHealthRow(linkHealth, settings, tz, now);
}

// ── the plan (§6.3 "Decision per candidate") ──────────────────────────────

/** A link row in one of the anchors' areas, any state. */
export interface ExistingLinkRow {
  id: string;
  zoneId: string;
  sourceKind: string;
  sourceRef: string;
  state: SecurityZoneLinkState;
  origin: SecurityLinkActor;
  stateSetBy: SecurityLinkActor;
}

/** An active area with at least one anchor, as read at the start of the run. */
export interface AreaSnapshot {
  zoneId: string;
  zoneName: string;
  /** The version the apply step CASes on. */
  version: number;
  rows: ExistingLinkRow[];
}

export type PlannedLinkChange =
  | { op: "create"; state: "active" | "proposed"; result: PairCandidateResult }
  | { op: "activate"; row: ExistingLinkRow; result: PairCandidateResult }
  | { op: "refresh"; row: ExistingLinkRow; result: PairCandidateResult };

/** The camera a stored ref points at (`camera` or `camera/part`); null for any other kind. */
function refCamera(sourceKind: string, sourceRef: string): string | null {
  if (sourceKind === "camera") return sourceRef;
  if (sourceKind === "camera_zone") {
    const slash = sourceRef.indexOf("/");
    return slash > 0 ? sourceRef.slice(0, slash) : null;
  }
  return null;
}

/** Droplet's own open suggestion (the CHECK makes every `proposed` row droplet/droplet; the guard says so anyway). */
const isOpenSuggestion = (r: ExistingLinkRow): boolean => r.state === "proposed" && r.origin === "droplet" && r.stateSetBy === "droplet";

/**
 * §6.3's decision table, pure: every area's results in ONE pass, the highest
 * confidence first across the whole run, each against its own area's
 * counters — and the run's 20-new-rows cap is checked BEFORE a create takes an
 * area's slot (review #2418): a create the cap refuses never uses up the
 * area's 32nd active link or 8th suggestion, so an existing suggestion behind
 * it can still be promoted.
 *
 * | existing row      | gate                                          | action                    |
 * | none              | auto, link_and_suggest, < 32 active           | create active             |
 * | none              | auto otherwise, or propose (< 8 open)         | create proposed           |
 * | proposed (droplet)| auto, link_and_suggest, room                  | → active                  |
 * | proposed          | auto or propose otherwise                     | refresh the evidence      |
 * | proposed          | none                                          | leave it                  |
 * | active / removed / rejected (any origin) | any                    | NOTHING, ever             |
 *
 * The last row is enforced twice: `skipCamera` never scores a camera the
 * area holds such a row on, and this planner acts only on open suggestions.
 */
export function planLinkChanges(
  areas: readonly AreaSnapshot[],
  results: readonly PairCandidateResult[],
  linking: Exclude<SecurityAiLinking, "off">,
): Map<string, PlannedLinkChange[]> {
  const plans = new Map<string, PlannedLinkChange[]>();
  const counters = new Map<string, { area: AreaSnapshot; active: number; open: number }>();
  for (const area of areas) {
    plans.set(area.zoneId, []);
    counters.set(area.zoneId, {
      area,
      active: area.rows.filter((r) => r.state === "active").length,
      open: area.rows.filter(isOpenSuggestion).length,
    });
  }
  const ordered = results
    .filter((r) => r.gate !== null && counters.has(r.anchor.zoneId))
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (a.anchor.zoneId < b.anchor.zoneId ? -1 : a.anchor.zoneId > b.anchor.zoneId ? 1 : 0) ||
        (a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0),
    );
  let created = 0;
  for (const r of ordered) {
    const c = counters.get(r.anchor.zoneId)!;
    const plan = plans.get(r.anchor.zoneId)!;
    const cam = r.camera;
    const onCamera = c.area.rows.filter((row) => refCamera(row.sourceKind, row.sourceRef) === cam);
    // Never touch a camera a person (or Droplet's active link) already has a row for.
    if (onCamera.some((row) => !isOpenSuggestion(row))) continue;
    const existing = onCamera.find((row) => row.sourceKind === r.sourceKind && row.sourceRef === r.sourceRef);
    const mayActivate = r.gate === "auto" && linking === "link_and_suggest" && c.active < MAX_ACTIVE_LINKS_PER_AREA;
    if (existing) {
      if (mayActivate) {
        plan.push({ op: "activate", row: existing, result: r });
        c.active += 1;
        c.open -= 1;
      } else {
        plan.push({ op: "refresh", row: existing, result: r });
      }
      continue;
    }
    if (onCamera.length > 0) continue; // a suggestion on another view of this camera stands
    // The run's cap first: a create it refuses takes no slot.
    if (created >= MAX_NEW_LINK_ROWS_PER_RUN) continue;
    if (mayActivate) {
      plan.push({ op: "create", state: "active", result: r });
      c.active += 1;
      created += 1;
    } else if (c.open < MAX_OPEN_SUGGESTIONS_PER_AREA) {
      plan.push({ op: "create", state: "proposed", result: r });
      c.open += 1;
      created += 1;
    }
  }
  return plans;
}

// ── the tick ──────────────────────────────────────────────────────────────

/** Snapshot a camera display name into `sourceLabel` (VarChar(120), cut on code points), as route 12 does. */
function labelSnapshot(label: string): string {
  const cps = [...stripUnsafeDisplayChars(label)];
  return cps.length <= 120 ? cps.join("") : cps.slice(0, 120).join("");
}

/** How the audit line names a view: `Back camera`, or `the "till" part of Back camera`. */
function viewPhrase(r: PairCandidateResult): string {
  return r.part === null ? r.label : `the "${r.part}" part of ${r.label}`;
}

export interface LinkRunOptions {
  /** Monotonic-enough ms clock for the budget. */
  clock?: () => number;
  budgetMs?: number;
}

/**
 * One tick (§6.3). Returns what it did; throws (after nothing, or after the
 * areas already applied — each area is its own transaction) on a failure the
 * caller records in health.
 */
export async function runSecurityLinkProposals(prisma: PrismaClient, now: Date = new Date(), opts: LinkRunOptions = {}): Promise<LinkRunSummary> {
  const clock = opts.clock ?? Date.now;
  const budgetMs = opts.budgetMs ?? SECURITY_LINK_BUDGET_MS;
  const started = clock();
  const summary: LinkRunSummary = { scored: 0, proposed: 0, activated: 0, refreshed: 0, ms: 0 };
  const done = () => ({ ...summary, ms: Math.max(0, clock() - started) });

  // 1. What Droplet may do. `off` looks for nothing; existing suggestions stay decidable.
  const settings = await readSecurityAiSettings(prisma);
  if (settings.linking === "off") return done();
  const linking = settings.linking;

  // 2. Anchors: links a PERSON made or kept, in active areas. Never Droplet's own (§6.2.1).
  const anchorRows = await prisma.securityZoneLink.findMany({
    where: { state: "active", stateSetBy: "person", sourceKind: { in: ["camera", "camera_zone"] }, zone: { state: "active" } },
    select: { id: true, zoneId: true, sourceKind: true, sourceRef: true, sourceLabel: true, zone: { select: { name: true, version: true } } },
    orderBy: [{ zoneId: "asc" }, { sourceKind: "asc" }, { sourceRef: "asc" }],
  });
  if (anchorRows.length === 0) return done();
  const areaIds = [...new Set(anchorRows.map((a) => a.zoneId))].sort();

  // 3. One load: every row in those areas, the window's person sightings and status rows, and the cameras.
  const window = linkWindow(now.getTime());
  const loadFrom = new Date(window.from - LINK_RULES.localChanceMs);
  const loadTo = new Date(window.observedEnd);
  const [rows, detections, statuses, cameras] = await Promise.all([
    prisma.securityZoneLink.findMany({
      where: { zoneId: { in: areaIds } },
      select: { id: true, zoneId: true, sourceKind: true, sourceRef: true, state: true, origin: true, stateSetBy: true },
    }),
    prisma.securityEvent.findMany({
      where: { kind: "detection", labels: { has: "person" }, camera: { not: null }, startedAt: { gte: loadFrom, lte: loadTo } },
      select: { camera: true, cameraZones: true, startedAt: true, endedAt: true },
    }),
    prisma.securityEvent.findMany({
      where: { kind: { in: ["camera_offline", "camera_online", "source_offline", "source_online"] }, startedAt: { gte: loadFrom, lte: loadTo } },
      select: { kind: true, camera: true, startedAt: true },
    }),
    prisma.camera.findMany({ select: { name: true, displayName: true, enabled: true } }),
  ]);
  const labels = new Map(cameras.map((c) => [c.name, c.displayName]));
  const disabled = new Set(cameras.filter((c) => !c.enabled).map((c) => c.name));

  // 4–5. Coverage, blind spells, scores.
  const sightings: PersonSighting[] = detections.map((d) => ({
    camera: d.camera!,
    zones: d.cameraZones,
    startedAt: d.startedAt.getTime(),
    endedAt: d.endedAt ? d.endedAt.getTime() : null,
  }));
  const marks: StatusMark[] = statuses.map((s) => ({
    camera: s.kind === "source_offline" || s.kind === "source_online" ? null : s.camera,
    kind: s.kind === "camera_offline" || s.kind === "source_offline" ? "offline" : "online",
    at: s.startedAt.getTime(),
  }));
  const series = buildCameraSeries(sightings, window);
  const blind = blindSpells(marks, series.keys(), window);
  const areaRows = new Map<string, ExistingLinkRow[]>(areaIds.map((id) => [id, []]));
  for (const r of rows) areaRows.get(r.zoneId)?.push(r);
  const labelOf = (camera: string) => labels.get(camera) ?? camera;
  const anchors: LinkAnchor[] = anchorRows.map((a) => ({
    linkId: a.id,
    zoneId: a.zoneId,
    zoneName: a.zone.name,
    sourceKind: a.sourceKind as "camera" | "camera_zone",
    sourceRef: a.sourceRef,
    label: labelOf(refCamera(a.sourceKind, a.sourceRef) ?? a.sourceRef),
  }));
  const { results, hypotheses } = scoreCameraPairs({
    anchors,
    series,
    blind,
    observedEnd: window.observedEnd,
    skipCamera: (zoneId, camera) =>
      disabled.has(camera) ||
      (areaRows.get(zoneId) ?? []).some((r) => refCamera(r.sourceKind, r.sourceRef) === camera && !isOpenSuggestion(r)),
    pinnedRef: (zoneId, camera) => {
      const open = (areaRows.get(zoneId) ?? [])
        .filter((r) => isOpenSuggestion(r) && refCamera(r.sourceKind, r.sourceRef) === camera)
        .sort((a, b) => (a.sourceRef < b.sourceRef ? -1 : 1))[0];
      return open ? { sourceKind: open.sourceKind as "camera" | "camera_zone", sourceRef: open.sourceRef } : null;
    },
    candidateLabel: labelOf,
  });
  summary.scored = hypotheses;

  // 6. Plan.
  const areas: AreaSnapshot[] = areaIds.map((zoneId) => {
    const a = anchorRows.find((r) => r.zoneId === zoneId)!;
    return { zoneId, zoneName: a.zone.name, version: a.zone.version, rows: areaRows.get(zoneId) ?? [] };
  });
  const plans = planLinkChanges(areas, results, linking);

  // 7–8. Apply per area, in rotation order, within the budget.
  const startAt = resumeAfterZoneId === null ? 0 : areas.findIndex((a) => a.zoneId > resumeAfterZoneId!);
  const order = startAt <= 0 ? areas : [...areas.slice(startAt), ...areas.slice(0, startAt)];
  resumeAfterZoneId = null;
  for (let i = 0; i < order.length; i += 1) {
    const area = order[i]!;
    if (i > 0 && clock() - started > budgetMs) {
      resumeAfterZoneId = order[i - 1]!.zoneId;
      logger.info({ areasLeft: order.length - i }, "security link proposals: out of time; the rest go first next hour");
      break;
    }
    const plan = plans.get(area.zoneId) ?? [];
    if (plan.length === 0) continue;
    const applied = await applyAreaPlan(prisma, area, plan, { now, window, hypotheses });
    summary.proposed += applied.proposed;
    summary.activated += applied.activated;
    summary.refreshed += applied.refreshed;
  }
  return done();
}

/** The link-row fields Droplet's evidence sets (create, activation and refresh alike). */
function evidenceFields(r: PairCandidateResult, ctx: { now: Date; window: ReturnType<typeof linkWindow>; hypotheses: number }) {
  return {
    evidence: cameraPairEvidence(r, { window: ctx.window, hypotheses: ctx.hypotheses }) as unknown as Prisma.InputJsonValue,
    confidence: r.confidence,
    rulesVersion: LINK_RULES_VERSION,
    evidenceAt: ctx.now,
  };
}

/** The guard on every update the job makes: the row is still Droplet's own, in the state the plan read. */
const dropletGuard = (id: string, state: "proposed") => ({ id, state, origin: "droplet" as const, stateSetBy: "droplet" as const });

/** The audit refs of a Droplet state change (integers only: confidence in basis points). */
function auditRefs(zoneId: string, linkId: string, r: PairCandidateResult) {
  return {
    zoneId,
    linkId,
    sourceKind: r.sourceKind,
    sourceRef: r.sourceRef,
    kind: "camera_camera",
    gate: r.gate!,
    confidenceBp: Math.round(r.confidence * 10_000),
    rulesVersion: LINK_RULES_VERSION,
  };
}

/**
 * One area's changes. State changes (creates, activations) run in ONE
 * READ_COMMITTED transaction that CASes the area version first (a lost CAS
 * skips the area: nothing written, nothing audited) and audits LAST.
 * Refreshes are guarded updates with no version bump (the DECISION in the
 * header).
 */
async function applyAreaPlan(
  prisma: PrismaClient,
  area: AreaSnapshot,
  plan: readonly PlannedLinkChange[],
  ctx: { now: Date; window: ReturnType<typeof linkWindow>; hypotheses: number },
): Promise<{ proposed: number; activated: number; refreshed: number }> {
  const out = { proposed: 0, activated: 0, refreshed: 0 };
  const refreshes = plan.filter((c): c is Extract<PlannedLinkChange, { op: "refresh" }> => c.op === "refresh");
  const changes = plan.filter((c) => c.op !== "refresh");

  if (changes.length > 0) {
    const done = await prisma.$transaction(async (tx) => {
      const { count } = await tx.securityZone.updateMany({
        where: { id: area.zoneId, version: area.version, state: "active" },
        data: { version: { increment: 1 } },
      });
      if (count !== 1) return null; // someone changed the area since the read: skip it this hour
      const audits: Array<{ action: "link.proposed" | "link.activated"; what: string; refs: Record<string, unknown> }> = [];
      const creates = changes.filter((c): c is Extract<PlannedLinkChange, { op: "create" }> => c.op === "create");
      if (creates.length > 0) {
        const data = creates.map((c) => ({
          id: randomUUID(),
          zoneId: area.zoneId,
          sourceKind: c.result.sourceKind,
          sourceRef: c.result.sourceRef,
          sourceLabel: labelSnapshot(c.result.label),
          state: c.state,
          origin: "droplet" as const,
          stateSetBy: "droplet" as const,
          createdById: null,
          stateChangedAt: ctx.now,
          ...evidenceFields(c.result, ctx),
        }));
        await tx.securityZoneLink.createMany({ data });
        creates.forEach((c, i) =>
          audits.push(
            c.state === "active"
              ? {
                  action: "link.activated",
                  what: `Security: Droplet linked ${viewPhrase(c.result)} to the area "${area.zoneName}"`,
                  refs: { ...auditRefs(area.zoneId, data[i]!.id, c.result), from: "none" },
                }
              : {
                  action: "link.proposed",
                  what: `Security: Droplet suggested ${viewPhrase(c.result)} for the area "${area.zoneName}"`,
                  refs: auditRefs(area.zoneId, data[i]!.id, c.result),
                },
          ),
        );
      }
      let activated = 0;
      for (const c of changes) {
        if (c.op !== "activate") continue;
        const r = await tx.securityZoneLink.updateMany({
          where: dropletGuard(c.row.id, "proposed"),
          data: { state: "active", stateChangedAt: ctx.now, ...evidenceFields(c.result, ctx) },
        });
        if (r.count !== 1) continue; // decided under us (a person's decision bumps the version, so not reached)
        activated += 1;
        audits.push({
          action: "link.activated",
          what: `Security: Droplet linked ${viewPhrase(c.result)} to the area "${area.zoneName}"`,
          refs: { ...auditRefs(area.zoneId, c.row.id, c.result), from: "proposed" },
        });
      }
      for (const c of refreshes) {
        await tx.securityZoneLink.updateMany({ where: dropletGuard(c.row.id, "proposed"), data: evidenceFields(c.result, ctx) });
      }
      // The audits, LAST (the security-audit contract): a broken chain rolls the whole area back.
      for (const a of audits) await auditSecuritySystemInTx(tx, a);
      return {
        proposed: creates.filter((c) => c.state === "proposed").length,
        activated: creates.filter((c) => c.state === "active").length + activated,
        refreshed: refreshes.length,
      };
    }, READ_COMMITTED_TX);
    if (done) Object.assign(out, done);
    return out;
  }

  for (const c of refreshes) {
    const r = await prisma.securityZoneLink.updateMany({ where: dropletGuard(c.row.id, "proposed"), data: evidenceFields(c.result, ctx) });
    out.refreshed += r.count;
  }
  return out;
}

/** The tick the cron runtime runs: the run, then health. A throw is recorded and rethrown into `safeRun`. */
export async function tickSecurityLinkProposals(prisma: PrismaClient, now: Date = new Date()): Promise<LinkRunSummary> {
  try {
    const run = await runSecurityLinkProposals(prisma, now);
    linkHealth.lastOkAt = now;
    linkHealth.lastRun = run;
    if (run.proposed + run.activated + run.refreshed > 0) logger.info(run, "security link proposals");
    return run;
  } catch (err) {
    linkHealth.lastError = { at: now, message: healthReason(err) };
    throw err;
  }
}

/**
 * Wire the hourly job (index.ts, right after `registerSecurityIncidentJobs`)
 * on its own advisory lock, and set `registeredAt` — the `links` health row's
 * boot assertion.
 */
export function registerSecurityLinkJobs(cronRuntime: Pick<CronRuntime, "scheduleInterval">, prisma: PrismaClient): void {
  cronRuntime.scheduleInterval(
    SECURITY_LINK_INTERVAL_MS,
    async () => {
      await tickSecurityLinkProposals(prisma, new Date());
    },
    { lockKey: SECURITY_LINK_LOCK_KEY },
  );
  linkHealth.registeredAt = new Date();
}
