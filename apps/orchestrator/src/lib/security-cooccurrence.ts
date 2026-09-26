/**
 * WARP-2979 (ADR-059 P4 §6.1, §6.2) — co-occurrence arithmetic for Droplet's
 * link proposals. PURE: epoch-ms numbers in, numbers out; no Prisma, no clock.
 *
 * The question: when a source a PERSON placed in an area does something, is a
 * candidate camera (or part of its view) seeing a person within 10 s more
 * often than chance would give — chance measured LOCALLY, in the half hour
 * either side of each anchor, so a camera that is busy whenever the door is
 * busy does not look linked?
 *
 *   · W = [now − 14 d, E], E = now − 15 min (detections are written on
 *     Frigate's `end`, so the last quarter hour is not observed yet).
 *   · Anchors: the anchor source's person-sighting starts in W, debounced
 *     (an instant within 60 s of the previous KEPT one is dropped) and capped
 *     at the latest 500.
 *   · Coverage: the candidate's sightings padded ±10 s and merged; a hit is
 *     an anchor inside it (closed: exactly 10 s counts).
 *   · Blind spells: the candidate's offline → online spells and every
 *     Frigate-wide one. An anchor inside one is EXCLUDED (not a miss).
 *   · Local chance q_i = covered share of [t − 30 min, min(t + 30 min, E)];
 *     λ = Σ q_i; lift = k / λ; pChance = P(Poisson(λ) ≥ k) — P5's shared
 *     tail (`lib/security-stats.ts`, D29), never a second copy. Never
 *     optimistic for a sum of Bernoullis once k ≥ λ + 1, and every gate needs
 *     lift ≥ 3 (a property test pins it against the exact Poisson-binomial).
 *   · Bonferroni over the run: pAdj = min(1, m · pChance), m = every
 *     (anchor source, candidate, direction) scored.
 *   · Confidence = the Wilson 95 % lower bound of k / n.
 *
 * Camera ↔ camera (PR-1's arm) must pass BOTH directions: A's visits → B,
 * and B's visits → A. The pair takes the lower gate and the lower confidence.
 * For each candidate camera B the whole view and every part seen in B's
 * sightings are scored; the best part F* is taken when it keeps ≥ 90 % of the
 * whole camera's hits.
 *
 * Lock ↔ camera (P4 PR-4, D31) is ONE direction, the same statistic whichever
 * side a person placed in the area: the anchors are the lock's CHANGES
 * (`isLockChange`, lib/security-lock-changes.ts — 🔴 live only, never a
 * `polled` row, never the baseline, only locked / unlocked / unlatched), the
 * coverage a camera view's people. A lock anchor pairs with every camera (and
 * part, chosen as above); a camera anchor pairs with every lock that changed
 * live in W. Gated by `lockCamera`. Both arms of a run share ONE m
 * (`scoreLinkPairs`), and per area and candidate the best gate wins.
 *
 * Names (§6.2.4) are a tiebreak and a supporting line, NEVER evidence: they
 * only decide between parts that tie on hits, gate and lift, so flipping every
 * name match changes no gate (a test pins it).
 *
 * `link-rules-fingerprint.test.ts` pins LINK_RULES to LINK_RULES_VERSION: a
 * change to any number needs a version bump (every stored evidence names the
 * version that produced it).
 */
import { poissonUpperTail } from "./security-stats.js";
import type { DirectionStatsV1, LinkEvidenceV1 } from "./security-link-evidence.js";
import { LINK_EVIDENCE_MAX_SAMPLES } from "./security-link-evidence.js";
import { isLockChange } from "./security-lock-changes.js";

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

/** Wilson's z for a 95 % bound. */
const Z = 1.959964;

/** A closed interval of epoch ms, `start ≤ end`. */
export interface Interval {
  start: number;
  end: number;
}

/** The window every statistic in one run is measured over. */
export interface LinkWindow {
  /** now − windowDays. */
  from: number;
  /** E = now − settleMs: the observed end; local chance windows are clipped here. */
  observedEnd: number;
}

export function linkWindow(now: number, rules: LinkRules = LINK_RULES): LinkWindow {
  return { from: now - rules.windowDays * 86_400_000, observedEnd: now - rules.settleMs };
}

/** One direction's inputs (§6.1 "Definitions"). */
export interface DirectionInput {
  /** The anchor instants in W, sorted ascending, ALREADY debounced and capped (`debounceAnchors`). */
  anchors: readonly number[];
  /** The candidate's padded person sightings, merged (`mergeIntervals`). */
  coverage: readonly Interval[];
  /** The candidate's blind spells (its own offline spells and every Frigate-wide one), merged. */
  blind: readonly Interval[];
  /** E: local chance windows are clipped here. */
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
  /** Every hit, newest first: the anchor, and the nearest moment the candidate had someone in view. */
  hits: Array<{ anchorAt: number; hitAt: number }>;
}

