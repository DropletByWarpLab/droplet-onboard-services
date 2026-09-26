/**
 * WARP-2979 (ADR-059 P4 §6.1, §6.2, §9) — the co-occurrence arithmetic behind
 * Droplet's link proposals. Pure: every case builds its own timeline in epoch
 * ms, and §6.1's camera ↔ camera worked example is reproduced number by
 * number, and so is the lock ↔ camera one (P4 PR-4).
 *
 * The fixtures that guard the design, each named for the mutation it kills
 * (§10):
 *   · the ±10 s edges (the pad widened);
 *   · the busy-at-the-same-hours camera (local chance replaced by the
 *     whole-window rate);
 *   · the blind spell (exclusion removed); the burst (debounce removed);
 *   · Bonferroni's m; Wilson against the raw k/n;
 *   · the street camera (the reverse direction ignored);
 *   · the part share;
 *   · (PR-4) a polled row, a baseline row, a reading that is not a turn —
 *     none is ever an anchor.
 */
import { describe, it, expect } from "vitest";
import {
  LINK_RULES,
  blindSpells,
  buildCameraSeries,
  buildLockSeries,
  cameraPairEvidence,
  lockPairEvidence,
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
  scoreLinkPairs,
  scoreLockPairs,
  wilsonLowerBound,
  type CameraSeries,
  type DirectionInput,
  type Interval,
  type LinkAnchor,
  type LockStateRow,
  type PersonSighting,
} from "./security-cooccurrence.js";
import { LOCK_BASELINE_KEY_MARK, LOCK_CHANGE_READINGS, isLockChange } from "./security-lock-changes.js";
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

// ── P4 PR-4: lock ↔ camera (§6.1 worked example, §6.2.1–§6.2.3) ──────────────

const LOCK = "matter:4660/1";
const LOCK_B = "matter:99/2";
const lockKey = (ref: string, prev: string | null, reading: string) => `matter_lock:${ref.slice(7)}:after:${prev ?? "none"}:${reading}`;
/** A `lock_state` row as the job loads it; a live change after an earlier row unless said otherwise. */
const change = (at: number, over: Partial<LockStateRow> = {}): LockStateRow => ({
  sourceRef: LOCK,
  reading: "unlocked",
  observed: "live",
  dedupeKey: lockKey(over.sourceRef ?? LOCK, `p${at}`, over.reading ?? "unlocked"),
  startedAt: at,
  ...over,
});

describe("isLockChange — which lock rows are a lock turning (§6.2.1)", () => {
  it("a LIVE change to locked, unlocked or unlatched after an earlier row", () => {
    expect(LOCK_CHANGE_READINGS).toEqual(["locked", "unlocked", "unlatched"]);
    for (const reading of LOCK_CHANGE_READINGS) expect(isLockChange(change(0, { reading }))).toBe(true);
  });

  it("🔴 never a polled row: its time is when the 60 s check found it, not when the lock turned", () => {
    expect(isLockChange(change(0, { observed: "polled" }))).toBe(false);
  });

  it("never the baseline (the first row a lock wrote: when Droplet first saw it, not a turn)", () => {
    expect(LOCK_BASELINE_KEY_MARK).toBe(":after:none:");
    expect(isLockChange(change(0, { dedupeKey: lockKey(LOCK, null, "locked"), reading: "locked" }))).toBe(false);
  });

  it("never not_fully_locked or unknown (a jammed bolt, a lock that stopped answering), or a row with no reading", () => {
    expect(isLockChange(change(0, { reading: "not_fully_locked" }))).toBe(false);
    expect(isLockChange(change(0, { reading: "unknown" }))).toBe(false);
    expect(isLockChange({ reading: undefined, observed: "live", dedupeKey: lockKey(LOCK, "p1", "locked") })).toBe(false);
  });
});

