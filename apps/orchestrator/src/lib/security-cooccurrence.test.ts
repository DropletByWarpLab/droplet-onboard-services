/**
 * WARP-2979 (ADR-059 P4 §6.1, §6.2, §9) — the co-occurrence arithmetic behind
 * Droplet's link proposals. Pure: every case builds its own timeline in epoch
 * ms, and §6.1's camera ↔ camera worked example is reproduced number by
 * number (the lock example is PR-4's).
 *
 * The fixtures that guard the design, each named for the mutation it kills
 * (§10):
 *   · the ±10 s edges (the pad widened);
 *   · the busy-at-the-same-hours camera (local chance replaced by the
 *     whole-window rate);
 *   · the blind spell (exclusion removed); the burst (debounce removed);
 *   · Bonferroni's m; Wilson against the raw k/n;
 *   · the street camera (the reverse direction ignored);
 *   · the part share.
 */
import { describe, it, expect } from "vitest";
import {
  LINK_RULES,
  blindSpells,
  buildCameraSeries,
  cameraPairEvidence,
  coveredMs,
  debounceAnchors,
  gateFor,
  lowerGate,
  linkWindow,
  mergeIntervals,
  nameTokens,
  namesMatch,
  poissonTail,
  scoreCameraPairs,
  scoreDirection,
  wilsonLowerBound,
  type CameraSeries,
  type DirectionInput,
  type Interval,
  type LinkAnchor,
  type PersonSighting,
} from "./security-cooccurrence.js";
import { poissonUpperTail } from "./security-stats.js";
import { parseLinkEvidence } from "./security-link-evidence.js";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DAY = 24 * H;
/** A fixed "now" for the pipeline fixtures: Thu 2026-09-24 14:00 UTC. */
const NOW = Date.UTC(2026, 8, 24, 14, 0, 0);
const W = linkWindow(NOW);

describe("mergeIntervals / coveredMs", () => {
  it("merges overlapping and touching intervals, in any input order", () => {
    expect(
      mergeIntervals([
        { start: 50, end: 60 },
        { start: 0, end: 10 },
        { start: 10, end: 20 }, // touching → merged
        { start: 5, end: 8 }, // nested
        { start: 21, end: 30 }, // a 1 ms gap → apart
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 21, end: 30 },
      { start: 50, end: 60 },
    ]);
    expect(mergeIntervals([])).toEqual([]);
  });

  it("measures only what falls inside [from, to]", () => {
    const m = mergeIntervals([
      { start: 0, end: 100 },
      { start: 200, end: 300 },
    ]);
    expect(coveredMs(m, 50, 250)).toBe(50 + 50);
    expect(coveredMs(m, -100, 1000)).toBe(200);
    expect(coveredMs(m, 100, 200)).toBe(0);
    expect(coveredMs(m, 120, 180)).toBe(0);
    expect(coveredMs([], 0, 10)).toBe(0);
  });
});

describe("debounceAnchors", () => {
  it("drops an instant within 60 s of the previous KEPT instant — not of the previous instant", () => {
    // 50 s is dropped (within 60 s of 0); 100 s is 100 s after the last KEPT one (0), so it is kept,
    // although it is only 50 s after the dropped 50 s. 130 s is within 60 s of 100 s.
    expect(debounceAnchors([0, 50 * S, 100 * S, 130 * S], 60 * S, 500)).toEqual([0, 100 * S]);
    expect(debounceAnchors([0, 60 * S, 61 * S], 60 * S, 500)).toEqual([0, 61 * S]);
  });

  it("keeps the latest maxAnchors", () => {
    const many = Array.from({ length: 10 }, (_, i) => i * H);
    expect(debounceAnchors(many, 60 * S, 3)).toEqual([7 * H, 8 * H, 9 * H]);
  });
});

/** One person sighting on a camera, `durS` seconds long, in the given parts. */
const seen = (camera: string, at: number, durS = 4, zones: string[] = []): PersonSighting => ({
  camera,
  zones,
  startedAt: at,
  endedAt: at + durS * S,
});