/** Sort and merge overlapping or touching intervals. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/** Index of the first merged interval whose end is ≥ `t` (binary search). */
function firstEndingAtOrAfter(merged: readonly Interval[], t: number): number {
  let lo = 0;
  let hi = merged.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (merged[mid]!.end < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The merged interval containing `t` (closed), or null. */
function containing(merged: readonly Interval[], t: number): Interval | null {
  const i = firstEndingAtOrAfter(merged, t);
  const iv = merged[i];
  return iv && iv.start <= t ? iv : null;
}

/** |merged ∩ [from, to]| in ms. */
export function coveredMs(merged: readonly Interval[], from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  for (let i = firstEndingAtOrAfter(merged, from); i < merged.length; i += 1) {
    const iv = merged[i]!;
    if (iv.start >= to) break;
    total += Math.min(iv.end, to) - Math.max(iv.start, from);
  }
  return total;
}

/**
 * Drop an instant within `debounceMs` of the previous KEPT one (so a burst
 * counts once), then keep the latest `maxAnchors`. `sorted` ascending.
 */
export function debounceAnchors(sorted: readonly number[], debounceMs: number, maxAnchors: number): number[] {
  const kept: number[] = [];
  for (const t of sorted) {
    const last = kept[kept.length - 1];
    if (last === undefined || t - last > debounceMs) kept.push(t);
  }
  return kept.length > maxAnchors ? kept.slice(kept.length - maxAnchors) : kept;
}

/** P(Poisson(λ) ≥ k) — P5's shared tail (lib/security-stats.ts, D29), not a copy. */
export const poissonTail: (k: number, lambda: number) => number = poissonUpperTail;

/** Wilson 95 % lower bound of k / n (z = 1.959964); 0 when n = 0. */
export function wilsonLowerBound(k: number, n: number): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = Z * Z;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/** Score one direction. */
export function scoreDirection(input: DirectionInput, rules: LinkRules = LINK_RULES): DirectionStats {
  const { anchors, coverage, blind, observedEnd } = input;
  let n = 0;
  let k = 0;
  let excluded = 0;
  let lambda = 0;
  const hits: Array<{ anchorAt: number; hitAt: number }> = [];
  for (const t of anchors) {
    if (containing(blind, t)) {
      excluded += 1;
      continue;
    }
    n += 1;
    const from = t - rules.localChanceMs;
    const to = Math.min(t + rules.localChanceMs, observedEnd);
    if (to > from) lambda += coveredMs(coverage, from, to) / (to - from);
    const iv = containing(coverage, t);
    if (iv) {
      k += 1;
      // The nearest moment inside the UNPADDED span the candidate had someone in view.
      const lo = iv.start + rules.pairMs;
      const hi = iv.end - rules.pairMs;
      const hitAt = lo <= hi ? Math.min(Math.max(t, lo), hi) : Math.round((iv.start + iv.end) / 2);
      hits.push({ anchorAt: t, hitAt });
    }
  }
  hits.reverse();
  return {
    n,
    k,
    excluded,
    lambda,
    lift: k > 0 ? k / lambda : 0,
    pChance: poissonTail(k, lambda),
    confidence: wilsonLowerBound(k, n),
    hits,
  };
}

/** The highest gate one direction passes, given its Bonferroni-adjusted p-value. Every threshold is inclusive. */
export function gateFor(kind: LinkPairKind, stats: DirectionStats, pAdj: number, rules: LinkRules = LINK_RULES): LinkGate | null {
  const table = rules[kind];
  const passes = (g: (typeof table)["auto"] | (typeof table)["propose"]): boolean =>
    stats.n >= g.minN && stats.k >= g.minK && stats.lift >= g.minLift && pAdj <= g.maxPAdj && stats.confidence >= g.minConfidence;
  if (passes(table.auto)) return "auto";
  if (passes(table.propose)) return "propose";
  return null;
}

const GATE_RANK: Record<LinkGate, number> = { propose: 1, auto: 2 };
const rank = (g: LinkGate | null): number => (g ? GATE_RANK[g] : 0);

/** Camera ↔ camera takes the LOWER of its two directions' gates. */
export function lowerGate(a: LinkGate | null, b: LinkGate | null): LinkGate | null {
  if (a === null || b === null) return null;
  return rank(a) <= rank(b) ? a : b;
}

// ── names (§6.2.4) ────────────────────────────────────────────────────────

const NAME_STOPWORDS = new Set(["cam", "cams", "camera", "cameras", "lock", "locks", "the", "and", "main", "view", "part"]);

/** Lower-cased, camelCase and non-alphanumerics split, ≥ 3 chars, stopwords dropped; unique, in order. */
export function nameTokens(s: string): string[] {
  const spaced = s.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  const out: string[] = [];
  for (const raw of spaced.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if ([...raw].length < 3 || NAME_STOPWORDS.has(raw) || out.includes(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Whether two names share a token — a tiebreak and a supporting line, NEVER evidence. */
export function namesMatch(a: string, b: string): { match: boolean; shared: string[] } {
  const bt = new Set(nameTokens(b));
  const shared = nameTokens(a)
    .filter((t) => bt.has(t))
    .sort();
  return { match: shared.length > 0, shared };
}

// ── series: what the job's one load becomes ───────────────────────────────

/** A `detection` row with `person` in its labels, as the job loads it (epoch ms). */
export interface PersonSighting {
  camera: string;
  /** Frigate zones the person entered (`cameraZones`). */
  zones: readonly string[];
  startedAt: number;
  endedAt: number | null;
}

/** A camera status row: camera_offline / camera_online, or (camera null) Frigate-wide source_offline / source_online. */
export interface StatusMark {
  camera: string | null;
  kind: "offline" | "online";
  at: number;
}

/** One source's anchor instants (starts inside W, sorted, NOT yet debounced) and its merged padded coverage. */
export interface SourceSeries {
  instants: number[];
  coverage: Interval[];
}

/** A camera's whole view and each part seen in its sightings. */
export interface CameraSeries {
  whole: SourceSeries;
  parts: Map<string, SourceSeries>;
}

/**
 * Per camera and per part: the sighting starts inside W (anchor instants)
 * and the coverage from every loaded sighting (the load reaches half an hour
 * before W, for the first anchors' local chance), padded ±pairMs and merged.
 */
export function buildCameraSeries(
  sightings: readonly PersonSighting[],
  window: LinkWindow,
  rules: LinkRules = LINK_RULES,
): Map<string, CameraSeries> {
  const raw = new Map<string, { whole: { t: number[]; iv: Interval[] }; parts: Map<string, { t: number[]; iv: Interval[] }> }>();
  const add = (bucket: { t: number[]; iv: Interval[] }, s: PersonSighting): void => {
    if (s.startedAt >= window.from && s.startedAt <= window.observedEnd) bucket.t.push(s.startedAt);
    // An end before the start (never written by the ingest) is read as no end at all.
    bucket.iv.push({ start: s.startedAt - rules.pairMs, end: Math.max(s.startedAt, s.endedAt ?? s.startedAt) + rules.pairMs });
  };
  for (const s of sightings) {
    let cam = raw.get(s.camera);
    if (!cam) {
      cam = { whole: { t: [], iv: [] }, parts: new Map() };
      raw.set(s.camera, cam);
    }
    add(cam.whole, s);
    for (const z of new Set(s.zones)) {
      let part = cam.parts.get(z);
      if (!part) {
        part = { t: [], iv: [] };
        cam.parts.set(z, part);
      }
      add(part, s);
    }
  }
  const finish = (b: { t: number[]; iv: Interval[] }): SourceSeries => ({
    instants: [...b.t].sort((x, y) => x - y),
    coverage: mergeIntervals(b.iv),
  });
  const out = new Map<string, CameraSeries>();
  for (const [camera, b] of [...raw.entries()].sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))) {
    const parts = new Map<string, SourceSeries>();
    for (const [z, pb] of [...b.parts.entries()].sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))) parts.set(z, finish(pb));
    out.set(camera, { whole: finish(b.whole), parts });
  }
  return out;
}

/**
 * Per camera: its own offline → online spells plus every Frigate-wide one,
 * merged. An offline with no later online runs to E. An online with no
 * earlier offline in the load is ignored.
 */
export function blindSpells(marks: readonly StatusMark[], cameras: Iterable<string>, window: LinkWindow): Map<string, Interval[]> {
  const spells = (mine: StatusMark[]): Interval[] => {
    const out: Interval[] = [];
    let openAt: number | null = null;
    for (const m of mine) {
      if (m.kind === "offline") {
        if (openAt === null) openAt = m.at;
      } else if (openAt !== null) {
        out.push({ start: openAt, end: Math.max(openAt, m.at) });
        openAt = null;
      }
    }
    if (openAt !== null) out.push({ start: openAt, end: Math.max(openAt, window.observedEnd) });
    return out;
  };
  const sorted = [...marks].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "offline" ? -1 : 1));
  const global = spells(sorted.filter((m) => m.camera === null));
  const out = new Map<string, Interval[]>();
  for (const camera of cameras) out.set(camera, mergeIntervals([...global, ...spells(sorted.filter((m) => m.camera === camera))]));
  return out;
}

