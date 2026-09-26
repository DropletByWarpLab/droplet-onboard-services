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
 * Camera ↔ camera (PR-1's only arm; the lock arm is PR-4) must pass BOTH
 * directions: A's visits → B, and B's visits → A. The pair takes the lower
 * gate and the lower confidence. For each candidate camera B the whole view
 * and every part seen in B's sightings are scored; the best part F* is taken
 * when it keeps ≥ 90 % of the whole camera's hits.
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

/** A person-set active camera / camera_zone link in an active area (§6.2.1). */
export interface LinkAnchor {
  linkId: string;
  zoneId: string;
  zoneName: string;
  sourceKind: "camera" | "camera_zone";
  sourceRef: string;
  /** The anchor camera's display name. */
  label: string;
}

/** One (area, candidate camera) after scoring: the best anchor in that area, and the chosen view. */
export interface PairCandidateResult {
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
 * Score every (anchor, candidate) of the run and pick, per area and candidate
 * camera, the best anchor (gate, then confidence, then link id) and the view
 * (whole or part). `hypotheses` is m — every (anchor source, candidate view,
 * direction) scored, each counted once even when two areas share an anchor
 * source. Gates are applied only after every scoring, with the final m.
 */
export function scoreCameraPairs(input: CameraPairsInput): { results: PairCandidateResult[]; hypotheses: number } {
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
  interface Option {
    part: string | null;
    s: { forward: DirectionStats; reverse: DirectionStats };
  }
  interface Pending {
    anchor: LinkAnchor;
    camera: string;
    options: Option[];
    pinned: boolean;
  }
  const pending: Pending[] = [];
  for (const anchor of input.anchors) {
    const a = splitRef(anchor.sourceKind, anchor.sourceRef);
    for (const [camera, cs] of input.series) {
      if (camera === a.camera || cs.whole.instants.length === 0) continue;
      if (input.skipCamera(anchor.zoneId, camera)) continue;
      const pin = input.pinnedRef(anchor.zoneId, camera);
      const pinnedPart = pin ? splitRef(pin.sourceKind, pin.sourceRef).part : undefined;
      // Pinned: the whole camera (for `wholeK`) and the pinned view only. Else the whole and every part seen in W.
      const parts: Array<string | null> =
        pinnedPart !== undefined
          ? pinnedPart === null
            ? [null]
            : [null, pinnedPart]
          : [null, ...[...cs.parts.entries()].filter(([, ps]) => ps.instants.length > 0).map(([z]) => z)];
      pending.push({
        anchor,
        camera,
        pinned: pinnedPart !== undefined,
        options: parts.map((part) => ({ part, s: score(a.camera, a.part, camera, part) })),
      });
    }
  }
  const hypotheses = 2 * scored.size;

  // Pass 2 — gate with the final m, choose the view, keep the best anchor per (area, camera).
  const pAdj = (p: number) => Math.min(1, hypotheses * p);
  const best = new Map<string, PairCandidateResult>();
  for (const p of pending) {
    const label = input.candidateLabel(p.camera);
    const judged = p.options.map((o) => {
      const forwardPAdj = pAdj(o.s.forward.pChance);
      const reversePAdj = pAdj(o.s.reverse.pChance);
      const gate = lowerGate(gateFor("cameraCamera", o.s.forward, forwardPAdj, rules), gateFor("cameraCamera", o.s.reverse, reversePAdj, rules));
      const names = namesMatch(p.anchor.zoneName, o.part === null ? `${label} ${p.camera}` : `${label} ${o.part}`);
      return { ...o, forwardPAdj, reversePAdj, gate, names };
    });
    const whole = judged[0]!;
    let chosen = whole;
    let wholeK: number | null = null;
    if (p.pinned) {
      chosen = judged[judged.length - 1]!;
      if (chosen.part !== null) wholeK = whole.s.forward.k;
    } else {
      // A part is eligible only when it keeps ≥ partShare of the whole camera's hits AND passes a gate at least
      // as high as the whole camera's (review #2418): back, a part counts only its OWN visits — always fewer
      // than the whole camera's — so a part can keep the hits and still fall below a bar the whole camera cleared.
      const parts = judged
        .slice(1)
        .filter((x) => x.s.forward.k >= rules.partShare * whole.s.forward.k && rank(x.gate) >= rank(whole.gate));
      // Most hits; then the better gate; then lift; a name only breaks a full tie; then the part's name.
      parts.sort(
        (x, y) =>
          y.s.forward.k - x.s.forward.k ||
          rank(y.gate) - rank(x.gate) ||
          y.s.forward.lift - x.s.forward.lift ||
          Number(y.names.match) - Number(x.names.match) ||
          (x.part! < y.part! ? -1 : x.part! > y.part! ? 1 : 0),
      );
      const top = parts[0];
      if (top) {
        chosen = top;
        wholeK = whole.s.forward.k;
      }
    }
    const result: PairCandidateResult = {
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
    };
    const key = `${p.anchor.zoneId}\u0000${p.camera}`;
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
  const results = [...best.values()].sort(
    (a, b) => (a.anchor.zoneId < b.anchor.zoneId ? -1 : a.anchor.zoneId > b.anchor.zoneId ? 1 : 0) || (a.camera < b.camera ? -1 : a.camera > b.camera ? 1 : 0),
  );
  return { results, hypotheses };
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