describe("buildCameraSeries — the ±10 s pair window", () => {
  const T = W.from + 2 * DAY;

  function hitAt(sighting: PersonSighting): number {
    const series = buildCameraSeries([sighting], W);
    const cov = series.get("b")!.whole.coverage;
    return scoreDirection({ anchors: [T], coverage: cov, blind: [], observedEnd: W.observedEnd }).k;
  }

  it("a sighting starting exactly 10 s after the anchor is a hit; 10.001 s is not", () => {
    expect(hitAt({ camera: "b", zones: [], startedAt: T + 10 * S, endedAt: T + 12 * S })).toBe(1);
    expect(hitAt({ camera: "b", zones: [], startedAt: T + 10 * S + 1, endedAt: T + 12 * S })).toBe(0);
  });

  it("a sighting that ENDED exactly 10 s before the anchor is a hit; 10.001 s is not", () => {
    expect(hitAt({ camera: "b", zones: [], startedAt: T - 30 * S, endedAt: T - 10 * S })).toBe(1);
    expect(hitAt({ camera: "b", zones: [], startedAt: T - 30 * S, endedAt: T - 10 * S - 1 })).toBe(0);
  });

  it("a sighting with no end is padded around its start", () => {
    expect(hitAt({ camera: "b", zones: [], startedAt: T - 10 * S, endedAt: null })).toBe(1);
    expect(hitAt({ camera: "b", zones: [], startedAt: T - 11 * S, endedAt: null })).toBe(0);
  });

  it("instants are the starts inside W only; coverage reaches back half an hour before W for the first anchors' chance", () => {
    const series = buildCameraSeries(
      [seen("b", W.from - 20 * MIN), seen("b", W.from + H, 4, ["door"]), seen("b", W.observedEnd + MIN)],
      W,
    );
    const b = series.get("b")!;
    expect(b.whole.instants).toEqual([W.from + H]);
    expect(b.whole.coverage[0]!.start).toBe(W.from - 20 * MIN - 10 * S);
    expect([...b.parts.keys()]).toEqual(["door"]);
    expect(b.parts.get("door")!.instants).toEqual([W.from + H]);
  });
});

describe("blindSpells", () => {
  it("a camera's offline → online spells, and Frigate-wide spells, blind every camera; an open spell runs to E", () => {
    const blind = blindSpells(
      [
        { camera: "b", kind: "offline", at: W.from + DAY },
        { camera: "b", kind: "online", at: W.from + DAY + H },
        { camera: null, kind: "offline", at: W.from + 3 * DAY },
        { camera: null, kind: "online", at: W.from + 3 * DAY + 10 * MIN },
        { camera: "c", kind: "offline", at: W.from + 5 * DAY },
      ],
      ["a", "b", "c"],
      W,
    );
    expect(blind.get("a")).toEqual([{ start: W.from + 3 * DAY, end: W.from + 3 * DAY + 10 * MIN }]);
    expect(blind.get("b")).toEqual([
      { start: W.from + DAY, end: W.from + DAY + H },
      { start: W.from + 3 * DAY, end: W.from + 3 * DAY + 10 * MIN },
    ]);
    expect(blind.get("c")).toEqual([
      { start: W.from + 3 * DAY, end: W.from + 3 * DAY + 10 * MIN },
      { start: W.from + 5 * DAY, end: W.observedEnd },
    ]);
  });
});

/**
 * A direction whose numbers are exactly given: `n` anchors two hours apart,
 * each local window holding λ/n of its hour as coverage — around the anchor
 * for the `k` hits, ten minutes after it for the rest.
 */
function direction(n: number, k: number, lambda: number): DirectionInput {
  const perWindow = (lambda / n) * H;
  const anchors: number[] = [];
  const coverage: Interval[] = [];
  const start = W.from + H;
  for (let i = 0; i < n; i += 1) {
    const t = start + i * 2 * H;
    anchors.push(t);
    coverage.push(i < k ? { start: t - perWindow / 2, end: t + perWindow / 2 } : { start: t + 10 * MIN, end: t + 10 * MIN + perWindow });
  }
  return { anchors, coverage, blind: [], observedEnd: start + n * 2 * H + DAY };
}