describe("buildLockSeries — every lock with at least one live change in W (§6.2.2)", () => {
  it("per lock: its changes inside W, sorted; polled, baseline and non-turn rows dropped; a lock with none is absent", () => {
    const t = W.from + DAY;
    const series = buildLockSeries(
      [
        change(t + 2 * H),
        change(t, { reading: "locked" }),
        change(W.from - MIN), // before W
        change(W.observedEnd + MIN), // after E
        change(t + 3 * H, { observed: "polled" }),
        change(t + 4 * H, { dedupeKey: lockKey(LOCK, null, "unlocked") }),
        change(t + 5 * H, { reading: "not_fully_locked" }),
        change(t, { sourceRef: LOCK_B, observed: "polled" }),
      ],
      W,
    );
    expect([...series.entries()]).toEqual([[LOCK, [t, t + 2 * H]]]);
  });
});

/**
 * §6.1's lock ↔ camera worked example, built as a timeline. Area *Back door*
 * (Way in), *Back door lock* linked by a person. One kept lock change a day
 * for 14 days (noon, W-relative); three of them followed 30 s later by the
 * lock turning back (merged by the debounce): 17 live changes, n = 14. Plus a
 * baseline row, a polled row and a not-fully-locked row, which are never
 * anchors.
 *
 * Around each kept change, in the hour either side:
 *   · Back camera: a person in its 'back_door' part for 23.2 s (padded ±10 s:
 *     43.2 s of the hour) — ON the change for 12 of the 14, five minutes after
 *     it for the other two — and a person elsewhere in its view for 26.8 s
 *     (46.8 s padded), ten minutes after. Whole view: 90 s of the hour
 *     (q = 0.025, λ = 0.35); the part: 43.2 s (q = 0.012, λ = 0.168);
 *   · Shop floor camera: busy — 1,620 s of every such hour (q = 0.45,
 *     λ = 6.3), on the change 9 times; its 'till' and 'aisle' parts take
 *     alternate days, so neither keeps 90 % of the hits (the whole view);
 *   · Yard camera: people three hours later only, in 'gate' and 'drive'.
 * Three cameras + five parts = m = 8.
 */
function lockWorld(opts: { changes?: number } = {}) {
  const days = opts.changes ?? 14;
  const merged = [2, 5, 9];
  const hits = (d: number) => d !== 4 && d !== 11;
  const rows: LockStateRow[] = [];
  const sightings: PersonSighting[] = [];
  const kept: number[] = [];
  for (let d = 1; d <= 14; d += 1) {
    const t = W.from + d * DAY - 12 * H;
    kept.push(t);
    if (d <= days) {
      rows.push(change(t, { reading: d % 2 === 0 ? "locked" : "unlocked" }));
      if (merged.includes(d)) rows.push(change(t + 30 * S, { reading: d % 2 === 0 ? "unlocked" : "locked" }));
    }
    const on = hits(d) ? t + 2 * S : t + 5 * MIN;
    sightings.push({ camera: "back_cam", zones: ["back_door"], startedAt: on, endedAt: on + 23_200 });
    sightings.push({ camera: "back_cam", zones: [], startedAt: t + 10 * MIN, endedAt: t + 10 * MIN + 26_800 });
    sightings.push(
      d <= 9
        ? { camera: "floor_cam", zones: [d % 2 === 0 ? "aisle" : "till"], startedAt: t - 800 * S, endedAt: t + 800 * S }
        : { camera: "floor_cam", zones: [d % 2 === 0 ? "aisle" : "till"], startedAt: t + 60 * S, endedAt: t + 1_660 * S },
    );
    sightings.push({ camera: "yard_cam", zones: [d % 2 === 0 ? "gate" : "drive"], startedAt: t + 3 * H, endedAt: t + 3 * H + 5 * S });
  }
  if (days > 0) {
    // Never anchors: the baseline (first row the lock wrote), a change found by the 60 s check, a jammed bolt.
    rows.push(change(W.from + 6 * H, { reading: "locked", dedupeKey: lockKey(LOCK, null, "locked") }));
    rows.push(change(kept[6]! + 7 * S, { observed: "polled" })); // on a person, 7 s after a kept change — it would move k if it counted
    rows.push(change(kept[7]! + 6 * H, { reading: "not_fully_locked" }));
  }
  return { rows, sightings, kept };
}

