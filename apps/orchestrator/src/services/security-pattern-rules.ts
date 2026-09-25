/**
 * WARP-2980 (ADR-059 P5 PR-B, p5b spec §4.3, D4–D8, D11, D21) — the pattern
 * rules in the incident engine: which grouped detections are judged, against
 * which cells, and the flags they earn. The rules themselves are pure
 * (lib/security-rules.ts: `patternHits`, `patternSeverity`, `suppressionFor`,
 * `buildPause`, `keyPause`); this file does the I/O.
 *
 * WHEN. After an event's triage transaction COMMITS, in the same engine tick
 * (D4) — never inside it: a P5 bug must never turn a detection `failed`,
 * which would drop its after_hours_presence alert for good. Nothing here
 * throws: a failure is logged and recorded on `patternRuleHealth` (the
 * `patterns` health row's "Couldn't compare new events with what's usual"),
 * and the event stays grouped. A crash between the commit and the flags loses
 * that event's flags (accepted: nothing counts in PR-B). Flags are judged
 * whether or not the Security module is on (DS-015, P3 D29: the toggle
 * decides the surface, not the capture).
 *
 * WHICH EVENTS (D5). A Frigate `detection` with a camera and a Frigate label,
 * grouped into an `area` or `camera` incident — the population the cells
 * count (security-baseline-build.ts). Never `detection_ongoing` (no end; it
 * is counted `_ongoing`), `detection_low`, a status, threat, mode or lock row.
 * The key is the incident's own: `area:<its primary area>` — the area
 * after_hours_presence judges — or `camera:<its camera>`. No fall-back to the
 * camera key when the area key has no cells: that would be another question.
 *
 * THE GATES (D6), in order; a gated event gets no flag, P3 runs unchanged,
 * and the gate is COUNTED (SecurityPatternDay, per site date), so a fortnight
 * with no flag can be told from a fortnight in which nothing was judged:
 *   (a) the site has a zone (not counted: there is no site date to count it
 *       under, and the patterns row already says so);
 *   (b) a ready build exists; (c) it was cut in that zone; (d) it is fresh
 *       (`buildPause`) — read once per tick, on the first grouped detection;
 *   (e) the key has cells for this label (`no_cell`);
 *   (f) an area's cells were built at its current version and hold the
 *       evidence camera; (g) every camera behind the key is `active`
 *       (`keyPause`);
 *   (h) the cell is ready (n′ ≥ 10).
 *
 * THE FLAG (D7–D11, D20). `patternHits` over the three cells (one query, D21:
 * no cache), `k` only when a rate exists; per hit the severity it would
 * carry (the incident's `openedInMode` and area-kind snapshot), and the
 * expected activity that quiets it — checked first, so a quietened flag is
 * recorded (`suppressed`) even in trial. Capped like reasons (5 per code and
 * camera), written with `createMany({skipDuplicates})` on the unique
 * (incident, code, event), so a re-run adds nothing. Every flag is a snapshot:
 * the key, its cameras and the numbers.
 */
import type { PrismaClient, SecurityBaselineState, SecurityMode, SecurityPatternOutcome, SecurityZoneKind } from "@prisma/client";
import { resolveSecurityTimezone } from "./security-mode.service.js";
import { matchAreasForEvent, type ActiveZoneLink, type ZoneMatchableEvent } from "./security-zones.service.js";
import { FRIGATE_NAME } from "./security-event-ingest.js";
import {
  PATTERN_RULES,
  SECURITY_RULESET_VERSION,
  buildPause,
  capEvidence,
  keyPause,
  patternHits,
  patternSeverity,
  suppressionFor,
  type ScopeKey,
  type SuppressionMatchRow,
  type TriageEvent,
} from "../lib/security-rules.js";
import { hourlyRate, isReady, neighbourHours, smoothCounts, type CellCounts } from "../lib/security-baseline-math.js";
import { slotMinutes, slotOf, type BaselineSlot } from "../lib/security-baseline-slots.js";
import { localPartsOf, ymdAddDays } from "../lib/zoned-time.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-pattern-rules");