describe("scoreDirection", () => {
  it("λ = Σ q_i with q_i the covered share of the hour around each anchor; lift = k / λ", () => {
    const s = scoreDirection(direction(10, 4, 0.5));
    expect(s).toMatchObject({ n: 10, k: 4, excluded: 0 });
    expect(s.lambda).toBeCloseTo(0.5, 9);
    expect(s.lift).toBeCloseTo(8, 9);
    expect(s.pChance).toBeCloseTo(poissonUpperTail(4, s.lambda), 15);
    expect(s.hits.map((h) => h.anchorAt)).toEqual([...direction(10, 4, 0.5).anchors.slice(0, 4)].reverse());
  });

  it("k = 0 → lift 0 and pChance 1; no anchors → confidence 0", () => {
    const s = scoreDirection(direction(10, 0, 0.5));
    expect(s).toMatchObject({ k: 0, lift: 0, pChance: 1 });
    expect(scoreDirection({ anchors: [], coverage: [], blind: [], observedEnd: NOW })).toMatchObject({ n: 0, k: 0, lambda: 0, confidence: 0 });
  });

  it("the local window is clipped at E: an anchor 10 min before E has a 40-minute window", () => {
    const E = W.observedEnd;
    const t = E - 10 * MIN;
    const s = scoreDirection({ anchors: [t], coverage: [{ start: t - 2 * MIN, end: t + 2 * MIN }], blind: [], observedEnd: E });
    expect(s.lambda).toBeCloseTo(4 / 40, 12);
  });

  it("an anchor while the candidate was blind is excluded — neither a hit nor a miss", () => {
    const d = direction(10, 4, 0.5);
    // Blind over anchors 0 (a hit) and 5 (a miss).
    const blind = mergeIntervals([
      { start: d.anchors[0]! - MIN, end: d.anchors[0]! + MIN },
      { start: d.anchors[5]! - MIN, end: d.anchors[5]! + MIN },
    ]);
    const s = scoreDirection({ ...d, blind });
    expect(s).toMatchObject({ n: 8, k: 3, excluded: 2 });
    expect(s.lambda).toBeCloseTo(0.5 * (8 / 10), 9);
  });

  it("a hit's `hitAt` is the moment nearest the anchor when the candidate had someone in view (unpadded)", () => {
    const T = W.from + DAY;
    const series = buildCameraSeries([seen("b", T + 6 * S, 4)], W);
    const s = scoreDirection({ anchors: [T], coverage: series.get("b")!.whole.coverage, blind: [], observedEnd: W.observedEnd });
    expect(s.hits).toEqual([{ anchorAt: T, hitAt: T + 6 * S }]);
  });

  it("LOCAL chance: a camera that is busy exactly when the anchor is busy does not look linked", () => {
    // Every day 10:00–12:00 the candidate has someone in view 62.5 % of the time (5 s every 40 s,
    // padded ±10 s); the anchor's two daily visits (10:15, 11:15) fall on sightings. Over the whole
    // fortnight the candidate is covered ~5 % of the time — a whole-window rate would call it linked.
    const sightings: PersonSighting[] = [];
    const anchors: number[] = [];
    for (let d = 1; d <= 14; d += 1) {
      const day = W.from - (W.from % DAY) + d * DAY;
      for (let t = day + 10 * H; t < day + 12 * H; t += 40 * S) sightings.push(seen("busy", t, 5));
      anchors.push(day + 10 * H + 15 * MIN + 20 * S, day + 11 * H + 15 * MIN + 20 * S); // on a sighting
    }
    const inW = anchors.filter((t) => t >= W.from && t <= W.observedEnd);
    const cov = buildCameraSeries(sightings, W).get("busy")!.whole.coverage;
    const s = scoreDirection({ anchors: inW, coverage: cov, blind: [], observedEnd: W.observedEnd });
    expect(s.n).toBeGreaterThanOrEqual(20);
    expect(s.k).toBe(s.n);
    expect(s.lift).toBeLessThan(2);
    expect(gateFor("cameraCamera", s, 1e-30)).toBeNull();
  });
});