const lockAnchor = (over: Partial<LinkAnchor> = {}): LinkAnchor => ({
  linkId: "link-lock",
  zoneId: "z-back",
  zoneName: "Back door",
  sourceKind: "lock",
  sourceRef: LOCK,
  label: "Back door lock",
  ...over,
});

const CAMERA_LABELS: Record<string, string> = { back_cam: "Back camera", floor_cam: "Shop floor", yard_cam: "Yard camera" };

function lockInput(world: { rows: LockStateRow[]; sightings: PersonSighting[] }, anchors: LinkAnchor[]) {
  const series = buildCameraSeries(world.sightings, W);
  return {
    anchors,
    series,
    locks: buildLockSeries(world.rows, W),
    blind: blindSpells([], series.keys(), W),
    observedEnd: W.observedEnd,
    skipCamera: (_z: string, _cam: string) => false,
    pinnedRef: () => null,
    skipLock: (_z: string, _ref: string) => false,
    candidateLabel: (cam: string) => CAMERA_LABELS[cam] ?? cam,
    lockLabel: (ref: string) => (ref === LOCK ? "Back door lock" : "Side gate lock"),
  };
}

function runLocks(
  world: { rows: LockStateRow[]; sightings: PersonSighting[] },
  anchors: LinkAnchor[] = [lockAnchor()],
  opts: { skipCamera?: (z: string, cam: string) => boolean; skipLock?: (z: string, ref: string) => boolean } = {},
) {
  return scoreLockPairs({
    ...lockInput(world, anchors),
    ...(opts.skipCamera ? { skipCamera: opts.skipCamera } : {}),
    ...(opts.skipLock ? { skipLock: opts.skipLock } : {}),
  });
}

