/**
 * WARP-2980 (ADR-059 P5, spec §6.13, §6.17, §7 routes 29–31) — the read side
 * of "what normal looks like": the overview, one key's cells, and the
 * explanation behind the (PR-E) `security_explain_pattern` tool, which calls
 * `explainSecurityPattern` with the ACTING PERSON's scope (never a service
 * principal's).
 *
 * DS-005 on derived numbers (D22). A cell's numbers are presence data from
 * every camera it was built from, so:
 *   · a camera key exists for a viewer only when they may see that camera;
 *   · an area key exists only when the area is active and visible
 *     (`zoneVisibleTo` over its active links) AND the viewer may see EVERY
 *     camera behind it: the cells' `cameras`, or — for an area with no cells
 *     yet (every area on day 1) — every camera of its current active links.
 *     An empty camera list never passes on its own (review #2352: `every()`
 *     over [] is true, and the explanation then named the hidden camera);
 *   · anything else is absent, and absent answers exactly like missing — the
 *     same `not_found`, the same 404 body — so a hidden area cannot be
 *     probed for.
 *
 * Every number is computed by lib/security-baseline-math.ts — the functions
 * the rules (PR-B) use — so an explanation never disagrees with a flag. And
 * (WARP-2980 PR-B, review item 11) route 31 asks the engine's own pauses
 * (`buildPause`, `keyPause`): while one holds, `paused` says which and every
 * "would flag" is false/null — the engine flags nothing then either. Its
 * `expected` is the active expected activity covering the slot, matched by
 * the engine's own rule (`suppressionCovers`).
 * Bounded: one key, one label, three cells (explain); one key and label
 * (cells); the kept keys and labels of one build (overview). No list is
 * paged, so no WARP-2203 cursor key.
 */
import type { PrismaClient, SecurityBaselineCell } from "@prisma/client";
import type { SecurityViewerScope } from "./security-access.js";
import { resolveSecurityTimezone } from "./security-mode.service.js";
import { loadActiveLinks, loadCameraLabels, parseLinkRef, visibleLinks, zoneVisibleTo, type ActiveZoneLink } from "./security-zones.service.js";
import {
  BASELINE,
  DWELL_MIN_SAMPLES,
  RARITY_MAX_P,
  dwellThresholdSec,
  hourlyRate,
  isRare,
  isReady,
  neighbourHours,
  rarityP,
  slotRate,
  smoothCounts,
  volumeThreshold,
  type CellCounts,
  type PatternCode,
  type PatternRelease,
} from "../lib/security-baseline-math.js";
import { slotMinutes, slotOf } from "../lib/security-baseline-slots.js";
import { PATTERN_RELEASE, buildPause, keyPause, suppressionCovers, type PatternPause, type SuppressionSlot } from "../lib/security-rules.js";
import { localPartsOf } from "../lib/zoned-time.js";
import { siteClockCopy } from "../lib/security-hours.js";

export type LearningState = "learning" | "active" | "stale";

/** Route 29, GET /api/security/patterns. Mirrored in apps/web-dashboard/src/lib/types.ts. */
export interface PatternsOverview {
  state: "not_configured" | "not_built" | "ready";
  reason: "no_timezone" | "no_cameras" | null;
  timezone: string | null;
  window: { from: string; to: string; builtAt: string } | null;
  release: Record<PatternCode, PatternRelease>;
  sources: Array<{
    camera: string;
    label: string;
    state: LearningState;
    daysObserved: number;
    daysNeeded: 14;
    lastSeenAt: string;
    detectionsPerDay: number | null;
  }>;
  keys: Array<{
    zoneKey: string;
    kind: "area" | "camera";
    zoneId: string | null;
    name: string;
    cameras: string[];
    labels: string[];
    learning: boolean;
  }>;
  /** PR-B; always 0 before it. */
  waitingProposals: number;
}

