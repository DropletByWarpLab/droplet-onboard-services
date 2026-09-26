/**
 * WARP-2979 (ADR-059 P4 §6.4) — `LinkEvidenceV1`: what Droplet stored on a
 * link it made (`SecurityZoneLink.evidence`, set iff `origin = droplet`, CHECK
 * SecurityZoneLink_origin_shape), and the ONE validator every reader goes
 * through (`parseLinkEvidence`).
 *
 * Pure. Written by the hourly proposal job (security-link-proposals.service.ts),
 * read by route 3 (the "why" popover, DS-005: only when every source it names
 * is visible — `linkEvidenceSources`), route 23 (suggestions) and the nightly
 * sample trim (`trimLinkEvidence`, §6.16).
 *
 * Every number is an integer and `pAdj` is a string: Prisma's Json write keeps
 * 16 significant digits (security-audit.ts `securityRefs`), and the audit refs
 * copy several of these fields. The `confidence` COLUMN is the only float.
 *
 * `parseLinkEvidence` fails closed: anything that is not exactly this shape is
 * `null`, and a caller treats null as "no evidence to show" — never as "show
 * the raw JSON". The stored value is never trusted to be well-formed (a later
 * version, a hand edit, a half-written row from a bug).
 */

/** How many recent hits the evidence keeps ("Most recently: …"). Presence data: trimmed at 30 days (§6.16). */
export const LINK_EVIDENCE_MAX_SAMPLES = 5;

/** The kinds a link's evidence may name. `lock` arrives with P2b PR-2 and P4 PR-4. */
export const LINK_EVIDENCE_SOURCE_KINDS = ["lock", "camera", "camera_zone"] as const;
export type LinkEvidenceSourceKind = (typeof LINK_EVIDENCE_SOURCE_KINDS)[number];

/** One direction of the co-occurrence statistic (§6.1), every number an integer. */
export interface DirectionStatsV1 {
  /** Anchors counted (after the debounce, the cap and the blind-spell exclusion). */
  n: number;
  /** Hits: anchors with the candidate seeing a person within `pairMs`. `k ≤ n`. */
  k: number;
  /** Anchors dropped while the candidate was blind (offline, or Frigate down). */
  excluded: number;
  /** round(λ × 1000) — the hits chance alone would give. */
  lambdaMilli: number;
  /** round(lift × 10). */
  liftTenths: number;
  /** round(Wilson 95 % lower bound × 10 000), 0..10 000. */
  confidenceBp: number;
}

export interface LinkEvidenceSourceV1 {
  sourceKind: LinkEvidenceSourceKind;
  /** camera: `<frigateCamera>`; camera_zone: `<frigateCamera>/<frigateZone>`; lock: `matter:<node>/<ep>`. */
  sourceRef: string;
  /** The display name when the evidence was computed (a snapshot, like `sourceLabel`). */
  label: string;
}

export interface LinkEvidenceV1 {
  v: 1;
  kind: "lock_camera" | "camera_camera";
  /** ISO instants of the window W (§6.1). */
  window: { from: string; to: string };
  /** The person-set link the statistic was anchored on. */
  anchor: LinkEvidenceSourceV1 & { linkId: string };
  candidate: LinkEvidenceSourceV1;
  forward: DirectionStatsV1;
  /** camera_camera only (both directions must pass); null for lock_camera. */
  reverse: DirectionStatsV1 | null;
  chosen: "whole" | "part" | "lock";
  /** The whole camera's hits when a part was chosen (the 0.9 share, §6.1); null otherwise. */
  wholeK: number | null;
  /** The name tiebreak (§6.2.4) — never evidence, shown below the numbers. */
  names: { match: boolean; shared: string[] };
  /** m — the (anchor, candidate, direction) hypotheses scored in the run (Bonferroni). */
  hypotheses: number;
  /** min(1, m · pChance), e.g. "7.2e-18" — a string, never a float in Json. */
  pAdj: string;
  gate: "auto" | "propose";
  /** Up to LINK_EVIDENCE_MAX_SAMPLES most recent hits, newest first. */
  samples: Array<{ anchorAt: string; hitAt: string }>;
  /** Set by the nightly trim when it dropped samples; null until then. */
  samplesTrimmedBefore: string | null;
}

/** Exactly `Date.prototype.toISOString()`'s output — the only instant form the job writes. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A plain decimal or exponent number, no sign games, no hex, no `Infinity`. */
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i;

const MAX_REF = 160;
const MAX_LABEL = 120;
const MAX_SHARED = 16;
const MAX_TOKEN = 64;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The object has exactly these keys — no more (an unknown key is a shape this build does not know). */
function hasExactly(o: Obj, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function isInstant(v: unknown): v is string {
  return typeof v === "string" && ISO_INSTANT.test(v) && !Number.isNaN(Date.parse(v));
}

function isText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\u0000");
}

function parseStats(v: unknown): DirectionStatsV1 | null {
  if (!isObj(v) || !hasExactly(v, ["n", "k", "excluded", "lambdaMilli", "liftTenths", "confidenceBp"])) return null;
  const { n, k, excluded, lambdaMilli, liftTenths, confidenceBp } = v;
  if (![n, k, excluded, lambdaMilli, liftTenths, confidenceBp].every(isCount)) return null;
  if ((k as number) > (n as number) || (confidenceBp as number) > 10_000) return null;
  return {
    n: n as number,
    k: k as number,
    excluded: excluded as number,
    lambdaMilli: lambdaMilli as number,
    liftTenths: liftTenths as number,
    confidenceBp: confidenceBp as number,
  };
}