describe("§6.1's lock ↔ camera worked example, every number (P4 PR-4)", () => {
  const world = lockWorld();
  const { results, hypotheses } = runLocks(world);
  const back = results.find((r) => r.camera === "back_cam")!;
  const floor = results.find((r) => r.camera === "floor_cam")!;

  it("17 live changes; the debounce merges 3 lock-then-unlock pairs under 60 s → n = 14; baseline, polled and jammed rows never count", () => {
    expect(world.rows.filter((r) => isLockChange(r))).toHaveLength(17);
    expect(back.forward).toMatchObject({ n: 14, k: 12, excluded: 0 });
  });

  it("m = 8: one lock × 3 cameras + 5 parts", () => {
    expect(hypotheses).toBe(8);
  });

  it("Back camera's 'back_door' part: k = 12, λ = 0.168, lift 71.4, pAdj 7.2e−18, confidence 0.601 → the part (12 ≥ 0.9 × 12), auto", () => {
    expect(back).toMatchObject({
      kind: "lock_camera",
      camera: "back_cam",
      part: "back_door",
      sourceKind: "camera_zone",
      sourceRef: "back_cam/back_door",
      label: "Back camera",
      wholeK: 12,
      gate: "auto",
    });
    expect(back.forward.lambda).toBeCloseTo(0.168, 9);
    expect(back.forward.lift).toBeCloseTo(71.4, 1);
    expect(back.forwardPAdj.toPrecision(2)).toBe("7.2e-18");
    expect(back.forwardPAdj).toBe(Math.min(1, 8 * back.forward.pChance));
    expect(back.confidence).toBeCloseTo(0.601, 3);
    expect(back.confidence).toBe(back.forward.confidence);
    expect(back.names).toEqual({ match: true, shared: ["back", "door"] });
  });

  it("Back camera's whole view (the part's rival): k = 12, λ = 0.35, lift 34.3, pChance 5.1e−15, pAdj 4.1e−14, confidence 0.601, auto", () => {
    const series = buildCameraSeries(world.sightings, W);
    const whole = scoreDirection({
      anchors: debounceAnchors(buildLockSeries(world.rows, W).get(LOCK)!, LINK_RULES.debounceMs, LINK_RULES.maxAnchors),
      coverage: series.get("back_cam")!.whole.coverage,
      blind: [],
      observedEnd: W.observedEnd,
    });
    expect(whole).toMatchObject({ n: 14, k: 12 });
    expect(whole.lambda).toBeCloseTo(0.35, 9);
    expect(whole.lift).toBeCloseTo(34.3, 1);
    expect(whole.pChance.toPrecision(2)).toBe("5.1e-15");
    expect(Math.min(1, 8 * whole.pChance).toPrecision(2)).toBe("4.1e-14");
    expect(whole.confidence).toBeCloseTo(0.601, 3);
    expect(gateFor("lockCamera", whole, Math.min(1, 8 * whole.pChance))).toBe("auto");
  });

  it("Shop floor camera (busy all day): k = 9 but λ = 6.3, lift 1.4 → nothing. The case local chance exists for", () => {
    expect(floor).toMatchObject({ part: null, sourceRef: "floor_cam" });
    expect(floor.forward).toMatchObject({ n: 14, k: 9 });
    expect(floor.forward.lambda).toBeCloseTo(6.3, 9);
    expect(floor.forward.lift).toBeCloseTo(1.4, 1);
    expect(floor.gate).toBeNull();
  });

  it("a lock seen 6 times, 5 with a person: lift 41.7, pAdj 1.5e−6, confidence 0.436 → propose, never auto", () => {
    // Back camera covers 72 s of each hour (a 52 s visit, padded), all of it in 'back_door'.
    const rows: LockStateRow[] = [];
    const sightings: PersonSighting[] = [];
    for (let d = 1; d <= 6; d += 1) {
      const t = W.from + d * DAY - 12 * H;
      rows.push(change(t, { reading: d % 2 === 0 ? "locked" : "unlocked" }));
      const on = d === 6 ? t + 5 * MIN : t + 2 * S;
      sightings.push({ camera: "back_cam", zones: ["back_door"], startedAt: on, endedAt: on + 52 * S });
      sightings.push({ camera: "floor_cam", zones: [d % 2 === 0 ? "till" : "aisle"], startedAt: t + 2 * H, endedAt: t + 2 * H + 5 * S });
      sightings.push({ camera: "yard_cam", zones: [d % 2 === 0 ? "gate" : "drive"], startedAt: t + 3 * H, endedAt: t + 3 * H + 5 * S });
    }
    const { results: r, hypotheses: m } = runLocks({ rows, sightings });
    expect(m).toBe(8);
    const b = r.find((x) => x.camera === "back_cam")!;
    expect(b.forward).toMatchObject({ n: 6, k: 5 });
    expect(b.forward.lift).toBeCloseTo(41.7, 1);
    // 1.5e−6 (JavaScript writes it "0.0000015": exponent notation starts below 1e−6).
    expect(Number(b.forwardPAdj.toPrecision(2))).toBe(1.5e-6);
    expect(b.confidence).toBeCloseTo(0.436, 3);
    expect(b.gate).toBe("propose");
  });
});

