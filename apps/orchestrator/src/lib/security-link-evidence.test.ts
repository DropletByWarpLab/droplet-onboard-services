/**
 * WARP-2979 (ADR-059 P4 §6.4) — the one validator for Droplet's link evidence.
 *
 * It fails CLOSED: a reader shows evidence only when it parses, so a shape
 * this build does not know must come back null — never half-read, never the
 * raw object.
 */
import { describe, it, expect } from "vitest";
import {
  LINK_EVIDENCE_MAX_SAMPLES,
  linkEvidenceSources,
  parseLinkEvidence,
  type LinkEvidenceV1,
} from "./security-link-evidence.js";

/** §6.1's camera ↔ camera worked example (Stock cam A → Stock cam B), as the job stores it. */
function cameraEvidence(): LinkEvidenceV1 {
  return {
    v: 1,
    kind: "camera_camera",
    window: { from: "2026-09-10T14:00:00.000Z", to: "2026-09-24T13:45:00.000Z" },
    anchor: { linkId: "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61", sourceKind: "camera", sourceRef: "stock_a", label: "Stock cam A" },
    candidate: { sourceKind: "camera", sourceRef: "stock_b", label: "Stock cam B" },
    forward: { n: 40, k: 34, excluded: 0, lambdaMilli: 2000, liftTenths: 170, confidenceBp: 7090 },
    reverse: { n: 45, k: 36, excluded: 1, lambdaMilli: 2700, liftTenths: 133, confidenceBp: 6620 },
    chosen: "whole",
    wholeK: null,
    names: { match: true, shared: ["stock"] },
    hypotheses: 12,
    pAdj: "1.1e-27",
    gate: "auto",
    samples: [
      { anchorAt: "2026-09-23T14:14:02.000Z", hitAt: "2026-09-23T14:14:05.000Z" },
      { anchorAt: "2026-09-22T09:02:11.000Z", hitAt: "2026-09-22T09:02:13.500Z" },
    ],
    samplesTrimmedBefore: null,
  };
}