/** `k` reads at most this many rows (D8): the Poisson tail is monotone in k, so at the cap k = 5000 still flags. */
export const PATTERN_K_CAP = 5000;
/** SecurityPatternDay rows are kept this long (the incidents' own year). */
export const PATTERN_DAY_KEEP_DAYS = 365;

/** Where the engine grouped an event: the incident, its key, and the snapshots the severity reads (D10). */
export interface GroupedInto {
  incidentId: string;
  key: ScopeKey;
  /** The incident's area-kind snapshot; null on a camera incident. */
  zoneKind: SecurityZoneKind | null;
  /** The incident's `openedInMode` — the mode at the event's start (nothing joins across a mode change). */
  mode: SecurityMode;
}

/** An active expected activity, as the engine reads it (`suppressionFor`'s rows). */
export type ActiveSuppression = SuppressionMatchRow;

const SUPPRESSION_MATCH_SELECT = {
  id: true,
  targetKind: true,
  zoneId: true,
  camera: true,
  label: true,
  days: true,
  hourFrom: true,
  hourCount: true,
  codes: true,
  state: true,
  createdAt: true,
  expiresAt: true,
} as const;

/** Every expected activity that can still quiet a flag: active AND not past its expiresAt (a lagging expiry never extends one). */
export async function loadActiveSuppressions(prisma: Pick<PrismaClient, "securitySuppression">, now: Date): Promise<ActiveSuppression[]> {
  return prisma.securitySuppression.findMany({
    where: { state: "active", expiresAt: { gt: now } },
    select: SUPPRESSION_MATCH_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

// ── health (spec D23) ─────────────────────────────────────────────────────

export interface PatternRuleHealth {
  /** The last pattern evaluation (a context read, or one event judged or gated) that completed. */
  lastOkAt: Date | null;
  /**
   * Set when an evaluation throws, cleared by the next one that completes: non-null exactly while
   * the LATEST evaluation failed (several run inside one tick, all stamped with the tick's `now`,
   * so the two times alone could not say which came last). `message` is plain words.
   */
  lastError: { at: Date; message: string } | null;
}

const patternHealth: PatternRuleHealth = { lastOkAt: null, lastError: null };

export function patternRuleHealth(): Readonly<PatternRuleHealth> {
  return patternHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetPatternRulesForTests(): void {
  Object.assign(patternHealth, { lastOkAt: null, lastError: null } satisfies PatternRuleHealth);
}

/** A failure in words the Sources card can show: never an error's own text (it can hold table names). */
export function plainTickError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const code = (err as { code?: unknown } | null)?.code;
  const fromDatabase = name.startsWith("PrismaClient") || (typeof code === "string" && /^P\d{4}$/.test(code));
  return fromDatabase ? "the database couldn't be read" : "something went wrong";
}

function ok(now: Date): void {
  patternHealth.lastOkAt = now;
  patternHealth.lastError = null;
}

function failed(err: unknown, now: Date, what: string): void {
  patternHealth.lastError = { at: now, message: plainTickError(err) };
  logger.error({ err }, `security pattern rules: ${what} — the events stay grouped, no flag is written`);
}

// ── the per-date count (review item 12) ───────────────────────────────────

/** Per (site date, outcome), what this tick's pattern pass did. Written once, at the end of the tick. */
export class PatternTally {
  private readonly counts = new Map<string, number>();

  add(date: string, outcome: SecurityPatternOutcome): void {
    const key = `${date}|${outcome}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  entries(): Array<{ date: string; outcome: SecurityPatternOutcome; n: number }> {
    return [...this.counts].map(([key, n]) => {
      const [date, outcome] = key.split("|") as [string, SecurityPatternOutcome];
      return { date, outcome, n };
    });
  }
}

/**
 * Add the tick's counts to SecurityPatternDay — INSERT … ON CONFLICT DO
 * NOTHING then an increment, never an upsert (Prisma 5 runs it as
 * read-then-insert) — and drop rows older than a year. Never throws: a
 * failure is the patterns row's "Couldn't compare…", because a missing count
 * would read as "nothing was judged".
 */
export async function recordPatternDays(prisma: Pick<PrismaClient, "securityPatternDay">, tally: PatternTally, now: Date): Promise<void> {
  const rows = tally.entries();
  if (rows.length === 0) return;
  try {
    for (const r of rows) {
      await prisma.securityPatternDay.createMany({ data: [{ date: r.date, outcome: r.outcome, count: 0 }], skipDuplicates: true });
      await prisma.securityPatternDay.updateMany({ where: { date: r.date, outcome: r.outcome }, data: { count: { increment: r.n } } });
    }
    const newest = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0]!.date);
    await prisma.securityPatternDay.deleteMany({ where: { date: { lt: ymdAddDays(newest, -PATTERN_DAY_KEEP_DAYS) } } });
  } catch (err) {
    failed(err, now, "couldn't count what the pattern rules judged");
  }
}

// ── the context, once per tick ────────────────────────────────────────────

export type PatternContext =
  | {
      ok: true;
      zone: string;
      build: { id: string; timezone: string; windowFrom: string; windowTo: string };
      /** SecurityBaselineSource: camera → learning state. A camera with no row is not active. */
      cameraState: ReadonlyMap<string, SecurityBaselineState>;
      /** Active areas: id → version (gate f). */
      zoneVersion: ReadonlyMap<string, number>;
      suppressions: readonly ActiveSuppression[];
    }
  | {
      ok: false;
      gate: "no_zone" | "no_build" | "zone_changed" | "stale_build" | "failed";
      /** The site zone when it was read — the date a gated event is counted under. */
      zone: string | null;
    };

/** Gates (a)–(d) and everything the per-event gates read, once per tick (D21). */
export async function loadPatternContext(
  prisma: Pick<PrismaClient, "securitySiteHours" | "workspace" | "securityBaselineBuild" | "securityBaselineSource" | "securityZone" | "securitySuppression">,
  now: Date,
): Promise<PatternContext> {
  const zone = await resolveSecurityTimezone(prisma);
  if (!zone) return { ok: false, gate: "no_zone", zone: null };
  const build = await prisma.securityBaselineBuild.findFirst({
    where: { state: "ready" },
    select: { id: true, timezone: true, windowFrom: true, windowTo: true },
  });
  if (!build) return { ok: false, gate: "no_build", zone };
  const pause = buildPause(zone, build, now);
  if (pause) return { ok: false, gate: pause, zone };
  const [sources, zones, suppressions] = await Promise.all([
    prisma.securityBaselineSource.findMany({ select: { camera: true, state: true } }),
    prisma.securityZone.findMany({ where: { state: "active" }, select: { id: true, version: true } }),
    loadActiveSuppressions(prisma, now),
  ]);
  return {
    ok: true,
    zone,
    build,
    cameraState: new Map(sources.map((s) => [s.camera, s.state])),
    zoneVersion: new Map(zones.map((z) => [z.id, z.version])),
    suppressions,
  };
}

/** `loadPatternContext` that never throws: a failure is recorded, and this tick's grouped detections are counted `failed`. */
export async function loadPatternContextSafe(prisma: Parameters<typeof loadPatternContext>[0], now: Date): Promise<PatternContext> {
  try {
    const ctx = await loadPatternContext(prisma, now);
    ok(now);
    return ctx;
  } catch (err) {
    failed(err, now, "couldn't read what's usual");
    let zone: string | null = null;
    try {
      zone = await resolveSecurityTimezone(prisma);
    } catch {
      // The count needs a site date; without one only the health row says it.
    }
    return { ok: false, gate: "failed", zone };
  }
}

// ── k (D8) ────────────────────────────────────────────────────────────────

/**
 * The detections of this key and label in the event's slot, as known when the
 * event arrived: stored Frigate `detection` rows with `startedAt` in
 * [slot.start, slot.end) and `id ≤ event.id` — Frigate writes on `end`, so an
 * earlier `startedAt` can have a later id, and bounding by startedAt instead
 * would count a visit that ended after this one. An area key keeps a row only
 * when P2b's matcher puts it in the area (a camera's detection outside the
 * linked part of its view is not the area's). `labels[0]` is the label, as
 * the build counts it. The (camera, startedAt) index serves it.
 */
export async function countSlotDetections(
  prisma: Pick<PrismaClient, "securityEvent">,
  q: { keyCameras: readonly string[]; zoneId: string | null; label: string; slot: Pick<BaselineSlot, "start" | "end">; eventId: bigint; links: readonly ActiveZoneLink[] },
): Promise<number> {
  const rows = await prisma.securityEvent.findMany({
    where: {
      source: "frigate",
      kind: "detection",
      camera: { in: [...q.keyCameras] },
      labels: { has: q.label },
      startedAt: { gte: q.slot.start, lt: q.slot.end },
      id: { lte: q.eventId },
    },
    select: { id: true, source: true, kind: true, camera: true, cameraZones: true, labels: true },
    take: PATTERN_K_CAP,
  });
  return rows.filter(
    (r) =>
      r.labels[0] === q.label &&
      (q.zoneId === null || matchAreasForEvent(r as ZoneMatchableEvent, q.links).some((m) => m.zoneId === q.zoneId)),
  ).length;
}

// ── one event ─────────────────────────────────────────────────────────────

const CELL_SELECT = {
  hour: true,
  zoneVersion: true,
  cameras: true,
  daysObserved: true,
  daysWithEvent: true,
  eventCount: true,
  observedMinutes: true,
  dwellSamples: true,
  durationP99Sec: true,
} as const;

const countsOf = (c: { daysObserved: number; daysWithEvent: number; eventCount: number; observedMinutes: number } | undefined): CellCounts | null =>
  c ? { daysObserved: c.daysObserved, daysWithEvent: c.daysWithEvent, eventCount: c.eventCount, observedMinutes: c.observedMinutes } : null;

type FlagDb = Pick<PrismaClient, "securityBaselineCell" | "securityEvent" | "securityPatternFlag">;

/** The kinds the pattern rules judge (every code's `kinds`: `detection` only in v3). */
const JUDGED_KINDS: ReadonlySet<string> = new Set(Object.values(PATTERN_RULES.codes).flatMap((c) => [...c.kinds]));

/**
 * Judge one grouped event and write its flags. Returns the flags written.
 * NEVER throws (D4): everything is inside one try; a failure is recorded on
 * `patternRuleHealth`, counted `failed`, and 0 is returned.
 */
export async function flagPatterns(
  prisma: FlagDb,
  event: TriageEvent & ZoneMatchableEvent,
  grouped: GroupedInto,
  ctx: PatternContext,
  links: readonly ActiveZoneLink[],
  now: Date,
  tally: PatternTally,
): Promise<number> {
  // 1. D5 — the population the cells count.
  const label = event.labels[0];
  if (event.source !== "frigate" || !JUDGED_KINDS.has(event.kind) || event.camera === null || !label || !FRIGATE_NAME.test(label)) return 0;
  const { key } = grouped;
  if (key.scope !== "area" && key.scope !== "camera") return 0;
  const zoneId = key.scope === "area" ? key.zoneId : null;
  const zoneKey = key.scope === "area" ? `area:${key.zoneId}` : `camera:${key.scopeCamera}`;
  const date: string | null = ctx.zone ? localPartsOf(event.startedAt, ctx.zone).ymd : null;
  const count = (outcome: SecurityPatternOutcome) => {
    if (date) tally.add(date, outcome);
  };
  if (!ctx.ok) {
    if (ctx.gate !== "no_zone") count(ctx.gate);
    return 0;
  }
  try {
    // 2. The build's own slot, so the live side and the cells agree.
    const slot = slotOf(event.startedAt, ctx.build.timezone);
    // 3. The three cells, one query (D21); gate (e).
    const hours = neighbourHours(slot.hour);
    const rows = await prisma.securityBaselineCell.findMany({
      where: { buildId: ctx.build.id, zoneKey, label, dayType: slot.dayType, hour: { in: [...hours] } },
      select: CELL_SELECT,
    });
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    const cur = byHour.get(slot.hour);
    if (!cur) {
      count("no_cell");
      ok(now);
      return 0;
    }
    // 4. Gates (f) and (g).
    const pause = keyPause(
      zoneId !== null ? { kind: "area", liveVersion: ctx.zoneVersion.get(zoneId) ?? null } : { kind: "camera" },
      cur,
      ctx.cameraState,
      event.camera,
    );
    if (pause) {
      count(pause);
      ok(now);
      return 0;
    }
    // 5. Gate (h).
    const prev = countsOf(byHour.get(hours[0]));
    const next = countsOf(byHour.get(hours[2]));
    const smoothed = smoothCounts(prev, countsOf(cur), next);
    if (!isReady(smoothed.n)) {
      count("not_ready");
      ok(now);
      return 0;
    }
    count("judged");
    // 6. k, only when there is a rate to judge it against.
    const k =
      hourlyRate(smoothed) === null
        ? null
        : await countSlotDetections(prisma, { keyCameras: cur.cameras, zoneId, label, slot, eventId: event.id, links });
    // 7. The hits, each with its severity and the expected activity that quiets it.
    const durationSec = event.endedAt ? (event.endedAt.getTime() - event.startedAt.getTime()) / 1000 : null;
    const hits = patternHits({
      label,
      durationSec,
      slotMinutes: slotMinutes(slot),
      k,
      cells: { prev, cur: countsOf(cur), next, dwell: { dwellSamples: cur.dwellSamples, durationP99Sec: cur.durationP99Sec } },
    });
    if (hits.length === 0) {
      ok(now);
      return 0;
    }
    const drafts = hits.map((h) => {
      const quiet = suppressionFor({ zoneKey, label, ymd: slot.ymd, hour: slot.hour, code: h.code }, ctx.suppressions, now);
      return {
        incidentId: grouped.incidentId,
        code: h.code,
        // Every pattern code is `trial` in v3 (the tripwire in security-rules.test.ts): PR-D adds `counted`.
        effect: quiet ? ("suppressed" as const) : ("trial" as const),
        severity: patternSeverity(h.code, label, grouped.mode, grouped.zoneKind),
        suppressionId: quiet?.id ?? null,
        rulesetVersion: SECURITY_RULESET_VERSION,
        zoneKey,
        keyCameras: [...cur.cameras],
        evidenceEventId: event.id,
        evidenceCamera: event.camera!,
        evidenceLabel: label,
        evidenceAt: event.startedAt,
        evidenceSummary: event.summary.slice(0, 500),
        detail: {
          dayType: slot.dayType,
          hour: slot.hour,
          windowFrom: ctx.build.windowFrom,
          windowTo: ctx.build.windowTo,
          mode: grouped.mode,
          zoneKind: grouped.zoneKind,
          rulesetVersion: SECURITY_RULESET_VERSION,
          ...h.detail,
        },
      };
    });
    // 8–9. Capped like reasons; a re-run adds nothing.
    const existing = await prisma.securityPatternFlag.findMany({
      where: { incidentId: grouped.incidentId },
      select: { code: true, evidenceCamera: true, evidenceEventId: true },
    });
    const kept = capEvidence(existing, drafts);
    const written = kept.length > 0 ? (await prisma.securityPatternFlag.createMany({ data: kept, skipDuplicates: true })).count : 0;
    ok(now);
    return written;
  } catch (err) {
    count("failed");
    failed(err, now, `couldn't judge event ${event.id.toString()}`);
    return 0;
  }
}
