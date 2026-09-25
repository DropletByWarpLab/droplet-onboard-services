/**
 * WARP-2979 (ADR-059 P4 §6.1) — co-occurrence arithmetic for Droplet's link
 * proposals. PURE: epoch-ms numbers in, numbers out; no Prisma, no clock.
 *
 * The question: when a source a PERSON placed in an area does something, is a
 * candidate camera (or part of its view) seeing a person within 10 s more
 * often than chance would give — chance measured LOCALLY, in the half hour
 * either side of each anchor, so a camera that is busy whenever the door is
 * busy does not look linked?
 *
 * S0 FOUNDATION (slice L fills every body). The constants and signatures
 * below are final; the bodies are SAFE stubs: every statistic is "nothing
 * seen" and no gate ever passes, so a job wired to them proposes nothing.
 * `link-rules-fingerprint.test.ts` (slice L) pins LINK_RULES to
 * LINK_RULES_VERSION: a change to any number needs a version bump.
 */

export const LINK_RULES_VERSION = 1;

/** §6.1's gates. `lockCamera` is one direction; `cameraCamera` must pass BOTH directions. */
export const LINK_RULES = {
  windowDays: 14,
  settleMs: 15 * 60_000,
  pairMs: 10_000,
  localChanceMs: 30 * 60_000,
  debounceMs: 60_000,
  maxAnchors: 500,
  partShare: 0.9,
  // One direction: anchors are lock changes, coverage is the camera's people.
  lockCamera: {
    propose: { minN: 6, minK: 4, minLift: 3, maxPAdj: 1e-3, minConfidence: 0.2 },
    auto: { minN: 10, minK: 8, minLift: 10, maxPAdj: 1e-6, minConfidence: 0.5 },
  },
  // BOTH directions must pass (A's visits → B, and B's visits → A): overlapping views, not a street camera
  // that sees everyone on their way in.
  cameraCamera: {
    propose: { minN: 20, minK: 10, minLift: 5, maxPAdj: 1e-4, minConfidence: 0.4 },
    auto: { minN: 30, minK: 20, minLift: 10, maxPAdj: 1e-6, minConfidence: 0.6 },
  },
} as const;

export type LinkRules = typeof LINK_RULES;
/** Which gate table a pair is scored against. */
export type LinkPairKind = "lockCamera" | "cameraCamera";
/** The highest gate a candidate passed; null = none. */
export type LinkGate = "auto" | "propose";

/** A closed interval of epoch ms, `start ≤ end`. */
export interface Interval {
  start: number;
  end: number;
}

/** One direction's inputs (§6.1 "Definitions"). */
export interface DirectionInput {
  /** The anchor instants in W, sorted ascending, ALREADY debounced and capped (`debounceAnchors`). */
  anchors: readonly number[];
  /** The candidate's padded person detections, merged (`mergeIntervals`). */
  coverage: readonly Interval[];
  /** The candidate's blind spells (its own offline spells and every Frigate-wide one), merged. */
  blind: readonly Interval[];
  /** E = now − settleMs: the observed end; local chance windows are clipped here. */
  observedEnd: number;
}

/** One direction's statistic, in floats (the evidence rounds them to integers). */
export interface DirectionStats {
  /** Anchors counted (not excluded). */
  n: number;
  /** Hits: counted anchors inside the coverage. */
  k: number;
  /** Anchors inside a blind spell — not counted against the candidate. */
  excluded: number;
  /** λ = Σ q_i, the hits local chance alone would give. */
  lambda: number;
  /** k / λ; 0 when k = 0. */
  lift: number;
  /** P(Poisson(λ) ≥ k); 1 when k = 0. */
  pChance: number;
  /** Wilson 95 % lower bound of k / n; 0 when n = 0. */
  confidence: number;
  /** Every hit, newest first: the anchor and the start of the covering interval it fell in. */
  hits: Array<{ anchorAt: number; hitAt: number }>;
}

/** Sort and merge overlapping or touching intervals. S0 stub: nothing is covered. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  void intervals;
  return [];
}

/** |merged ∩ [from, to]| in ms. S0 stub: 0. */
export function coveredMs(merged: readonly Interval[], from: number, to: number): number {
  void merged;
  void from;
  void to;
  return 0;
}

/** Drop an instant within `debounceMs` of the previous KEPT one; keep the latest `maxAnchors`. S0 stub: none kept. */
export function debounceAnchors(sorted: readonly number[], debounceMs: number, maxAnchors: number): number[] {
  void sorted;
  void debounceMs;
  void maxAnchors;
  return [];
}

/** P(Poisson(λ) ≥ k), in log space (§6.1). S0 stub: 1 (never significant). */
export function poissonTail(k: number, lambda: number): number {
  void k;
  void lambda;
  return 1;
}

/** Wilson 95 % lower bound of k / n (z = 1.959964). S0 stub: 0. */
export function wilsonLowerBound(k: number, n: number): number {
  void k;
  void n;
  return 0;
}

/** Score one direction. S0 stub: nothing counted. */
export function scoreDirection(input: DirectionInput, rules: LinkRules = LINK_RULES): DirectionStats {
  void input;
  void rules;
  return { n: 0, k: 0, excluded: 0, lambda: 0, lift: 0, pChance: 1, confidence: 0, hits: [] };
}

/**
 * The highest gate one direction passes, given its Bonferroni-adjusted
 * p-value. Camera ↔ camera takes the LOWER of its two directions' gates.
 * S0 stub: null (no gate ever passes).
 */
export function gateFor(kind: LinkPairKind, stats: DirectionStats, pAdj: number, rules: LinkRules = LINK_RULES): LinkGate | null {
  void kind;
  void stats;
  void pAdj;
  void rules;
  return null;
}

/** §6.2.4 name tokens: lower-cased, camelCase and non-alphanumerics split, ≥ 3 chars, stopwords dropped. S0 stub: none. */
export function nameTokens(s: string): string[] {
  void s;
  return [];
}

/** Whether two names share a token — a tiebreak and a supporting line, NEVER evidence. S0 stub: no match. */
export function namesMatch(a: string, b: string): { match: boolean; shared: string[] } {
  void a;
  void b;
  return { match: false, shared: [] };
}
