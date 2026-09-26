/**
 * WARP-2980 (ADR-059 P5 §4.3, spec §6.4) — the arithmetic of "what normal
 * looks like". Pure.
 *
 * The cells store RAW counts (services/security-baseline-build.ts); every
 * score is computed here, on read, from the three stored hours h−1, h, h+1 of
 * the same day type. The rules (`patternHits`, lib/security-rules.ts — PR-B),
 * the patterns page and the explanation (routes 30–31, P4's chat tool) all
 * call these functions, so an explanation can never disagree with a flag.
 *
 * What is never in the arithmetic (brief §4.4): verdicts, suppressions,
 * modes, area kinds. Modes and area kinds change a flag's severity
 * (`patternSeverity`), expected activity quiets it, verdicts only feed
 * precision — never detection.
 */
import { poissonUpperTail } from "./security-stats.js";

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
  /** A ready build whose window ends more than this many site dates before today pauses the rules and area rebuilds (PR-B). */
  freshWindowDays: 2,
} as const;

/** The window the cells are built over, in complete site-local dates before today. */
export const BASELINE_WINDOW_DAYS = BASELINE.windowDays;

/**
 * The three P5 codes. Their rules, releases and severities are
 * lib/security-rules.ts's PATTERN_RULES (PR-B), fingerprinted with P3's
 * RULESET; a build is stamped with SECURITY_RULESET_VERSION.
 */
export const PATTERN_CODES = ["out_of_place", "unusual_volume", "long_dwell"] as const;
export type PatternCode = (typeof PATTERN_CODES)[number];
export type PatternRelease = "trial" | "live";

/** out_of_place: p strictly below this. */
export const RARITY_MAX_P = 0.05;
/** unusual_volume: P(X ≥ k | λ) strictly below this … */
export const VOLUME_MAX_TAIL_P = 0.001;
/** … and never for fewer than this many. */
export const VOLUME_MIN_K = 3;
/** long_dwell: longer than max(p99, this). */
export const DWELL_MIN_SEC = 120;
/** long_dwell: no p99 worth quoting below this many samples. */
export const DWELL_MIN_SAMPLES = 30;
/** long_dwell is judged for these labels only (a car parks). */
export const DWELL_LABELS: readonly string[] = ["person"];

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

/**
 * [h−1, h, h+1], circular WITHIN a day type: hour 0 borrows 23 and 1 of the
 * same day type (Monday 00:00 borrows weekday 23:00, not Sunday — accepted).
 */
export function neighbourHours(hour: number): [number, number, number] {
  return [(hour + 23) % 24, hour, (hour + 1) % 24];
}

/** The three stored cells around `hour`, read through `at` (one key, label and day type). */
export function cellsAround<C>(at: (hour: number) => C | null, hour: number): [C | null, C | null, C | null] {
  const [a, b, c] = neighbourHours(hour);
  return [at(a), at(b), at(c)];
}

/**
 * Smoothing (D7): the numerator AND the denominator, so d′ ≤ n′ and the
 * result is still a rate. Smoothing the numerator alone would leave a
 * weekend cell unable to fire inside 28 days (0.5/9 = 0.056). A missing
 * neighbour is zero.
 */
export function smoothCounts(prev: CellCounts | null, cur: CellCounts | null, next: CellCounts | null): SmoothedCounts {
  const w = BASELINE.neighbourWeight;
  const x = (f: keyof CellCounts): number => (cur?.[f] ?? 0) + w * ((prev?.[f] ?? 0) + (next?.[f] ?? 0));
  return { n: x("daysObserved"), d: x("daysWithEvent"), c: x("eventCount"), m: x("observedMinutes") };
}

/** Readiness (D8): every code needs n′ ≥ 10 observed days behind its cell. */
export function isReady(nSmoothed: number): boolean {
  return nSmoothed >= BASELINE.readyMinSmoothedDays;
}

/** Rarity: p = (d′ + 0.5)/(n′ + 1), a Jeffreys-smoothed daily occurrence rate. */
export function rarityP(s: Pick<SmoothedCounts, "n" | "d">): number {
  return (s.d + 0.5) / (s.n + 1);
}

/** out_of_place's test, strictly below 0.05. (With readiness it is also `ready ∧ …`.) */
export function isRare(p: number): boolean {
  return p < RARITY_MAX_P;
}

/**
 * λ_hour = (c′ + 0.5)/(m′/60): events per observed hour. The 0.5 prior means
 * a never-seen hour still has a (small) rate, so P is never 0 for any k.
 * Null when the cell holds no observed time at all.
 */
export function hourlyRate(s: Pick<SmoothedCounts, "c" | "m">): number | null {
  if (!(s.m > 0)) return null;
  return (s.c + 0.5) / (s.m / 60);
}

/** λ for the event's own slot: a fall-back hour is 120 minutes, a Lord Howe spring hour 30. */
export function slotRate(lambdaHour: number, slotMinutes: number): number {
  return (lambdaHour * slotMinutes) / 60;
}

/** unusual_volume's tail test, strictly below 0.001. */
export function tailFlags(tailP: number): boolean {
  return tailP < VOLUME_MAX_TAIL_P;
}

/**
 * k*: the smallest k ≥ 3 with P(X ≥ k | λ) < 0.001. For k ≤ λ the tail is
 * ≥ ~0.4, so the search starts at max(3, ⌊λ⌋).
 */
export function volumeThreshold(lambda: number): number {
  let k = Math.max(VOLUME_MIN_K, Math.floor(lambda));
  while (!tailFlags(poissonUpperTail(k, lambda))) k += 1;
  return k;
}

/** unusual_volume fires for every event at or past k* (D9). */
export function wouldFlagVolume(k: number, lambda: number): boolean {
  return k >= VOLUME_MIN_K && tailFlags(poissonUpperTail(k, lambda));
}

/**
 * The duration above which a visit is long for this cell: max(p99, 120 s),
 * for a person, with ≥ 30 samples. Null otherwise — "not enough visits yet",
 * and long_dwell never fires.
 */
export function dwellThresholdSec(label: string, cell: CellDwell): number | null {
  if (!DWELL_LABELS.includes(label)) return null;
  if (cell.dwellSamples < DWELL_MIN_SAMPLES || cell.durationP99Sec === null) return null;
  return Math.max(cell.durationP99Sec, DWELL_MIN_SEC);
}

/** long_dwell ⟺ person ∧ samples ≥ 30 ∧ duration > max(p99, 120 s). */
export function wouldFlagDwell(label: string, durationSec: number, cell: CellDwell): boolean {
  const threshold = dwellThresholdSec(label, cell);
  return threshold !== null && durationSec > threshold;
}