/** One (dayType, hour) of route 30. */
export interface CellView {
  dayType: "weekday" | "weekend";
  hour: number;
  daysObserved: number;
  daysWithEvent: number;
  /** n′ ≥ 10. */
  ready: boolean;
  /** Not usually seen at this hour: ready ∧ p < 0.05 — exactly out_of_place's test. */
  rare: boolean;
  /** λ_hour when ready. */
  typicalPerHour: number | null;
  /** p99 when dwellSamples ≥ 30. */
  longestUsualVisitSec: number | null;
}

/** Route 30, GET /api/security/patterns/cells. */
export interface PatternCellsView {
  key: string;
  label: string;
  window: { from: string; to: string; builtAt: string };
  cells: CellView[];
}

export type PatternCellsResult = { status: "not_found" } | { status: "ok"; view: PatternCellsView };

export interface ExplainPatternQuery {
  /** Exactly one of zoneId | camera. */
  zoneId?: string;
  camera?: string;
  /** Default 'person'. */
  label?: string;
  /** Default now; the slot is cut in the baseline zone. */
  at?: Date;
}

export interface ExplainPatternView {
  key: { zoneKey: string; kind: "area" | "camera"; zoneId: string | null; name: string; cameras: string[] };
  at: { instant: string; local: string; dayType: "weekday" | "weekend"; hour: number; timezone: string };
  window: { from: string; to: string; builtAt: string };
  sources: Array<{ camera: string; state: LearningState; daysObserved: number; daysNeeded: 14; lastSeenAt: string }>;
  cell: {
    ready: boolean;
    daysObserved: number;
    daysWithEvent: number;
    smoothed: { daysObserved: number; daysWithEvent: number };
    rarity: { p: number; flagsBelow: 0.05; wouldFlag: boolean };
    /** Null when the cell holds no observed time (no rate) or is not ready (no flag). */
    volume: { typicalPerHour: number | null; flagsFrom: number | null };
    dwell: { longestUsualVisitSec: number | null; samples: number; wouldFlagAboveSec: number | null };
    neighbours: Array<{ hour: number; daysObserved: number; daysWithEvent: number }>;
  } | null;
  /**
   * WARP-2980 PR-B (review item 11): why the pattern rules are paused for this
   * key right now — the engine's own gates (a build cut in another zone or out
   * of date, the area's links changed since its cells, a camera behind it
   * learning or stale). While set, every "would flag" in `cell` is false/null.
   * Null when nothing pauses them, or there is no cell.
   */
  paused: PatternPause | null;
  /** The active expected activity covering this slot, for any code (PR-B). `text` is the person's reason. */
  expected: Array<{ id: string; text: string; until: string; codes: PatternCode[] }>;
  release: Record<PatternCode, PatternRelease>;
}

export type ExplainPatternResult =
  | { status: "not_found" }
  | { status: "no_timezone" }
  | { status: "not_built" }
  | { status: "ok"; view: ExplainPatternView };

type ReadDb = PrismaClient;
type Scope = Pick<SecurityViewerScope, "visibleCameras">;

const DAYS_NEEDED = BASELINE.learningDays as 14;
const NOT_FOUND = { status: "not_found" } as const;
const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const canSee = (scope: Scope, camera: string) => scope.visibleCameras === "all" || scope.visibleCameras.has(camera);

/** Tracked labels first, in BASELINE order; the rest alphabetically. */
function labelOrder(a: string, b: string): number {
  const fixed: readonly string[] = BASELINE.labels;
  const ia = fixed.indexOf(a);
  const ib = fixed.indexOf(b);
  if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return byString(a, b);
}

async function readyBuild(prisma: ReadDb) {
  return prisma.securityBaselineBuild.findFirst({
    where: { state: "ready" },
    select: { id: true, timezone: true, windowFrom: true, windowTo: true, finishedAt: true },
  });
}

type ReadyBuild = NonNullable<Awaited<ReturnType<typeof readyBuild>>>;

