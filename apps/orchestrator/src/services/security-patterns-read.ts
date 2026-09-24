/**
 * WARP-2980 (ADR-059 P5, spec §6.17, §7 routes 29–31) — the read side of
 * "what normal looks like": the overview, one key's cells, and the
 * explanation behind the (PR-E) `security_explain_pattern` tool.
 *
 * S0 stub: the wire types and signatures. Slice A4 fills in the bodies.
 */
import type { PrismaClient } from "@prisma/client";
import type { SecurityViewerScope } from "./security-access.js";
import type { PatternCode, PatternRelease } from "../lib/security-baseline-math.js";

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
  /** p < 0.05 now. */
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
    volume: { typicalPerHour: number | null; flagsFrom: number | null };
    dwell: { longestUsualVisitSec: number | null; samples: number; wouldFlagAboveSec: number | null };
    neighbours: Array<{ hour: number; daysObserved: number; daysWithEvent: number }>;
  } | null;
  /** Active suppressions that would match (PR-B); always [] before it. */
  expected: Array<{ id: string; text: string; until: string }>;
  release: Record<PatternCode, PatternRelease>;
}

export type ExplainPatternResult =
  | { status: "not_found" }
  | { status: "no_timezone" }
  | { status: "not_built" }
  | { status: "ok"; view: ExplainPatternView };

export async function explainSecurityPattern(
  prisma: PrismaClient,
  scope: SecurityViewerScope,
  q: ExplainPatternQuery,
): Promise<ExplainPatternResult> {
  void prisma;
  void scope;
  void q;
  return { status: "not_built" };
}