function parseSource(v: unknown, withLinkId: boolean): (LinkEvidenceSourceV1 & { linkId?: string }) | null {
  const keys = withLinkId ? ["linkId", "sourceKind", "sourceRef", "label"] : ["sourceKind", "sourceRef", "label"];
  if (!isObj(v) || !hasExactly(v, keys)) return null;
  if (!(LINK_EVIDENCE_SOURCE_KINDS as readonly unknown[]).includes(v.sourceKind)) return null;
  if (!isText(v.sourceRef, MAX_REF) || !isText(v.label, MAX_LABEL)) return null;
  if (withLinkId && !isText(v.linkId, 64)) return null;
  const out: LinkEvidenceSourceV1 & { linkId?: string } = {
    sourceKind: v.sourceKind as LinkEvidenceSourceKind,
    sourceRef: v.sourceRef,
    label: v.label,
  };
  if (withLinkId) out.linkId = v.linkId as string;
  return out;
}

/**
 * The stored `evidence` → `LinkEvidenceV1`, or null when it is not exactly
 * that shape (fail closed). Returns a fresh copy built only from the fields
 * it checked, never the input object.
 */
export function parseLinkEvidence(value: unknown): LinkEvidenceV1 | null {
  if (!isObj(value)) return null;
  const v = value;
  if (
    !hasExactly(v, [
      "v",
      "kind",
      "window",
      "anchor",
      "candidate",
      "forward",
      "reverse",
      "chosen",
      "wholeK",
      "names",
      "hypotheses",
      "pAdj",
      "gate",
      "samples",
      "samplesTrimmedBefore",
    ])
  ) {
    return null;
  }
  if (v.v !== 1) return null;
  if (v.kind !== "lock_camera" && v.kind !== "camera_camera") return null;

  if (!isObj(v.window) || !hasExactly(v.window, ["from", "to"])) return null;
  const { from, to } = v.window;
  if (!isInstant(from) || !isInstant(to) || Date.parse(from) > Date.parse(to)) return null;

  const anchor = parseSource(v.anchor, true);
  const candidate = parseSource(v.candidate, false);
  if (!anchor || !candidate) return null;

  const forward = parseStats(v.forward);
  if (!forward) return null;
  let reverse: DirectionStatsV1 | null = null;
  if (v.kind === "camera_camera") {
    reverse = parseStats(v.reverse);
    if (!reverse) return null;
  } else if (v.reverse !== null) {
    return null;
  }

  if (v.chosen !== "whole" && v.chosen !== "part" && v.chosen !== "lock") return null;
  // The whole camera's hits exist exactly when a part was chosen over it.
  if (v.chosen === "part" ? !isCount(v.wholeK) : v.wholeK !== null) return null;

  if (!isObj(v.names) || !hasExactly(v.names, ["match", "shared"])) return null;
  if (typeof v.names.match !== "boolean" || !Array.isArray(v.names.shared) || v.names.shared.length > MAX_SHARED) return null;
  if (!v.names.shared.every((t) => isText(t, MAX_TOKEN))) return null;
  if (v.names.match !== v.names.shared.length > 0) return null;

  if (!isCount(v.hypotheses) || v.hypotheses < 1) return null;
  if (typeof v.pAdj !== "string" || v.pAdj.length > 32 || !DECIMAL.test(v.pAdj)) return null;
  const p = Number(v.pAdj);
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  if (v.gate !== "auto" && v.gate !== "propose") return null;

  if (!Array.isArray(v.samples) || v.samples.length > LINK_EVIDENCE_MAX_SAMPLES) return null;
  const samples: Array<{ anchorAt: string; hitAt: string }> = [];
  for (const s of v.samples) {
    if (!isObj(s) || !hasExactly(s, ["anchorAt", "hitAt"]) || !isInstant(s.anchorAt) || !isInstant(s.hitAt)) return null;
    samples.push({ anchorAt: s.anchorAt, hitAt: s.hitAt });
  }
  if (v.samplesTrimmedBefore !== null && !isInstant(v.samplesTrimmedBefore)) return null;

  return {
    v: 1,
    kind: v.kind,
    window: { from, to },
    anchor: { linkId: anchor.linkId!, sourceKind: anchor.sourceKind, sourceRef: anchor.sourceRef, label: anchor.label },
    candidate: { sourceKind: candidate.sourceKind, sourceRef: candidate.sourceRef, label: candidate.label },
    forward,
    reverse,
    chosen: v.chosen,
    wholeK: v.chosen === "part" ? (v.wholeK as number) : null,
    names: { match: v.names.match, shared: [...(v.names.shared as string[])] },
    hypotheses: v.hypotheses,
    pAdj: v.pAdj,
    gate: v.gate,
    samples,
    samplesTrimmedBefore: v.samplesTrimmedBefore as string | null,
  };
}

/**
 * Every source the evidence NAMES — the anchor and the candidate. DS-005: the
 * evidence may be shown only to a viewer who can see ALL of them (route 3's
 * `evidence`, route 23's suggestions); a lock is visible only with
 * `mayReadLocks` (PR-4), so until then a caller that runs these through
 * `visibleLinks` drops a lock (unknown kind → malformed → hidden).
 */
export function linkEvidenceSources(e: LinkEvidenceV1): Array<{ sourceKind: LinkEvidenceSourceKind; sourceRef: string }> {
  return [
    { sourceKind: e.anchor.sourceKind, sourceRef: e.anchor.sourceRef },
    { sourceKind: e.candidate.sourceKind, sourceRef: e.candidate.sourceRef },
  ];
}