/** §6.1's lock ↔ camera worked example (PR-4 writes these; the validator knows them now). */
function lockEvidence(): LinkEvidenceV1 {
  return {
    ...cameraEvidence(),
    kind: "lock_camera",
    anchor: { linkId: "l-lock", sourceKind: "lock", sourceRef: "matter:4/1", label: "Back door lock" },
    candidate: { sourceKind: "camera_zone", sourceRef: "back/back_door", label: "Back camera" },
    forward: { n: 14, k: 12, excluded: 0, lambdaMilli: 168, liftTenths: 714, confidenceBp: 6010 },
    reverse: null,
    chosen: "part",
    wholeK: 12,
    names: { match: true, shared: ["back", "door"] },
    hypotheses: 8,
    pAdj: "7.2e-18",
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("parseLinkEvidence", () => {
  it("round-trips both worked examples through JSON (what Postgres hands back) — a copy, never the input", () => {
    for (const e of [cameraEvidence(), lockEvidence()]) {
      const stored = clone(e);
      const parsed = parseLinkEvidence(stored);
      expect(parsed).toEqual(e);
      expect(parsed).not.toBe(stored);
      expect(parsed!.samples).not.toBe(stored.samples);
    }
  });

  it("anything that is not an object is null", () => {
    for (const v of [null, undefined, 1, "x", true, [], [cameraEvidence()]]) expect(parseLinkEvidence(v)).toBeNull();
  });

  const mutations: Array<[string, (e: Record<string, any>) => void]> = [
    ["another version", (e) => (e.v = 2)],
    ["an unknown kind", (e) => (e.kind = "zone_sales")],
    ["an unknown extra key", (e) => (e.note = "hi")],
    ["a missing key", (e) => delete e.samplesTrimmedBefore],
    ["a window that ends before it starts", (e) => (e.window = { from: "2026-09-24T13:45:00.000Z", to: "2026-09-10T14:00:00.000Z" })],
    ["a window instant not in toISOString form", (e) => (e.window.from = "2026-09-10 14:00")],
    ["an anchor without its link id", (e) => delete e.anchor.linkId],
    ["an anchor of an unknown kind", (e) => (e.anchor.sourceKind = "zone")],
    ["an empty candidate ref", (e) => (e.candidate.sourceRef = "")],
    ["a candidate with a link id", (e) => (e.candidate.linkId = "x")],
    ["a fraction in the stats (Json keeps 16 digits)", (e) => (e.forward.lambdaMilli = 2000.5)],
    ["a negative count", (e) => (e.forward.excluded = -1)],
    ["more hits than anchors", (e) => (e.forward.k = 41)],
    ["a confidence above 10 000 bp", (e) => (e.forward.confidenceBp = 10_001)],
    ["camera ↔ camera without its reverse direction", (e) => (e.reverse = null)],
    ["an unknown chosen", (e) => (e.chosen = "half")],
    ["wholeK on a whole-camera choice", (e) => (e.wholeK = 3)],
    ["names that match with nothing shared", (e) => (e.names = { match: true, shared: [] })],
    ["names that share a token but say no match", (e) => (e.names = { match: false, shared: ["stock"] })],
    ["zero hypotheses", (e) => (e.hypotheses = 0)],
    ["pAdj as a float", (e) => (e.pAdj = 1.1e-27)],
    ["pAdj above 1", (e) => (e.pAdj = "1.5")],
    ["pAdj that is not a number", (e) => (e.pAdj = "NaN")],
    ["pAdj as hex", (e) => (e.pAdj = "0x1")],
    ["an unknown gate", (e) => (e.gate = "maybe")],
    ["too many samples", (e) => (e.samples = Array.from({ length: LINK_EVIDENCE_MAX_SAMPLES + 1 }, () => e.samples[0]))],
    ["a sample with a bad instant", (e) => (e.samples[0].hitAt = "yesterday")],
    ["a sample with an extra key", (e) => (e.samples[0].camera = "stock_b")],
    ["a trim marker that is not an instant", (e) => (e.samplesTrimmedBefore = 0)],
  ];
  it.each(mutations)("fails closed on %s", (_name, mutate) => {
    const e = clone(cameraEvidence()) as unknown as Record<string, any>;
    mutate(e);
    expect(parseLinkEvidence(e)).toBeNull();
  });

  it("lock ↔ camera must NOT carry a reverse direction, and a part choice must carry wholeK", () => {
    const withReverse = clone(lockEvidence()) as unknown as Record<string, any>;
    withReverse.reverse = cameraEvidence().forward;
    expect(parseLinkEvidence(withReverse)).toBeNull();
    const noWhole = clone(lockEvidence()) as unknown as Record<string, any>;
    noWhole.wholeK = null;
    expect(parseLinkEvidence(noWhole)).toBeNull();
  });

  it("a trimmed evidence (no samples, a trim marker) still parses — the aggregates are what the link was decided on", () => {
    const trimmed = { ...cameraEvidence(), samples: [], samplesTrimmedBefore: "2026-08-26T03:50:00.000Z" };
    expect(parseLinkEvidence(clone(trimmed))).toEqual(trimmed);
  });

  it("pAdj of exactly 1 or 0, and plain decimals, parse", () => {
    for (const pAdj of ["1", "0", "0.0012", "4.1e-14", "7.2E-18"]) {
      expect(parseLinkEvidence({ ...clone(cameraEvidence()), pAdj })?.pAdj, pAdj).toBe(pAdj);
    }
  });
});

describe("linkEvidenceSources — what DS-005 must find visible before the evidence is shown", () => {
  it("names the anchor and the candidate, nothing else", () => {
    expect(linkEvidenceSources(cameraEvidence())).toEqual([
      { sourceKind: "camera", sourceRef: "stock_a" },
      { sourceKind: "camera", sourceRef: "stock_b" },
    ]);
    expect(linkEvidenceSources(lockEvidence())).toEqual([
      { sourceKind: "lock", sourceRef: "matter:4/1" },
      { sourceKind: "camera_zone", sourceRef: "back/back_door" },
    ]);
  });
});