// ── camera ↔ camera: anchors × candidates (§6.2.2, §6.2.3) ─────────────────

/**
 * A person-set active link in an active area (§6.2.1): a camera, a part of a
 * view, or (PR-4) a door lock.
 */
export interface LinkAnchor {
  linkId: string;
  zoneId: string;
  zoneName: string;
  sourceKind: "camera" | "camera_zone" | "lock";
  sourceRef: string;
  /** The anchor camera's (or lock's) display name. */
  label: string;
}

/** One (area, candidate camera) after scoring: the best anchor in that area, and the chosen view. */
export interface PairCandidateResult {
  kind: "camera_camera";
  anchor: LinkAnchor;
  camera: string;
  /** The chosen part, or null for the whole camera. */
  part: string | null;
  sourceKind: "camera" | "camera_zone";
  /** `B` or `B/F*`. */
  sourceRef: string;
  /** The candidate camera's display name (never the part). */
  label: string;
  /** Anchor's visits → candidate. */
  forward: DirectionStats;
  /** Candidate's visits → anchor. */
  reverse: DirectionStats;
  forwardPAdj: number;
  reversePAdj: number;
  /** The lower of the two directions' gates. */
  gate: LinkGate | null;
  /** The lower of the two confidences. */
  confidence: number;
  /** The whole camera's forward hits when a part was chosen; null otherwise. */
  wholeK: number | null;
  /** The area's name against the candidate's names — a tiebreak only. */
  names: { match: boolean; shared: string[] };
}