const windowOf = (b: ReadyBuild) => ({ from: b.windowFrom, to: b.windowTo, builtAt: (b.finishedAt ?? new Date(0)).toISOString() });

/** The cameras of an area's current active camera / camera_zone links, sorted, deduped. */
function linkCameras(own: readonly ActiveZoneLink[]): string[] {
  const cams = own.map((l) => parseLinkRef(l.sourceKind, l.sourceRef)?.camera).filter((c): c is string => !!c);
  return [...new Set(cams)].sort(byString);
}

/**
 * DS-005 for one key: the cameras behind it when the viewer may see ALL of
 * them, else null — and the caller answers exactly as for a key that does not
 * exist. `cellCameras` — the `cameras` of the key's cells in the ready build
 * (null or empty when it has none). An area with no cells is judged on every
 * camera of its current active links: an empty list is never "all visible".
 * WARP-2980 PR-B: the expected-activity list (route 32) asks here too, so a
 * place and a person's reason are shown under the same rule as its numbers
 * (review item 9 — one rule, not a second copy).
 */
export function visibleKeyCameras(
  key: { kind: "area"; zoneId: string } | { kind: "camera"; camera: string },
  links: readonly ActiveZoneLink[],
  cellCameras: readonly string[] | null,
  scope: Scope,
): string[] | null {
  if (key.kind === "camera") return canSee(scope, key.camera) ? [key.camera] : null;
  const own = links.filter((l) => l.zoneId === key.zoneId);
  if (own.length === 0) return null; // archived, or no active link: nothing to explain
  if (!zoneVisibleTo({ id: key.zoneId }, own, visibleLinks(own, scope))) return null;
  const cameras = cellCameras && cellCameras.length > 0 ? [...cellCameras] : linkCameras(own);
  if (cameras.length === 0) return null;
  return cameras.every((c) => canSee(scope, c)) ? cameras : null;
}

// ── route 29 ─────────────────────────────────────────────────────────────