describe("scoreLockPairs — the pairs (§6.2.3)", () => {
  const world = lockWorld();

  it("🔴 a polled row is never an anchor: the same changes, found by the 60 s check on a person, give no candidate", () => {
    const polledOnly = { rows: world.kept.map((t) => change(t, { observed: "polled" })), sightings: world.sightings };
    expect(runLocks(polledOnly)).toEqual({ results: [], hypotheses: 0 });
  });

  it("the baseline row is never an anchor, even on a person", () => {
    const only = { rows: world.kept.map((t) => change(t, { dedupeKey: lockKey(LOCK, null, "unlocked") })), sightings: world.sightings };
    expect(runLocks(only)).toEqual({ results: [], hypotheses: 0 });
  });

  it("camera or part C → lock L: anchors are L's changes, coverage C's people — the same statistic, the candidate is the lock", () => {
    const camAnchor: LinkAnchor = { linkId: "link-back", zoneId: "z-back", zoneName: "Back door", sourceKind: "camera_zone", sourceRef: "back_cam/back_door", label: "Back camera" };
    const { results, hypotheses } = runLocks(world, [camAnchor]);
    expect(hypotheses).toBe(1);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r).toMatchObject({ kind: "lock_camera", camera: null, part: null, sourceKind: "lock", sourceRef: LOCK, label: "Back door lock", wholeK: null, gate: "auto" });
    expect(r.forward).toMatchObject({ n: 14, k: 12 });
    expect(r.forward.lambda).toBeCloseTo(0.168, 9);
    expect(r.names).toEqual({ match: true, shared: ["back", "door"] });
  });

  it("both ways in one run count each (lock, camera view) statistic ONCE in m", () => {
    const camAnchor: LinkAnchor = { linkId: "link-back", zoneId: "z-yard", zoneName: "Yard", sourceKind: "camera", sourceRef: "back_cam", label: "Back camera" };
    expect(runLocks(world, [lockAnchor(), camAnchor]).hypotheses).toBe(8);
  });

  it("a lock anchor never pairs with a lock; a camera anchor pairs with every lock (camera ↔ camera is PR-1's arm)", () => {
    const withB = { rows: [...world.rows, ...world.kept.map((t) => change(t + 3 * H, { sourceRef: LOCK_B }))], sightings: world.sightings };
    expect(runLocks(withB).results.every((r) => r.sourceKind !== "lock")).toBe(true);
    const camAnchor: LinkAnchor = { linkId: "l-a", zoneId: "z-back", zoneName: "Back door", sourceKind: "camera", sourceRef: "floor_cam", label: "Shop floor" };
    expect(runLocks(withB, [camAnchor]).results.map((r) => r.sourceRef).sort()).toEqual([LOCK, LOCK_B].sort());
  });

  it("candidates: only locks with a live change in W; a lock or camera the area already holds a row on is skipped (not scored, not in m)", () => {
    const camAnchor: LinkAnchor = { linkId: "l-a", zoneId: "z-back", zoneName: "Back door", sourceKind: "camera", sourceRef: "back_cam", label: "Back camera" };
    const polledB = { rows: [...world.rows, change(world.kept[0]!, { sourceRef: LOCK_B, observed: "polled" })], sightings: world.sightings };
    expect(runLocks(polledB, [camAnchor]).results.map((r) => r.sourceRef)).toEqual([LOCK]);
    expect(runLocks(world, [camAnchor], { skipLock: (_z, ref) => ref === LOCK })).toEqual({ results: [], hypotheses: 0 });
    const skipped = runLocks(world, [lockAnchor()], { skipCamera: (_z, cam) => cam === "back_cam" });
    expect(skipped.results.map((r) => r.camera).sort()).toEqual(["floor_cam", "yard_cam"]);
    expect(skipped.hypotheses).toBe(6);
  });

  it("a lock anchor with no live change in W is not scored at all", () => {
    expect(runLocks(world, [lockAnchor({ sourceRef: LOCK_B })])).toEqual({ results: [], hypotheses: 0 });
  });

  it("an anchor inside the camera's blind spell is excluded, never a miss", () => {
    const input = lockInput(world, [lockAnchor()]);
    const blind = blindSpells(
      [
        { camera: "back_cam", kind: "offline", at: world.kept[3]! - MIN },
        { camera: "back_cam", kind: "online", at: world.kept[3]! + MIN },
      ],
      input.series.keys(),
      W,
    );
    const r = scoreLockPairs({ ...input, blind }).results.find((x) => x.camera === "back_cam")!;
    // Day 4 was a miss: excluded now.
    expect(r.forward).toMatchObject({ n: 13, k: 12, excluded: 1 });
  });
});

