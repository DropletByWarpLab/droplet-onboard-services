/**
 * WARP-2980 (ADR-059 P5, spec §6.3, §6.6) — coverage: when Droplet could
 * prove it was listening to each camera, recorded as it happens.
 *
 * S0 stub: the types and signatures. Slice A2 fills in the bodies.
 */
import type { PrismaClient } from "@prisma/client";
import type { SourceHealth } from "./security-event-ingest.js";

/** One tracker reading (security-events.service.ts `TrackedHealth`). */
export interface CoverageReading {
  health: SourceHealth;
  at: Date;
  /** When the health last changed. */
  since: Date;
}

/** The ingest facts coverage reads (security-events.service.ts `securityIngestHealthState()`). */
export interface CoverageIngest {
  frigateSubscribed: boolean;
  frigateSubscribedAt: Date | null;
  lastRecordedAt: Date | null;
  lastWriteError: { at: Date } | null;
}

/** What one tick sees: the ingest state and every reading (null key = Frigate itself). */
export interface CoverageObservation {
  ingest: CoverageIngest;
  readings: ReadonlyMap<string | null, CoverageReading>;
}

/** An open span as the tick reads it. */
export interface OpenCoverageSpan {
  id: bigint;
  camera: string;
  startedAt: Date;
  coveredUntil: Date;
  processId: string;
}

export interface CoveragePlan {
  /** Continuing spans: coveredUntil → now. */
  extend: bigint[];
  /** Spans that failed the test: closed at their last confirmation. */
  close: bigint[];
  /** New spans for observing cameras with no continuing span. */
  open: Array<{ camera: string; startedAt: Date }>;
}

export function planCoverage(
  openSpans: readonly OpenCoverageSpan[],
  obs: CoverageObservation,
  processId: string,
  now: Date,
  lastCoveredUntil: ReadonlyMap<string, Date> = new Map(),
): CoveragePlan {
  void openSpans;
  void obs;
  void processId;
  void now;
  void lastCoveredUntil;
  return { extend: [], close: [], open: [] };
}

export interface CoverageTickResult {
  extended: number;
  closed: number;
  opened: number;
}

export async function recordCoverage(
  prisma: Pick<PrismaClient, "securityCoverageSpan">,
  obs: CoverageObservation,
  processId: string,
  now: Date,
  opts: { bootClose: boolean },
): Promise<CoverageTickResult> {
  void prisma;
  void obs;
  void processId;
  void now;
  void opts;
  return { extended: 0, closed: 0, opened: 0 };
}