export async function readPatternsOverview(prisma: ReadDb, scope: SecurityViewerScope): Promise<PatternsOverview> {
  const [timezone, sourceRows, labels, ready, links] = await Promise.all([
    resolveSecurityTimezone(prisma),
    prisma.securityBaselineSource.findMany(),
    loadCameraLabels(prisma),
    readyBuild(prisma),
    loadActiveLinks(prisma),
  ]);
  const visibleSources = sourceRows.filter((s) => canSee(scope, s.camera));
  const stateOf = new Map(visibleSources.map((s) => [s.camera, s.state as LearningState]));

  let keys: PatternsOverview["keys"] = [];
  const perDay = new Map<string, number | null>();
  if (ready) {
    const [keyRows, eventSums, minuteSums] = await Promise.all([
      // One row per (key, label): every kept pair has all 48 (dayType, hour) rows
      // (pinned by the pg property test). Never Prisma's `distinct`, which
      // Prisma 5 runs in memory over every cell (review #2352).
      prisma.securityBaselineCell.findMany({
        where: { buildId: ready.id, dayType: "weekday", hour: 0 },
        select: { zoneKey: true, keyKind: true, zoneId: true, camera: true, cameras: true, label: true },
      }),
      prisma.securityBaselineCell.groupBy({ by: ["camera"], where: { buildId: ready.id, keyKind: "camera" }, _sum: { eventCount: true } }),
      // One label's 48 cells hold every observed minute once; "person" is always kept.
      prisma.securityBaselineCell.groupBy({
        by: ["camera"],
        where: { buildId: ready.id, keyKind: "camera", label: "person" },
        _sum: { observedMinutes: true },
      }),
    ]);
    const minutes = new Map(minuteSums.map((g) => [g.camera, g._sum.observedMinutes ?? 0]));
    for (const g of eventSums) {
      if (!g.camera) continue;
      const m = minutes.get(g.camera) ?? 0;
      perDay.set(g.camera, m >= 1440 ? (g._sum.eventCount ?? 0) / (m / 1440) : null);
    }

    const zoneNames = new Map(links.map((l) => [l.zoneId, l.zoneName]));
    const byKey = new Map<string, { row: (typeof keyRows)[number]; labels: string[] }>();
    for (const r of keyRows) {
      const entry = byKey.get(r.zoneKey);
      if (entry) entry.labels.push(r.label);
      else byKey.set(r.zoneKey, { row: r, labels: [r.label] });
    }
    for (const { row, labels: kept } of byKey.values()) {
      const key = row.keyKind === "area" ? { kind: "area" as const, zoneId: row.zoneId! } : { kind: "camera" as const, camera: row.camera! };
      if (!visibleKeyCameras(key, links, row.cameras, scope)) continue;
      keys.push({
        zoneKey: row.zoneKey,
        kind: row.keyKind,
        zoneId: row.zoneId,
        name: row.keyKind === "area" ? zoneNames.get(row.zoneId!) ?? "" : labels.get(row.camera!) ?? row.camera!,
        cameras: row.cameras,
        labels: kept.sort(labelOrder),
        learning: row.cameras.some((c) => stateOf.get(c) !== "active"),
      });
    }
    keys = keys.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) || byString(a.zoneKey, b.zoneKey) : a.kind === "area" ? -1 : 1));
  }

  const sources: PatternsOverview["sources"] = visibleSources
    .map((s) => ({
      camera: s.camera,
      label: labels.get(s.camera) ?? s.camera,
      state: s.state as LearningState,
      daysObserved: s.daysObserved,
      daysNeeded: DAYS_NEEDED,
      lastSeenAt: s.lastSeenAt.toISOString(),
      detectionsPerDay: perDay.get(s.camera) ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || byString(a.camera, b.camera));

  const base = { timezone, release: { ...PATTERN_RELEASE }, sources, waitingProposals: 0 };
  if (!timezone) return { ...base, state: "not_configured", reason: "no_timezone", window: null, keys: [] };
  if (sources.length === 0) return { ...base, state: "not_configured", reason: "no_cameras", window: ready ? windowOf(ready) : null, keys };
  if (!ready) return { ...base, state: "not_built", reason: null, window: null, keys: [] };
  return { ...base, state: "ready", reason: null, window: windowOf(ready), keys };
}

// ── route 30 ─────────────────────────────────────────────────────────────

function parseKey(key: string): { kind: "area"; zoneId: string } | { kind: "camera"; camera: string } | null {
  if (key.startsWith("area:")) return { kind: "area", zoneId: key.slice(5) };
  if (key.startsWith("camera:")) return { kind: "camera", camera: key.slice(7) };
  return null;
}

const countsOf = (c: Pick<SecurityBaselineCell, "daysObserved" | "daysWithEvent" | "eventCount" | "observedMinutes"> | undefined): CellCounts | null =>
  c ? { daysObserved: c.daysObserved, daysWithEvent: c.daysWithEvent, eventCount: c.eventCount, observedMinutes: c.observedMinutes } : null;

export async function readPatternCells(
  prisma: ReadDb,
  scope: SecurityViewerScope,
  key: string,
  label: string,
): Promise<PatternCellsResult> {
  const parsed = parseKey(key);
  if (!parsed) return NOT_FOUND;
  const ready = await readyBuild(prisma);
  if (!ready) return NOT_FOUND;
  const [rows, links] = await Promise.all([
    prisma.securityBaselineCell.findMany({ where: { buildId: ready.id, zoneKey: key, label } }),
    parsed.kind === "area" ? loadActiveLinks(prisma) : Promise.resolve([] as ActiveZoneLink[]),
  ]);
  if (rows.length === 0) return NOT_FOUND;
  if (!visibleKeyCameras(parsed, links, rows[0]!.cameras, scope)) return NOT_FOUND;

  const at = new Map(rows.map((r) => [`${r.dayType}:${r.hour}`, r]));
  const cells: CellView[] = [];
  for (const dayType of ["weekday", "weekend"] as const) {
    for (let hour = 0; hour < 24; hour += 1) {
      const [prev, cur, next] = neighbourHours(hour).map((h) => at.get(`${dayType}:${h}`));
      const s = smoothCounts(countsOf(prev), countsOf(cur), countsOf(next));
      const ready_ = isReady(s.n);
      cells.push({
        dayType,
        hour,
        daysObserved: cur?.daysObserved ?? 0,
        daysWithEvent: cur?.daysWithEvent ?? 0,
        ready: ready_,
        rare: ready_ && isRare(rarityP(s)),
        typicalPerHour: ready_ ? hourlyRate(s) : null,
        longestUsualVisitSec: cur && cur.dwellSamples >= DWELL_MIN_SAMPLES ? cur.durationP99Sec : null,
      });
    }
  }
  return { status: "ok", view: { key, label, window: windowOf(ready), cells } };
}

// ── route 31, and the PR-E tool ──────────────────────────────────────────

export async function explainSecurityPattern(
  prisma: ReadDb,
  scope: SecurityViewerScope,
  q: ExplainPatternQuery,
  now: Date = new Date(),
): Promise<ExplainPatternResult> {
  if ((q.zoneId === undefined) === (q.camera === undefined)) return NOT_FOUND;
  const label = q.label ?? "person";
  const zone = await resolveSecurityTimezone(prisma);
  if (!zone) return { status: "no_timezone" };
  const ready = await readyBuild(prisma);
  if (!ready) return { status: "not_built" };

  const zoneKey = q.zoneId !== undefined ? `area:${q.zoneId}` : `camera:${q.camera}`;
  const parsed = parseKey(zoneKey)!;
  const [links, cameraLabels, anyCell] = await Promise.all([
    loadActiveLinks(prisma),
    loadCameraLabels(prisma),
    prisma.securityBaselineCell.findFirst({ where: { buildId: ready.id, zoneKey }, select: { cameras: true } }),
  ]);

  const visibleCameras = visibleKeyCameras(parsed, links, anyCell?.cameras ?? null, scope);
  if (!visibleCameras) return NOT_FOUND;
  let name: string;
  const cameras = visibleCameras;
  if (parsed.kind === "area") {
    name = links.find((l) => l.zoneId === parsed.zoneId)!.zoneName;
  } else {
    const known =
      cameraLabels.has(parsed.camera) ||
      anyCell !== null ||
      (await prisma.securityBaselineSource.findMany({ where: { camera: parsed.camera } })).length > 0;
    if (!known) return NOT_FOUND;
    name = cameraLabels.get(parsed.camera) ?? parsed.camera;
  }

  const tz = ready.timezone;
  const atInstant = q.at ?? now;
  const slot = slotOf(atInstant, tz);
  const hours = neighbourHours(slot.hour);
  const [rows, sourceRows, liveZone, expected] = await Promise.all([
    prisma.securityBaselineCell.findMany({
      where: { buildId: ready.id, zoneKey, label, dayType: slot.dayType, hour: { in: [...hours] } },
    }),
    prisma.securityBaselineSource.findMany({ where: { camera: { in: cameras } } }),
    parsed.kind === "area"
      ? prisma.securityZone.findUnique({ where: { id: parsed.zoneId }, select: { state: true, version: true } })
      : Promise.resolve(null),
    expectedActivityFor(prisma, { zoneKey, label, ymd: slot.ymd, hour: slot.hour }, now),
  ]);

  let cell: ExplainPatternView["cell"] = null;
  let paused: PatternPause | null = null;
  if (rows.length > 0) {
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    const [prev, cur, next] = hours.map((h) => byHour.get(h));
    // The engine's gates (c), (d), (f), (g) — never a second copy of them.
    paused =
      buildPause(zone, ready, now) ??
      keyPause(
        parsed.kind === "area" ? { kind: "area", liveVersion: liveZone?.state === "active" ? liveZone.version : null } : { kind: "camera" },
        { zoneVersion: (cur ?? rows[0]!).zoneVersion, cameras: (cur ?? rows[0]!).cameras },
        new Map(sourceRows.map((r) => [r.camera, r.state])),
      );
    const s = smoothCounts(countsOf(prev), countsOf(cur), countsOf(next));
    const ready_ = isReady(s.n);
    // What the engine would do right now: ready AND not paused.
    const judged = ready_ && paused === null;
    const p = rarityP(s);
    const lambdaHour = hourlyRate(s);
    const dwell = { dwellSamples: cur?.dwellSamples ?? 0, durationP99Sec: cur?.durationP99Sec ?? null };
    cell = {
      ready: ready_,
      daysObserved: cur?.daysObserved ?? 0,
      daysWithEvent: cur?.daysWithEvent ?? 0,
      smoothed: { daysObserved: s.n, daysWithEvent: s.d },
      rarity: { p, flagsBelow: RARITY_MAX_P, wouldFlag: judged && isRare(p) },
      volume: {
        typicalPerHour: lambdaHour,
        flagsFrom: judged && lambdaHour !== null ? volumeThreshold(slotRate(lambdaHour, slotMinutes(slot))) : null,
      },
      dwell: {
        longestUsualVisitSec: dwell.dwellSamples >= DWELL_MIN_SAMPLES ? dwell.durationP99Sec : null,
        samples: dwell.dwellSamples,
        wouldFlagAboveSec: judged ? dwellThresholdSec(label, dwell) : null,
      },
      neighbours: hours.map((h) => ({ hour: h, daysObserved: byHour.get(h)?.daysObserved ?? 0, daysWithEvent: byHour.get(h)?.daysWithEvent ?? 0 })),
    };
  }

  const sourceOf = new Map(sourceRows.map((s) => [s.camera, s]));
  const parts = localPartsOf(atInstant, tz);
  return {
    status: "ok",
    view: {
      key: { zoneKey, kind: parsed.kind, zoneId: parsed.kind === "area" ? parsed.zoneId : null, name, cameras },
      at: {
        instant: atInstant.toISOString(),
        local: `${WEEKDAY_SHORT[parts.isoWeekday]} ${siteClockCopy(atInstant, tz)}`,
        dayType: slot.dayType,
        hour: slot.hour,
        timezone: tz,
      },
      window: windowOf(ready),
      // Every camera here is visible by construction; filtered again so a
      // source row can never outlive a later change to the rule above.
      sources: cameras
        .filter((c) => canSee(scope, c))
        .map((c) => sourceOf.get(c))
        .filter((s): s is NonNullable<typeof s> => s !== undefined)
        .map((s) => ({
          camera: s.camera,
          state: s.state as LearningState,
          daysObserved: s.daysObserved,
          daysNeeded: DAYS_NEEDED,
          lastSeenAt: s.lastSeenAt.toISOString(),
        })),
      cell,
      paused,
      expected,
      release: { ...PATTERN_RELEASE },
    },
  };
}

/**
 * The active expected activity covering one slot, for any code — route 31's
 * `expected`, through the same `suppressionCovers` the engine's
 * `suppressionFor` uses (review item 10). The key is already visible to the
 * viewer (route 31 answers 404 otherwise).
 */
export async function expectedActivityFor(
  prisma: Pick<PrismaClient, "securitySuppression">,
  at: SuppressionSlot,
  now: Date,
): Promise<Array<{ id: string; text: string; until: string; codes: PatternCode[] }>> {
  const rows = await prisma.securitySuppression.findMany({
    where: { state: "active", expiresAt: { gt: now } },
    select: {
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
      reason: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows
    .filter((r) => suppressionCovers(r, at, now))
    .map((r) => ({ id: r.id, text: r.reason, until: r.expiresAt.toISOString(), codes: r.codes as PatternCode[] }));
}
