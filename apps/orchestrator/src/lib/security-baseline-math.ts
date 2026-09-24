/**
 * WARP-2980 (ADR-059 P5 §4.3, spec §6.4) — the arithmetic of "what normal
 * looks like". Pure.
 *
 * S0 stub: the constants and types every other P5 file compiles against.
 * Slice A1 fills in the functions.
 */

export const BASELINE = {
  windowDays: 28,
  learningDays: 14,
  /** A "fully observed day" for learning. */
  fullDayMinutes: 1200,
  /** A slot counts as observed at ≥ 50 of 60 minutes. */
  observedSlotShare: 5 / 6,
  staleAfterMs: 48 * 3_600_000,
  neighbourWeight: 0.25,
  readyMinSmoothedDays: 10,
  /** docker/frigate/config.yml `objects.track`. */
  labels: ["person", "car", "dog", "cat"] as const,
  maxLabelsPerKey: 8,
} as const;

/** The window the cells are built over, in complete site-local dates before today. */
export const BASELINE_WINDOW_DAYS = BASELINE.windowDays;

/**
 * The version of the rules a build was made under (`SecurityBaselineBuild.rulesetVersion`).
 * P3's `SECURITY_RULESET_VERSION` does not exist yet; PR-B replaces this with it.
 */
export const SECURITY_BASELINE_RULESET_VERSION = 1;

/** The three P5 codes. PR-B adds them to P3's engine; PR-A only reports their release. */
export const PATTERN_CODES = ["out_of_place", "unusual_volume", "long_dwell"] as const;
export type PatternCode = (typeof PATTERN_CODES)[number];
export type PatternRelease = "trial" | "live";

/**
 * Every P5 code ships `trial` (spec §11, D18): evaluated and shown to
 * owner/admin, never counted or notified, until PR-D flips it after the
 * house-unit measurement. PR-B moves this into P3's RULESET.
 */
export const PATTERN_RELEASE: Readonly<Record<PatternCode, PatternRelease>> = {
  out_of_place: "trial",
  unusual_volume: "trial",
  long_dwell: "trial",
};

/** The raw counts of one stored cell (`SecurityBaselineCell`). */
export interface CellCounts {
  daysObserved: number;
  daysWithEvent: number;
  eventCount: number;
  observedMinutes: number;
}

/** The dwell half of one stored cell. */
export interface CellDwell {
  dwellSamples: number;
  durationP99Sec: number | null;
}

/** x′ = x(h) + 0.25·(x(h−1) + x(h+1)) for n, d, c and m (D7). */
export interface SmoothedCounts {
  n: number;
  d: number;
  c: number;
  m: number;
}