export interface CameraPairsInput {
  /** Camera and camera_zone anchors pair here; lock anchors belong to the lock arm and are ignored. */
  anchors: readonly LinkAnchor[];
  series: ReadonlyMap<string, CameraSeries>;
  blind: ReadonlyMap<string, readonly Interval[]>;
  observedEnd: number;
  /**
   * Skip every view of this camera for this area: the area already holds a
   * row on it that Droplet must never touch (active, removed or rejected, in
   * any origin), or the camera is disabled.
   */
  skipCamera: (zoneId: string, camera: string) => boolean;
  /**
   * An open suggestion Droplet already made on this camera in this area: the
   * candidate is pinned to that row's view (re-scored, never a second row).
   */
  pinnedRef: (zoneId: string, camera: string) => { sourceKind: "camera" | "camera_zone"; sourceRef: string } | null;
  candidateLabel: (camera: string) => string;
  rules?: LinkRules;
}

const EMPTY_SERIES: SourceSeries = { instants: [], coverage: [] };

/** The view a ref names inside a camera's series (an unseen part is empty). */
function viewSeries(series: ReadonlyMap<string, CameraSeries>, camera: string, part: string | null): SourceSeries {
  const s = series.get(camera);
  if (!s) return EMPTY_SERIES;
  return part === null ? s.whole : (s.parts.get(part) ?? EMPTY_SERIES);
}

/** `camera` or `camera/part` → its pieces (the ref grammar is checked where refs are stored). */
function splitRef(sourceKind: "camera" | "camera_zone", ref: string): { camera: string; part: string | null } {
  if (sourceKind === "camera") return { camera: ref, part: null };
  const slash = ref.indexOf("/");
  return { camera: ref.slice(0, slash), part: ref.slice(slash + 1) };
}

/**
 * One arm of a run, scored but not yet gated: `hypotheses` is what the arm
 * adds to m, and `judge(m)` gates every candidate with the RUN's m (§6.1:
 * "m = the number of (anchor source, candidate, direction) hypotheses scored
 * in this run") and keeps the best anchor per (area, candidate).
 */
interface ScoredArm<R> {
  hypotheses: number;
  judge: (m: number) => R[];
}

/** The views a candidate camera is scored on: pinned → the whole (for `wholeK`) and the pinned view; else the whole and every part seen in W. */
function candidateViews(
  cs: CameraSeries,
  pin: { sourceKind: "camera" | "camera_zone"; sourceRef: string } | null,
): { views: Array<string | null>; pinned: boolean } {
  const pinnedPart = pin ? splitRef(pin.sourceKind, pin.sourceRef).part : undefined;
  if (pinnedPart !== undefined) return { views: pinnedPart === null ? [null] : [null, pinnedPart], pinned: true };
  return { views: [null, ...[...cs.parts.entries()].filter(([, ps]) => ps.instants.length > 0).map(([z]) => z)], pinned: false };
}

/**
 * Part or whole (§6.1), for one candidate camera's judged views (the whole
 * first): the best part when it keeps ≥ partShare of the whole camera's hits
 * AND passes a gate at least as high as the whole camera's (review #2418);
 * between parts, most hits, then the better gate, then lift, a name only on a
 * full tie, then the part's name. Pinned: the pinned view.
 */
function chooseView<O extends { part: string | null; k: number; lift: number; gate: LinkGate | null; names: { match: boolean } }>(
  judged: readonly O[],
  pinned: boolean,
  rules: LinkRules,
): { chosen: O; wholeK: number | null } {
  const whole = judged[0]!;
  if (pinned) {
    const chosen = judged[judged.length - 1]!;
    return { chosen, wholeK: chosen.part !== null ? whole.k : null };
  }
  const parts = judged.slice(1).filter((x) => x.k >= rules.partShare * whole.k && rank(x.gate) >= rank(whole.gate));
  parts.sort(
    (x, y) =>
      y.k - x.k ||
      rank(y.gate) - rank(x.gate) ||
      y.lift - x.lift ||
      Number(y.names.match) - Number(x.names.match) ||
      (x.part! < y.part! ? -1 : x.part! > y.part! ? 1 : 0),
  );
  const top = parts[0];
  return top ? { chosen: top, wholeK: whole.k } : { chosen: whole, wholeK: null };
}