describe("scoreLinkPairs — both arms in one run: one m, the best gate per area and candidate", () => {
  it("m is the camera arm's plus the lock arm's; every pAdj uses it", () => {
    const world = lockWorld();
    const camAnchor: LinkAnchor = { linkId: "link-floor", zoneId: "z-shop", zoneName: "Shop", sourceKind: "camera", sourceRef: "floor_cam", label: "Shop floor" };
    const out = scoreLinkPairs(lockInput(world, [lockAnchor(), camAnchor]));
    // Camera arm: floor → back (whole + back_door), yard (whole + gate + drive), each both ways = 2 × 5.
    // Lock arm: the lock anchor × 8 views, and floor → the lock (the (lock, floor whole) statistic, already counted).
    expect(out.hypotheses).toBe(2 * 5 + 8);
    for (const r of out.results) {
      expect(r.forwardPAdj).toBe(Math.min(1, out.hypotheses * r.forward.pChance));
    }
    const back = out.results.find((r) => r.anchor.zoneId === "z-back" && r.camera === "back_cam")!;
    expect(back.kind).toBe("lock_camera");
    expect(out.results.some((r) => r.anchor.zoneId === "z-shop" && r.sourceKind === "lock")).toBe(true);
  });

  it("a camera another anchor in the same area also pairs with: the better gate wins, and names its anchor", () => {
    const world = lockWorld();
    // A person-set camera anchor in the Back door area that never sees anyone with Back camera.
    for (let i = 0; i < 25; i += 1) {
      const t = W.from + 12 * DAY + i * 17 * MIN;
      world.sightings.push({ camera: "door_cam", zones: [], startedAt: t, endedAt: t + 4 * S });
    }
    const doorAnchor: LinkAnchor = { linkId: "link-door", zoneId: "z-back", zoneName: "Back door", sourceKind: "camera", sourceRef: "door_cam", label: "Door cam" };
    const out = scoreLinkPairs(lockInput(world, [lockAnchor(), doorAnchor]));
    const back = out.results.filter((r) => r.anchor.zoneId === "z-back" && r.camera === "back_cam");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ kind: "lock_camera", gate: "auto", anchor: { linkId: "link-lock" } });
  });
});

describe("lockPairEvidence — what a lock ↔ camera link stores", () => {
  it("round-trips parseLinkEvidence: kind lock_camera, no reverse, the part and the whole camera's hits, a string pAdj, 5 newest samples", () => {
    const { results, hypotheses } = runLocks(lockWorld());
    const r = results.find((x) => x.camera === "back_cam")!;
    const e = lockPairEvidence(r, { window: W, hypotheses });
    expect(parseLinkEvidence(JSON.parse(JSON.stringify(e)))).toEqual(e);
    expect(e).toMatchObject({
      v: 1,
      kind: "lock_camera",
      anchor: { linkId: "link-lock", sourceKind: "lock", sourceRef: LOCK, label: "Back door lock" },
      candidate: { sourceKind: "camera_zone", sourceRef: "back_cam/back_door", label: "Back camera" },
      reverse: null,
      chosen: "part",
      wholeK: 12,
      hypotheses: 8,
      pAdj: "7.2e-18",
      gate: "auto",
      samplesTrimmedBefore: null,
    });
    expect(e.forward).toEqual({ n: 14, k: 12, excluded: 0, lambdaMilli: 168, liftTenths: 714, confidenceBp: Math.round(r.confidence * 10_000) });
    expect(e.samples).toHaveLength(5);
    expect(Date.parse(e.samples[0]!.anchorAt)).toBeGreaterThan(Date.parse(e.samples[4]!.anchorAt));
  });

  it("a lock candidate: chosen 'lock', no wholeK", () => {
    const camAnchor: LinkAnchor = { linkId: "link-back", zoneId: "z-back", zoneName: "Back door", sourceKind: "camera", sourceRef: "back_cam", label: "Back camera" };
    const { results, hypotheses } = runLocks(lockWorld(), [camAnchor]);
    const e = lockPairEvidence(results[0]!, { window: W, hypotheses });
    expect(e).toMatchObject({ chosen: "lock", wholeK: null, candidate: { sourceKind: "lock", sourceRef: LOCK, label: "Back door lock" } });
    expect(parseLinkEvidence(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("an ungated candidate has no evidence to store", () => {
    const { results, hypotheses } = runLocks(lockWorld());
    expect(() => lockPairEvidence(results.find((x) => x.camera === "floor_cam")!, { window: W, hypotheses })).toThrow(/ungated/);
  });
});

describe("linkWindow", () => {
  it("W = [now − 14 d, now − 15 min]", () => {
    expect(linkWindow(NOW)).toEqual({ from: NOW - 14 * DAY, observedEnd: NOW - 15 * MIN });
  });
});

// Type-only use, so an unused-import lint never drops the series type from the public surface.
export type _Series = CameraSeries;