describe("poissonTail — P5's shared tail, imported, never a second copy (D29)", () => {
  it("is security-stats' poissonUpperTail itself", () => {
    expect(poissonTail).toBe(poissonUpperTail);
  });

  it("§9's pins: (12, 0.168) ≈ 9.04e−19, (9, 6.3) ≈ 0.185, k = 0 → 1, and the far tail does not underflow to a wrong 0", () => {
    expect(Math.abs(poissonTail(12, 0.168) / 9.04e-19 - 1)).toBeLessThan(1e-3);
    expect(Math.abs(poissonTail(9, 6.3) / 0.185 - 1)).toBeLessThan(2e-3);
    expect(poissonTail(0, 3)).toBe(1);
    const far = poissonTail(34, 2.0);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(1e-26);
  });

  it("PROPERTY: never optimistic — ≥ the exact Poisson-binomial tail for 500 random q vectors, whenever k ≥ λ + 1", () => {
    let seed = 0x2979;
    const rand = () => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let checked = 0;
    for (let trial = 0; trial < 500; trial += 1) {
      const n = 1 + Math.floor(rand() * 60);
      const q = Array.from({ length: n }, () => rand() * (rand() < 0.5 ? 0.05 : 0.4));
      // dist[j] = P(exactly j hits), by dynamic programming.
      let dist = [1];
      for (const p of q) {
        const next = new Array<number>(dist.length + 1).fill(0);
        for (let j = 0; j < dist.length; j += 1) {
          next[j]! += dist[j]! * (1 - p);
          next[j + 1]! += dist[j]! * p;
        }
        dist = next;
      }
      const lambda = q.reduce((a, b) => a + b, 0);
      for (let k = Math.ceil(lambda + 1); k <= n; k += 1) {
        let exact = 0;
        for (let j = k; j <= n; j += 1) exact += dist[j]!;
        expect(poissonTail(k, lambda), `n=${n} λ=${lambda} k=${k}`).toBeGreaterThanOrEqual(exact * (1 - 1e-9));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("wilsonLowerBound", () => {
  it("§6.1's values: 9/10 = 0.596, 8/10 = 0.490, 12/14 = 0.601, 5/6 = 0.436; n = 0 → 0", () => {
    expect(wilsonLowerBound(9, 10)).toBeCloseTo(0.596, 3);
    expect(wilsonLowerBound(8, 10)).toBeCloseTo(0.49, 3);
    expect(wilsonLowerBound(12, 14)).toBeCloseTo(0.601, 3);
    expect(wilsonLowerBound(5, 6)).toBeCloseTo(0.436, 3);
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 5)).toBeCloseTo(0, 12);
  });

  it("penalises a small sample by itself: 10 of 10 is not 'certain'", () => {
    expect(wilsonLowerBound(10, 10)).toBeLessThan(0.75);
  });
});

describe("the gates (LINK_RULES) and §6.1's camera ↔ camera worked example", () => {
  const m = 12;
  const pAdj = (p: number) => Math.min(1, m * p);

  it("Stock cam B: both directions pass `auto` → auto, stored confidence the lower one (0.662)", () => {
    const fwd = scoreDirection(direction(40, 34, 2.0));
    const rev = scoreDirection(direction(45, 36, 2.7));
    expect(fwd).toMatchObject({ n: 40, k: 34 });
    expect(fwd.lambda).toBeCloseTo(2.0, 9);
    expect(fwd.lift).toBeCloseTo(17.0, 6);
    expect(fwd.confidence).toBeCloseTo(0.709, 3);
    expect(rev).toMatchObject({ n: 45, k: 36 });
    expect(rev.lambda).toBeCloseTo(2.7, 9);
    expect(rev.lift).toBeCloseTo(13.3, 1);
    expect(rev.confidence).toBeCloseTo(0.662, 3);
    expect(pAdj(fwd.pChance)).toBeLessThan(1e-26);
    expect(pAdj(rev.pChance)).toBeLessThan(1e-26);
    expect(gateFor("cameraCamera", fwd, pAdj(fwd.pChance))).toBe("auto");
    expect(gateFor("cameraCamera", rev, pAdj(rev.pChance))).toBe("auto");
    expect(lowerGate(gateFor("cameraCamera", fwd, pAdj(fwd.pChance)), gateFor("cameraCamera", rev, pAdj(rev.pChance)))).toBe("auto");
    expect(Math.min(fwd.confidence, rev.confidence)).toBeCloseTo(0.662, 3);
  });

  it("Street cam C: A's visits → C pass `propose`, C's visits → A fail → nothing (the mutual rule)", () => {
    const fwd = scoreDirection(direction(40, 30, 3.2));
    const rev = scoreDirection(direction(300, 35, 15));
    expect(fwd.lift).toBeCloseTo(9.4, 1);
    expect(fwd.confidence).toBeCloseTo(0.598, 3);
    expect(rev.lift).toBeCloseTo(2.3, 1);
    expect(rev.confidence).toBeCloseTo(0.085, 3);
    expect(gateFor("cameraCamera", fwd, pAdj(fwd.pChance))).toBe("propose");
    expect(gateFor("cameraCamera", rev, pAdj(rev.pChance))).toBeNull();
    expect(lowerGate("propose", null)).toBeNull();
  });

  it("a candidate gets the highest gate it passes, and every threshold is inclusive", () => {
    const at = (over: Partial<ReturnType<typeof scoreDirection>>) => ({ ...scoreDirection(direction(30, 20, 1)), ...over });
    const auto = LINK_RULES.cameraCamera.auto;
    const edge = at({ n: auto.minN, k: auto.minK, lift: auto.minLift, confidence: auto.minConfidence });
    expect(gateFor("cameraCamera", edge, auto.maxPAdj)).toBe("auto");
    expect(gateFor("cameraCamera", { ...edge, n: auto.minN - 1 }, auto.maxPAdj)).toBe("propose");
    expect(gateFor("cameraCamera", edge, auto.maxPAdj * 1.01)).toBe("propose");
    expect(gateFor("cameraCamera", { ...edge, confidence: 0.39 }, 1e-9)).toBeNull();
    expect(lowerGate("auto", "propose")).toBe("propose");
    expect(lowerGate("auto", "auto")).toBe("auto");
  });
});

describe("nameTokens / namesMatch — a tiebreak, never evidence (§6.2.4)", () => {
  it("lower-cases, splits camelCase and non-alphanumerics, drops short tokens and the stopwords", () => {
    expect(nameTokens("Back door")).toEqual(["back", "door"]);
    expect(nameTokens("back_door")).toEqual(["back", "door"]);
    expect(nameTokens("StockCamA")).toEqual(["stock"]);
    expect(nameTokens("The main camera view")).toEqual([]);
    expect(nameTokens("Lock on the till")).toEqual(["till"]);
  });

  it("matches when the names share a token", () => {
    expect(namesMatch("Back door", "back_cam back_door")).toEqual({ match: true, shared: ["back", "door"] });
    expect(namesMatch("Stock room", "Yard camera")).toEqual({ match: false, shared: [] });
  });
});

// ── the pipeline: anchors × candidates, part or whole, Bonferroni, both directions ──

/** Build sightings: `shared` visits both cameras see (B 2 s after A), plus each camera's own. */
function world(opts: {
  shared: number;
  aOnly: number;
  bOnly: number;
  bZones?: (i: number) => string[];
  c?: { withA: number; own: number };
}): PersonSighting[] {
  const out: PersonSighting[] = [];
  let t = W.from + 2 * H;
  const step = 3 * H + 7 * MIN; // visits far enough apart that local windows never overlap
  for (let i = 0; i < opts.shared; i += 1, t += step) {
    out.push(seen("a", t), seen("b", t + 2 * S, 4, opts.bZones?.(i) ?? []));
    if (opts.c && i < opts.c.withA) out.push(seen("c", t + 3 * S));
  }
  for (let i = 0; i < opts.aOnly; i += 1, t += step) out.push(seen("a", t));
  for (let i = 0; i < opts.bOnly; i += 1, t += step) out.push(seen("b", t, 4, opts.bZones?.(opts.shared + i) ?? []));
  for (let i = 0; i < (opts.c?.own ?? 0); i += 1, t += 17 * MIN) out.push(seen("c", t));
  return out;
}

const anchorA = (zoneName = "Stock room", zoneId = "z-stock"): LinkAnchor => ({
  linkId: "link-a",
  zoneId,
  zoneName,
  sourceKind: "camera",
  sourceRef: "a",
  label: "Stock cam A",
});

function run(sightings: PersonSighting[], anchors: LinkAnchor[] = [anchorA()], opts: { skip?: (z: string, cam: string) => boolean; zoneName?: string } = {}) {
  const series = buildCameraSeries(sightings, W);
  return scoreCameraPairs({
    anchors,
    series,
    blind: blindSpells([], series.keys(), W),
    observedEnd: W.observedEnd,
    skipCamera: opts.skip ?? (() => false),
    pinnedRef: () => null,
    candidateLabel: (cam) => `Cam ${cam.toUpperCase()}`,
  });
}

describe("scoreCameraPairs", () => {
  it("mutual overlap → auto; the anchor's own camera is never a candidate", () => {
    const { results, hypotheses } = run(world({ shared: 34, aOnly: 6, bOnly: 11 }));
    expect(results.map((r) => r.sourceRef)).toEqual(["b"]);
    const b = results[0]!;
    expect(b).toMatchObject({ camera: "b", part: null, sourceKind: "camera", gate: "auto", wholeK: null });
    expect(b.forward).toMatchObject({ n: 40, k: 34 });
    expect(b.reverse).toMatchObject({ n: 45, k: 34 });
    expect(b.confidence).toBeCloseTo(Math.min(b.forward.confidence, b.reverse.confidence), 12);
    expect(hypotheses).toBe(2);
  });

  it("Bonferroni: each direction's pAdj is min(1, m · pChance), m counting every (anchor, candidate, direction) scored", () => {
    const { results, hypotheses } = run(
      world({ shared: 34, aOnly: 6, bOnly: 11, c: { withA: 3, own: 5 }, bZones: (i) => (i % 2 === 0 ? ["door"] : ["till"]) }),
    );
    // b: whole + 2 parts; c: whole — each scored both ways.
    expect(hypotheses).toBe(2 * 4);
    for (const r of results) {
      expect(r.forwardPAdj).toBe(Math.min(1, hypotheses * r.forward.pChance));
      expect(r.reversePAdj).toBe(Math.min(1, hypotheses * r.reverse.pChance));
    }
  });

  it("Bonferroni can decide the gate: a direction significant alone is not once m is counted", () => {
    const fwd = scoreDirection(direction(30, 20, 1));
    const p = 5e-5; // under the propose bar (1e-4) with m = 1, over it with m = 12
    expect(gateFor("cameraCamera", fwd, Math.min(1, 1 * p))).toBe("propose");
    expect(gateFor("cameraCamera", fwd, Math.min(1, 12 * p))).toBeNull();
  });

  it("the street camera: sees most of A's visits, but A sees few of its own → nothing is proposed", () => {
    const { results } = run(world({ shared: 34, aOnly: 6, bOnly: 11, c: { withA: 30, own: 400 } }));
    const c = results.find((r) => r.camera === "c")!;
    expect(c.forward.k).toBe(30);
    expect(gateFor("cameraCamera", c.forward, c.forwardPAdj)).not.toBeNull();
    expect(gateFor("cameraCamera", c.reverse, c.reversePAdj)).toBeNull();
    expect(c.gate).toBeNull();
  });

  it("the burst: a person lingering (a sighting every 3 s for a minute) counts as ONE anchor visit, not twenty", () => {
    const sightings = world({ shared: 30, aOnly: 0, bOnly: 0 });
    const t = W.from + 13 * DAY;
    for (let i = 0; i < 20; i += 1) sightings.push(seen("a", t + i * 3 * S));
    const { results } = run(sightings);
    expect(results[0]!.forward.n).toBe(31);
  });

  it("part or whole: the part when it keeps ≥ 90 % of the whole camera's hits, else the whole", () => {
    // 34 shared: B's 'door' part sees 31 of them (≥ 0.9 × 34 = 30.6) → the part.
    const doorMostly = run(world({ shared: 34, aOnly: 6, bOnly: 11, bZones: (i) => (i < 31 ? ["door"] : []) })).results[0]!;
    expect(doorMostly).toMatchObject({ part: "door", sourceKind: "camera_zone", sourceRef: "b/door", wholeK: 34 });
    expect(doorMostly.forward.k).toBe(31);
    // The part passes the same gate as the whole camera (its own 31 visits clear the auto bar's n = 30).
    expect(doorMostly.gate).toBe("auto");
    // 'door' sees 30 of 34 (< 30.6) → the whole camera.
    const doorLess = run(world({ shared: 34, aOnly: 6, bOnly: 11, bZones: (i) => (i < 30 ? ["door"] : []) })).results[0]!;
    expect(doorLess).toMatchObject({ part: null, sourceKind: "camera", sourceRef: "b", wholeK: null });
  });

  // Review #2418 (finding 1): the reverse direction counts the PART's own visits, always fewer than the whole
  // camera's — so a part that keeps ≥ 90 % of the hits can still fail a gate the whole camera passed.
  it("a part is never chosen over a whole camera whose gate ranks higher: auto stays auto", () => {
    // Whole B: 32 of A's 35 visits forward, 32 of its own 32 back → auto. 'door' keeps 29 (≥ 28.8), but back it
    // has only its own 29 visits: under the auto bar's n = 30 → it would be a suggestion only.
    const sightings = world({ shared: 32, aOnly: 3, bOnly: 0, bZones: (i) => (i < 29 ? ["door"] : []) });
    const r = run(sightings).results[0]!;
    expect(r).toMatchObject({ camera: "b", part: null, sourceKind: "camera", sourceRef: "b", wholeK: null, gate: "auto" });
    expect(r.forward).toMatchObject({ n: 35, k: 32 });
    expect(r.reverse).toMatchObject({ n: 32, k: 32 });
  });

  it("a part is never chosen over a whole camera whose gate ranks higher: propose stays propose, never nothing", () => {
    // Whole B: 20 of 25 forward, 20 of 30 back → propose. 'door' keeps 18 (≥ 18), back only its own 18 (< 20).
    const sightings = world({ shared: 20, aOnly: 5, bOnly: 10, bZones: (i) => (i < 18 ? ["door"] : []) });
    const r = run(sightings).results[0]!;
    expect(r).toMatchObject({ part: null, sourceRef: "b", gate: "propose" });
  });

  it("between parts: most hits first, then the better gate, then lift — a name only breaks a full tie", () => {
    // 'door' and 'till' both see every shared visit (B's sighting is in both parts).
    const both = world({ shared: 34, aOnly: 6, bOnly: 11, bZones: () => ["door", "till"] });
    expect(run(both, [anchorA("Till")]).results[0]!.sourceRef).toBe("b/till");
    expect(run(both, [anchorA("Back door")]).results[0]!.sourceRef).toBe("b/door");
    // With no name to go on, the name order decides.
    expect(run(both, [anchorA("Stock room")]).results[0]!.sourceRef).toBe("b/door");
  });

  it("flipping every name match changes no gate", () => {
    const sightings = world({ shared: 34, aOnly: 6, bOnly: 11, c: { withA: 30, own: 400 }, bZones: (i) => (i % 3 === 0 ? ["door"] : ["till"]) });
    const gates = (name: string) => run(sightings, [anchorA(name)]).results.map((r) => [r.camera, r.gate]);
    expect(gates("Back door till cam c")).toEqual(gates("Nothing alike"));
  });

  it("a skipped camera (a row in the area already, or disabled) is not scored and not counted in m", () => {
    const { results, hypotheses } = run(world({ shared: 34, aOnly: 6, bOnly: 11, c: { withA: 3, own: 5 } }), [anchorA()], {
      skip: (_z, cam) => cam === "b",
    });
    expect(results.map((r) => r.camera)).toEqual(["c"]);
    expect(hypotheses).toBe(2);
  });

  it("several anchors in one area: the best gate wins, and it names that anchor", () => {
    const sightings = world({ shared: 34, aOnly: 6, bOnly: 11 });
    // A second anchor on camera d, which never sees anyone with b.
    for (let i = 0; i < 25; i += 1) sightings.push(seen("d", W.from + 12 * DAY + i * 17 * MIN));
    const anchors = [anchorA(), { ...anchorA(), linkId: "link-d", sourceRef: "d", label: "Cam D" }];
    const b = run(sightings, anchors).results.filter((r) => r.camera === "b");
    expect(b).toHaveLength(1);
    expect(b[0]!.anchor.linkId).toBe("link-a");
    expect(b[0]!.gate).toBe("auto");
  });

  it("a part anchor (camera_zone A/F) counts only A's sightings in F", () => {
    const sightings = world({ shared: 34, aOnly: 6, bOnly: 11 });
    // Put half of A's sightings in 'aisle'.
    const aisle = sightings.map((s, i) => (s.camera === "a" && i % 2 === 0 ? { ...s, zones: ["aisle"] } : s));
    const partAnchor: LinkAnchor = { ...anchorA(), sourceKind: "camera_zone", sourceRef: "a/aisle" };
    const b = run(aisle, [partAnchor]).results[0]!;
    expect(b.forward.n).toBe(aisle.filter((s) => s.camera === "a" && s.zones.includes("aisle")).length);
  });
});

describe("cameraPairEvidence — what the link stores (LinkEvidenceV1, integers and a string pAdj)", () => {
  it("round-trips through parseLinkEvidence, with the rounded direction numbers and up to 5 newest samples", () => {
    const { results, hypotheses } = run(world({ shared: 34, aOnly: 6, bOnly: 11 }));
    const r = results[0]!;
    const e = cameraPairEvidence(r, { window: W, hypotheses });
    expect(parseLinkEvidence(JSON.parse(JSON.stringify(e)))).toEqual(e);
    expect(e).toMatchObject({
      v: 1,
      kind: "camera_camera",
      window: { from: new Date(W.from).toISOString(), to: new Date(W.observedEnd).toISOString() },
      anchor: { linkId: "link-a", sourceKind: "camera", sourceRef: "a", label: "Stock cam A" },
      candidate: { sourceKind: "camera", sourceRef: "b", label: "Cam B" },
      chosen: "whole",
      wholeK: null,
      hypotheses,
      gate: "auto",
      samplesTrimmedBefore: null,
    });
    expect(e.forward).toEqual({
      n: r.forward.n,
      k: r.forward.k,
      excluded: r.forward.excluded,
      lambdaMilli: Math.round(r.forward.lambda * 1000),
      liftTenths: Math.round(r.forward.lift * 10),
      confidenceBp: Math.round(r.forward.confidence * 10_000),
    });
    expect(e.samples).toHaveLength(5);
    expect(Date.parse(e.samples[0]!.anchorAt)).toBeGreaterThan(Date.parse(e.samples[4]!.anchorAt));
  });

  it("pAdj is the weaker direction's, as a 2-significant-digit string", () => {
    const { results, hypotheses } = run(world({ shared: 34, aOnly: 6, bOnly: 11 }));
    const r = results[0]!;
    const e = cameraPairEvidence(r, { window: W, hypotheses });
    expect(e.pAdj).toBe(Math.max(r.forwardPAdj, r.reversePAdj).toPrecision(2));
    expect(e.pAdj).toMatch(/e-/);
  });

  it("a part candidate records the whole camera's hits", () => {
    const { results, hypotheses } = run(world({ shared: 34, aOnly: 6, bOnly: 11, bZones: (i) => (i < 33 ? ["door"] : []) }));
    const e = cameraPairEvidence(results[0]!, { window: W, hypotheses });
    expect(e).toMatchObject({ chosen: "part", wholeK: 34, candidate: { sourceKind: "camera_zone", sourceRef: "b/door" } });
  });
});

describe("linkWindow", () => {
  it("W = [now − 14 d, now − 15 min]", () => {
    expect(linkWindow(NOW)).toEqual({ from: NOW - 14 * DAY, observedEnd: NOW - 15 * MIN });
  });
});

// Type-only use, so an unused-import lint never drops the series type from the public surface.
export type _Series = CameraSeries;