/** What makes two results the same candidate in an area: the camera (any view of it), or the lock. */
function candidateKey(r: { anchor: LinkAnchor; camera: string | null; sourceRef: string }): string {
  return `${r.anchor.zoneId}\u0000${r.camera ?? r.sourceRef}`;
}

/** Per (area, candidate): the best gate, then the higher confidence, then the lower anchor link id. Sorted by area, then candidate. */
function bestPerCandidate<R extends { anchor: LinkAnchor; camera: string | null; sourceRef: string; gate: LinkGate | null; confidence: number }>(
  results: Iterable<R>,
): R[] {
  const best = new Map<string, R>();
  for (const result of results) {
    const key = candidateKey(result);
    const prev = best.get(key);
    if (
      !prev ||
      rank(result.gate) > rank(prev.gate) ||
      (rank(result.gate) === rank(prev.gate) &&
        (result.confidence > prev.confidence || (result.confidence === prev.confidence && result.anchor.linkId < prev.anchor.linkId)))
    ) {
      best.set(key, result);
    }
  }
  return [...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}

function prepareCameraPairs(input: CameraPairsInput): ScoredArm<PairCandidateResult> {
  const rules = input.rules ?? LINK_RULES;
  const debounced = new Map<string, number[]>();
  const anchorsOf = (camera: string, part: string | null): number[] => {
    const key = part === null ? camera : `${camera}/${part}`;
    let a = debounced.get(key);
    if (!a) {
      a = debounceAnchors(viewSeries(input.series, camera, part).instants, rules.debounceMs, rules.maxAnchors);
      debounced.set(key, a);
    }
    return a;
  };
  const blindOf = (camera: string): readonly Interval[] => input.blind.get(camera) ?? [];

  // (anchor view, candidate view) → both directions, scored once.
  const scored = new Map<string, { forward: DirectionStats; reverse: DirectionStats }>();
  const score = (anchorCam: string, anchorPart: string | null, cam: string, part: string | null) => {
    const key = `${anchorCam}/${anchorPart ?? ""}\u0000${cam}/${part ?? ""}`;
    let s = scored.get(key);
    if (!s) {
      s = {
        forward: scoreDirection(
          {
            anchors: anchorsOf(anchorCam, anchorPart),
            coverage: viewSeries(input.series, cam, part).coverage,
            blind: blindOf(cam),
            observedEnd: input.observedEnd,
          },
          rules,
        ),
        reverse: scoreDirection(
          {
            anchors: anchorsOf(cam, part),
            coverage: viewSeries(input.series, anchorCam, anchorPart).coverage,
            blind: blindOf(anchorCam),
            observedEnd: input.observedEnd,
          },
          rules,
        ),
      };
      scored.set(key, s);
    }
    return s;
  };

  // Pass 1 — score. Candidates: every camera with a person sighting in W, not the anchor's own.
  interface Pending {
    anchor: LinkAnchor;
    camera: string;
    options: Array<{ part: string | null; s: { forward: DirectionStats; reverse: DirectionStats } }>;
    pinned: boolean;
  }
  const pending: Pending[] = [];
  for (const anchor of input.anchors) {
    if (anchor.sourceKind === "lock") continue;
    const a = splitRef(anchor.sourceKind, anchor.sourceRef);
    for (const [camera, cs] of input.series) {
      if (camera === a.camera || cs.whole.instants.length === 0) continue;
      if (input.skipCamera(anchor.zoneId, camera)) continue;
      const { views, pinned } = candidateViews(cs, input.pinnedRef(anchor.zoneId, camera));
      pending.push({ anchor, camera, pinned, options: views.map((part) => ({ part, s: score(a.camera, a.part, camera, part) })) });
    }
  }

  return {
    hypotheses: 2 * scored.size,
    // Pass 2 — gate with the run's m, choose the view, keep the best anchor per (area, camera).
    judge: (m) => {
      const pAdj = (p: number) => Math.min(1, m * p);
      const out: PairCandidateResult[] = [];
      for (const p of pending) {
        const label = input.candidateLabel(p.camera);
        const judged = p.options.map((o) => {
          const forwardPAdj = pAdj(o.s.forward.pChance);
          const reversePAdj = pAdj(o.s.reverse.pChance);
          const gate = lowerGate(gateFor("cameraCamera", o.s.forward, forwardPAdj, rules), gateFor("cameraCamera", o.s.reverse, reversePAdj, rules));
          const names = namesMatch(p.anchor.zoneName, o.part === null ? `${label} ${p.camera}` : `${label} ${o.part}`);
          return { ...o, k: o.s.forward.k, lift: o.s.forward.lift, forwardPAdj, reversePAdj, gate, names };
        });
        const { chosen, wholeK } = chooseView(judged, p.pinned, rules);
        out.push({
          kind: "camera_camera",
          anchor: p.anchor,
          camera: p.camera,
          part: chosen.part,
          sourceKind: chosen.part === null ? "camera" : "camera_zone",
          sourceRef: chosen.part === null ? p.camera : `${p.camera}/${chosen.part}`,
          label,
          forward: chosen.s.forward,
          reverse: chosen.s.reverse,
          forwardPAdj: chosen.forwardPAdj,
          reversePAdj: chosen.reversePAdj,
          gate: chosen.gate,
          confidence: Math.min(chosen.s.forward.confidence, chosen.s.reverse.confidence),
          wholeK,
          names: chosen.names,
        });
      }
      return bestPerCandidate(out);
    },
  };
}

/**
 * Score every (anchor, candidate) of the camera ↔ camera arm and pick, per
 * area and candidate camera, the best anchor (gate, then confidence, then
 * link id) and the view (whole or part). `hypotheses` is this arm's m — every
 * (anchor source, candidate view, direction) scored, each counted once even
 * when two areas share an anchor source. Gates are applied only after every
 * scoring, with the final m. A run with locks uses `scoreLinkPairs`, whose m
 * counts both arms.
 */
export function scoreCameraPairs(input: CameraPairsInput): { results: PairCandidateResult[]; hypotheses: number } {
  const arm = prepareCameraPairs(input);
  return { results: arm.judge(arm.hypotheses), hypotheses: arm.hypotheses };
}

// ── lock ↔ camera (P4 PR-4, §6.2.1–§6.2.3) ────────────────────────────────

/** A `lock_state` row as the job loads it (P2b-2's lock adapter wrote it; epoch ms). */
export interface LockStateRow {
  /** `matter:<nodeId>/<endpointId>` — the lock; its lock links carry the same ref. */
  sourceRef: string;
  /** `labels[0]`: the reading. */
  reading: string | undefined;
  observed: "live" | "polled";
  dedupeKey: string;
  startedAt: number;
}

/**
 * Per lock: its CHANGES inside W (`isLockChange`: live, a turn, never the
 * baseline — lib/security-lock-changes.ts), sorted, not yet debounced. A lock
 * with none is absent: it is neither an anchor's statistic nor a candidate
 * (§6.2.2: "every lock endpoint with at least one live transition in W").
 */
export function buildLockSeries(rows: readonly LockStateRow[], window: LinkWindow): Map<string, number[]> {
  const raw = new Map<string, number[]>();
  for (const r of rows) {
    if (!isLockChange(r)) continue;
    if (r.startedAt < window.from || r.startedAt > window.observedEnd) continue;
    let t = raw.get(r.sourceRef);
    if (!t) raw.set(r.sourceRef, (t = []));
    t.push(r.startedAt);
  }
  const out = new Map<string, number[]>();
  for (const ref of [...raw.keys()].sort()) out.set(ref, raw.get(ref)!.sort((a, b) => a - b));
  return out;
}

export interface LockPairsInput extends CameraPairsInput {
  /** `buildLockSeries`: every lock with a live change in W. */
  locks: ReadonlyMap<string, readonly number[]>;
  /** Skip this lock for this area: the area already holds a row on it that Droplet must never touch. */
  skipLock: (zoneId: string, ref: string) => boolean;
  /** The lock's name (its device-list name). */
  lockLabel: (ref: string) => string;
}

/**
 * One (area, candidate) of the lock arm. ONE direction (§6.2.3): the anchors
 * are always the lock's changes and the coverage always a camera view's
 * people, whichever of the two a person placed in the area.
 */
export interface LockPairResult {
  kind: "lock_camera";
  anchor: LinkAnchor;
  /** The candidate camera; null when the candidate is the lock (a camera anchor). */
  camera: string | null;
  /** The chosen part of the candidate camera, or null (the whole camera, or a lock candidate). */
  part: string | null;
  sourceKind: "camera" | "camera_zone" | "lock";
  sourceRef: string;
  /** The candidate's display name: the camera's (never the part), or the lock's. */
  label: string;
  /** The lock's changes → the camera view's people. */
  forward: DirectionStats;
  forwardPAdj: number;
  gate: LinkGate | null;
  /** The forward confidence (one direction). */
  confidence: number;
  /** The whole camera's hits when a part was chosen; null otherwise. */
  wholeK: number | null;
  names: { match: boolean; shared: string[] };
}

function prepareLockPairs(input: LockPairsInput): ScoredArm<LockPairResult> {
  const rules = input.rules ?? LINK_RULES;
  const debounced = new Map<string, number[]>();
  const anchorsOf = (lock: string): number[] => {
    let a = debounced.get(lock);
    if (!a) {
      a = debounceAnchors(input.locks.get(lock) ?? [], rules.debounceMs, rules.maxAnchors);
      debounced.set(lock, a);
    }
    return a;
  };
  // (lock, camera view) → the one statistic, scored once however many anchors ask for it.
  const scored = new Map<string, DirectionStats>();
  const score = (lock: string, camera: string, part: string | null): DirectionStats => {
    const key = `${lock}\u0000${camera}/${part ?? ""}`;
    let s = scored.get(key);
    if (!s) {
      s = scoreDirection(
        {
          anchors: anchorsOf(lock),
          coverage: viewSeries(input.series, camera, part).coverage,
          blind: input.blind.get(camera) ?? [],
          observedEnd: input.observedEnd,
        },
        rules,
      );
      scored.set(key, s);
    }
    return s;
  };

  interface PendingCamera {
    anchor: LinkAnchor;
    camera: string;
    pinned: boolean;
    options: Array<{ part: string | null; s: DirectionStats }>;
  }
  interface PendingLock {
    anchor: LinkAnchor;
    lock: string;
    s: DirectionStats;
  }
  const cameras: PendingCamera[] = [];
  const locks: PendingLock[] = [];
  for (const anchor of input.anchors) {
    if (anchor.sourceKind === "lock") {
      // lock L → camera or part B. A lock with no live change in W has no statistic to offer.
      if (!input.locks.has(anchor.sourceRef)) continue;
      for (const [camera, cs] of input.series) {
        if (cs.whole.instants.length === 0 || input.skipCamera(anchor.zoneId, camera)) continue;
        const { views, pinned } = candidateViews(cs, input.pinnedRef(anchor.zoneId, camera));
        cameras.push({ anchor, camera, pinned, options: views.map((part) => ({ part, s: score(anchor.sourceRef, camera, part) })) });
      }
    } else {
      // camera or part C → lock L: anchors = L's changes, coverage = C's people (the same statistic, the other way round).
      const a = splitRef(anchor.sourceKind, anchor.sourceRef);
      for (const lock of input.locks.keys()) {
        if (input.skipLock(anchor.zoneId, lock)) continue;
        locks.push({ anchor, lock, s: score(lock, a.camera, a.part) });
      }
    }
  }

  return {
    hypotheses: scored.size,
    judge: (m) => {
      const pAdj = (p: number) => Math.min(1, m * p);
      const out: LockPairResult[] = [];
      for (const p of cameras) {
        const label = input.candidateLabel(p.camera);
        const judged = p.options.map((o) => {
          const forwardPAdj = pAdj(o.s.pChance);
          const names = namesMatch(p.anchor.zoneName, o.part === null ? `${label} ${p.camera}` : `${label} ${o.part}`);
          return { ...o, k: o.s.k, lift: o.s.lift, forwardPAdj, gate: gateFor("lockCamera", o.s, forwardPAdj, rules), names };
        });
        const { chosen, wholeK } = chooseView(judged, p.pinned, rules);
        out.push({
          kind: "lock_camera",
          anchor: p.anchor,
          camera: p.camera,
          part: chosen.part,
          sourceKind: chosen.part === null ? "camera" : "camera_zone",
          sourceRef: chosen.part === null ? p.camera : `${p.camera}/${chosen.part}`,
          label,
          forward: chosen.s,
          forwardPAdj: chosen.forwardPAdj,
          gate: chosen.gate,
          confidence: chosen.s.confidence,
          wholeK,
          names: chosen.names,
        });
      }
      for (const p of locks) {
        const label = input.lockLabel(p.lock);
        const forwardPAdj = pAdj(p.s.pChance);
        out.push({
          kind: "lock_camera",
          anchor: p.anchor,
          camera: null,
          part: null,
          sourceKind: "lock",
          sourceRef: p.lock,
          label,
          forward: p.s,
          forwardPAdj,
          gate: gateFor("lockCamera", p.s, forwardPAdj, rules),
          confidence: p.s.confidence,
          wholeK: null,
          names: namesMatch(p.anchor.zoneName, label),
        });
      }
      return bestPerCandidate(out);
    },
  };
}

/** The lock arm alone, its m its own (a run with cameras too uses `scoreLinkPairs`). */
export function scoreLockPairs(input: LockPairsInput): { results: LockPairResult[]; hypotheses: number } {
  const arm = prepareLockPairs(input);
  return { results: arm.judge(arm.hypotheses), hypotheses: arm.hypotheses };
}

/** A scored candidate of either arm. */
export type LinkCandidateResult = PairCandidateResult | LockPairResult;

/**
 * The run (§6.3 step 5): both arms scored, then gated with ONE m — the camera
 * arm's hypotheses plus the lock arm's — and, per (area, candidate), the best
 * gate over both arms (then confidence, then link id), naming its anchor
 * (§6.2.3: "the best gate wins, and the evidence names that anchor").
 */
export function scoreLinkPairs(input: LockPairsInput): { results: LinkCandidateResult[]; hypotheses: number } {
  const cameraArm = prepareCameraPairs(input);
  const lockArm = prepareLockPairs(input);
  const m = cameraArm.hypotheses + lockArm.hypotheses;
  return { results: bestPerCandidate<LinkCandidateResult>([...cameraArm.judge(m), ...lockArm.judge(m)]), hypotheses: m };
}

// ── evidence (§6.4) ───────────────────────────────────────────────────────

function toStatsV1(s: DirectionStats): DirectionStatsV1 {
  return {
    n: s.n,
    k: s.k,
    excluded: s.excluded,
    lambdaMilli: Math.round(s.lambda * 1000),
    liftTenths: Math.round(s.lift * 10),
    confidenceBp: Math.round(s.confidence * 10_000),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * What a camera ↔ camera link stores (LinkEvidenceV1): integers everywhere,
 * `pAdj` the WEAKER direction's as a 2-significant-digit string, and up to
 * five newest forward hits as samples (presence data: trimmed at 30 days).
 * The gate must not be null — only a gated candidate is ever written.
 */
export function cameraPairEvidence(r: PairCandidateResult, ctx: { window: LinkWindow; hypotheses: number }): LinkEvidenceV1 {
  if (r.gate === null) throw new Error("cameraPairEvidence: an ungated candidate has no evidence to store");
  return {
    v: 1,
    kind: "camera_camera",
    window: { from: iso(ctx.window.from), to: iso(ctx.window.observedEnd) },
    anchor: { linkId: r.anchor.linkId, sourceKind: r.anchor.sourceKind, sourceRef: r.anchor.sourceRef, label: r.anchor.label },
    candidate: { sourceKind: r.sourceKind, sourceRef: r.sourceRef, label: r.label },
    forward: toStatsV1(r.forward),
    reverse: toStatsV1(r.reverse),
    chosen: r.part === null ? "whole" : "part",
    wholeK: r.part === null ? null : (r.wholeK ?? r.forward.k),
    names: { match: r.names.match, shared: [...r.names.shared] },
    hypotheses: Math.max(1, ctx.hypotheses),
    pAdj: Math.max(r.forwardPAdj, r.reversePAdj).toPrecision(2),
    gate: r.gate,
    samples: r.forward.hits.slice(0, LINK_EVIDENCE_MAX_SAMPLES).map((h) => ({ anchorAt: iso(h.anchorAt), hitAt: iso(h.hitAt) })),
    samplesTrimmedBefore: null,
  };
}

/**
 * What a lock ↔ camera link stores (LinkEvidenceV1, `kind: lock_camera`): one
 * direction (`reverse` null), `chosen` the camera view — or `lock` when the
 * lock is the candidate (a camera anchor) — its pAdj as a 2-significant-digit
 * string, and up to five newest hits as samples (lock change → the moment the
 * camera had someone in view; presence data: trimmed at 30 days).
 */
export function lockPairEvidence(r: LockPairResult, ctx: { window: LinkWindow; hypotheses: number }): LinkEvidenceV1 {
  if (r.gate === null) throw new Error("lockPairEvidence: an ungated candidate has no evidence to store");
  const chosen = r.sourceKind === "lock" ? "lock" : r.part === null ? "whole" : "part";
  return {
    v: 1,
    kind: "lock_camera",
    window: { from: iso(ctx.window.from), to: iso(ctx.window.observedEnd) },
    anchor: { linkId: r.anchor.linkId, sourceKind: r.anchor.sourceKind, sourceRef: r.anchor.sourceRef, label: r.anchor.label },
    candidate: { sourceKind: r.sourceKind, sourceRef: r.sourceRef, label: r.label },
    forward: toStatsV1(r.forward),
    reverse: null,
    chosen,
    wholeK: chosen === "part" ? (r.wholeK ?? r.forward.k) : null,
    names: { match: r.names.match, shared: [...r.names.shared] },
    hypotheses: Math.max(1, ctx.hypotheses),
    pAdj: r.forwardPAdj.toPrecision(2),
    gate: r.gate,
    samples: r.forward.hits.slice(0, LINK_EVIDENCE_MAX_SAMPLES).map((h) => ({ anchorAt: iso(h.anchorAt), hitAt: iso(h.hitAt) })),
    samplesTrimmedBefore: null,
  };
}

/** The evidence either arm's candidate stores. */
export function linkPairEvidence(r: LinkCandidateResult, ctx: { window: LinkWindow; hypotheses: number }): LinkEvidenceV1 {
  return r.kind === "lock_camera" ? lockPairEvidence(r, ctx) : cameraPairEvidence(r, ctx);
}
