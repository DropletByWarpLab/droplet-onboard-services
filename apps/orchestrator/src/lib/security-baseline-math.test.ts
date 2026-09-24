/**
 * WARP-2980 (ADR-059 P5 §6.4) — the arithmetic, pinned to the spec's worked
 * examples exactly. Every mutation target of §13's math list must turn one of
 * these red: smoothing on the numerator only, weight 0.25 → 0.5, neighbours
 * not circular, the +0.5 / +1 dropped, `<` → `≤` at 0.05, readiness ≥ 10 →
 * ≥ 9 or removed, λ without its prior, no slot-length scaling, `k ≥ 3`
 * removed, `P < 0.001` → `≤`, the ≥ 30 samples check removed, max(p99, 120)
 * → p99, and the person-only check removed.
 */
import { describe, expect, it } from "vitest";
import {
  BASELINE,
  BASELINE_WINDOW_DAYS,
  cellsAround,
  dwellThresholdSec,
  hourlyRate,
  isRare,
  isReady,
  neighbourHours,
  rarityP,
  slotRate,
  smoothCounts,
  tailFlags,
  volumeThreshold,
  wouldFlagDwell,
  wouldFlagVolume,
  type CellCounts,
} from "./security-baseline-math.js";
import { SECURITY_EVENT_RETENTION_DAYS } from "../services/security-events.service.js";

/** A cell whose only interesting numbers are n and d. */
const cell = (n: number, d: number, c = d, m = n * 60): CellCounts => ({
  daysObserved: n,
  daysWithEvent: d,
  eventCount: c,
  observedMinutes: m,
});

/** Rarity of the middle hour of three raw cells. */
const pOf = (a: CellCounts, b: CellCounts, c: CellCounts): number => {
  const s = smoothCounts(a, b, c);
  return rarityP(s);
};

describe("BASELINE — the pinned constants", () => {
  it("is the spec's object", () => {
    expect(BASELINE).toEqual({
      windowDays: 28,
      learningDays: 14,
      fullDayMinutes: 1200,
      observedSlotShare: 5 / 6,
      staleAfterMs: 48 * 3_600_000,
      neighbourWeight: 0.25,
      readyMinSmoothedDays: 10,
      labels: ["person", "car", "dog", "cat"],
      maxLabelsPerKey: 8,
    });
  });

  it("the window plus one day stays inside event retention (28 + 1 < 30): a fresh build never needs a trimmed event", () => {
    expect(BASELINE_WINDOW_DAYS + 1).toBeLessThan(SECURITY_EVENT_RETENTION_DAYS);
  });
});

describe("smoothing — both counts, 0.25 each side, circular within a day type (D7)", () => {
  it("x′ = x(h) + 0.25·(x(h−1) + x(h+1)) for n, d, c and m alike", () => {
    expect(smoothCounts(cell(20, 1, 3, 1200), cell(20, 4, 9, 1100), cell(18, 2, 5, 1000))).toEqual({
      n: 20 + 0.25 * 38,
      d: 4 + 0.25 * 3,
      c: 9 + 0.25 * 8,
      m: 1100 + 0.25 * 2200,
    });
  });

  it("a missing neighbour counts as zero", () => {
    expect(smoothCounts(null, cell(10, 2), null)).toEqual({ n: 10, d: 2, c: 2, m: 600 });
  });

  it("neighbours wrap: hour 0 borrows 23 and 1, hour 23 borrows 22 and 0", () => {
    expect(neighbourHours(0)).toEqual([23, 0, 1]);
    expect(neighbourHours(23)).toEqual([22, 23, 0]);
    expect(neighbourHours(12)).toEqual([11, 12, 13]);
  });

  it("cellsAround reads the three stored hours of the SAME day type, wrapping", () => {
    const byHour = new Map<number, CellCounts>([
      [23, cell(20, 20)],
      [0, cell(20, 0)],
      [1, cell(20, 0)],
    ]);
    const [prev, cur, next] = cellsAround((h) => byHour.get(h) ?? null, 0);
    expect(prev).toEqual(cell(20, 20));
    expect(cur).toEqual(cell(20, 0));
    expect(next).toEqual(cell(20, 0));
    // The cleaner seen every weekday at 23:00 makes midnight unremarkable.
    expect(pOf(prev!, cur!, next!)).toBeCloseTo(5.5 / 31, 12);
  });
});

describe("rarity — p = (d′ + 0.5)/(n′ + 1); out_of_place ⟺ ready ∧ p < 0.05 (spec §6.4 table)", () => {
  // A full weekday cell: n = 20 every hour, so n′ = 30.
  const full = (d: [number, number, number]) => pOf(cell(20, d[0]), cell(20, d[1]), cell(20, d[2]));

  it.each([
    ["never seen at this hour or its neighbours", [0, 0, 0], 0.5 / 31, true],
    ["seen once, exactly this hour", [0, 1, 0], 1.5 / 31, true],
    ["seen once in a neighbouring hour", [1, 0, 0], 0.75 / 31, true],
    ["once this hour + once in a neighbour", [1, 1, 0], 1.75 / 31, false],
    ["the cleaner, every weekday at 01:00 (evaluating 02:00)", [20, 0, 0], 5.5 / 31, false],
    ["12 of 20 weekdays", [5, 12, 4], 14.75 / 31, false],
  ] as const)("%s → p = %f", (_label, d, want, rare) => {
    const p = full([...d]);
    expect(p).toBeCloseTo(want, 12);
    expect(isRare(p)).toBe(rare);
  });

  it("the table's rounded figures", () => {
    expect(full([0, 0, 0]).toFixed(4)).toBe("0.0161");
    expect(full([0, 1, 0]).toFixed(4)).toBe("0.0484");
    expect(full([1, 0, 0]).toFixed(4)).toBe("0.0242");
    expect(full([1, 1, 0]).toFixed(4)).toBe("0.0565");
    expect(full([20, 0, 0]).toFixed(3)).toBe("0.177");
    expect(full([5, 12, 4]).toFixed(3)).toBe("0.476");
  });

  it("a weekend cell (n = 8, n′ = 12) CAN fire: never seen → 0.0385; seen once → 0.115 does not", () => {
    const never = pOf(cell(8, 0), cell(8, 0), cell(8, 0));
    const once = pOf(cell(8, 0), cell(8, 1), cell(8, 0));
    expect(never).toBeCloseTo(0.5 / 13, 12);
    expect(never.toFixed(4)).toBe("0.0385");
    expect(isRare(never)).toBe(true);
    expect(once).toBeCloseTo(1.5 / 13, 12);
    expect(isRare(once)).toBe(false);
  });

  it("exactly 0.05 does not flag (strictly below)", () => {
    expect(isRare(0.05)).toBe(false);
    expect(isRare(0.0499999)).toBe(true);
  });
});

describe("readiness — n′ ≥ 10 (D8)", () => {
  it("6 observed days each hour (n′ = 9) is not ready, and p(0) = 0.05 exactly does not fire anyway", () => {
    const s = smoothCounts(cell(6, 0), cell(6, 0), cell(6, 0));
    expect(s.n).toBe(9);
    expect(isReady(s.n)).toBe(false);
    expect(rarityP(s)).toBeCloseTo(0.05, 12);
  });

  it("7 observed days each hour (n′ = 10.5) is ready, and p(0) = 0.043 fires", () => {
    const s = smoothCounts(cell(7, 0), cell(7, 0), cell(7, 0));
    expect(s.n).toBe(10.5);
    expect(isReady(s.n)).toBe(true);
    expect(isRare(rarityP(s))).toBe(true);
  });

  it("the boundary itself: 10 is ready, 9.99 is not", () => {
    expect(isReady(10)).toBe(true);
    expect(isReady(9.99)).toBe(false);
    expect(isReady(0)).toBe(false);
  });
});

describe("volume — λ = (c′ + 0.5)/(m′/60), scaled to the slot; fires from k* (D9)", () => {
  it("the 0.5 prior: a never-seen hour still has a rate (stock room, weekday 02:00)", () => {
    const s = smoothCounts(cell(20, 0, 0, 1200), cell(20, 0, 0, 1200), cell(20, 0, 0, 1200));
    expect(s.m).toBe(1800);
    expect(hourlyRate(s)).toBeCloseTo(0.5 / 30, 12);
  });

  it("the car park, weekend 03:00: c = (1, 3, 0) over 480-minute hours → λ = 0.3125", () => {
    const s = smoothCounts(cell(8, 1, 1, 480), cell(8, 3, 3, 480), cell(8, 0, 0, 480));
    expect(s.c).toBe(3.25);
    expect(hourlyRate(s)).toBeCloseTo(0.3125, 12);
  });

  it("no observed time → no rate (never Infinity)", () => {
    expect(hourlyRate({ c: 0, m: 0 })).toBeNull();
  });

  it("the rate is scaled to the event's own slot: a 120-minute fall-back hour doubles it", () => {
    expect(slotRate(0.3125, 60)).toBeCloseTo(0.3125, 12);
    expect(slotRate(0.3125, 120)).toBeCloseTo(0.625, 12);
    expect(slotRate(0.3125, 30)).toBeCloseTo(0.15625, 12);
  });

  it.each([
    [0.0167, 3],
    [0.1, 3],
    [0.3125, 4],
    [0.4, 4],
    [1, 6],
    [2, 9],
    [5, 14],
    [8.017, 19],
    [10, 22],
    [20, 36],
    [50, 74],
  ])("k*(λ = %f) = %i — the smallest k ≥ 3 with P(X ≥ k) < 0.001", (lambda, want) => {
    expect(volumeThreshold(lambda)).toBe(want);
  });

  it("k ≥ 3 binds even where two would already be rare (λ = 0.0167: P(X ≥ 2) = 1.4e−4)", () => {
    expect(volumeThreshold(0.0167)).toBe(3);
  });

  it("a busy street camera (λ = 800) has a finite threshold between 880 and 900", () => {
    const k = volumeThreshold(800);
    expect(k).toBeGreaterThan(880);
    expect(k).toBeLessThanOrEqual(900);
  });

  it("fires for k = k* and k* + 1, never k* − 1", () => {
    const lambda = 8.017;
    expect(wouldFlagVolume(19, lambda)).toBe(true);
    expect(wouldFlagVolume(20, lambda)).toBe(true);
    expect(wouldFlagVolume(18, lambda)).toBe(false);
  });

  it("the tail test is strictly below 0.001", () => {
    expect(tailFlags(0.001)).toBe(false);
    expect(tailFlags(0.000999)).toBe(true);
  });
});

describe("dwell — person only, ≥ 30 samples, > max(p99, 120 s) (D10)", () => {
  it("30 samples, p99 = 140 → threshold 140: six minutes fires, 130 s does not", () => {
    const c = { dwellSamples: 30, durationP99Sec: 140 };
    expect(dwellThresholdSec("person", c)).toBe(140);
    expect(wouldFlagDwell("person", 360, c)).toBe(true);
    expect(wouldFlagDwell("person", 130, c)).toBe(false);
    expect(wouldFlagDwell("person", 140, c)).toBe(false);
  });

  it("100 samples, p99 = 95 → threshold 120 (the floor): 130 s fires, 100 s does not", () => {
    const c = { dwellSamples: 100, durationP99Sec: 95 };
    expect(dwellThresholdSec("person", c)).toBe(120);
    expect(wouldFlagDwell("person", 130, c)).toBe(true);
    expect(wouldFlagDwell("person", 100, c)).toBe(false);
  });

  it("29 samples: no p99 worth quoting, never fires", () => {
    const c = { dwellSamples: 29, durationP99Sec: 60 };
    expect(dwellThresholdSec("person", c)).toBeNull();
    expect(wouldFlagDwell("person", 3600, c)).toBe(false);
  });

  it("a car never fires, however long it parks", () => {
    const c = { dwellSamples: 500, durationP99Sec: 60 };
    expect(dwellThresholdSec("car", c)).toBeNull();
    expect(wouldFlagDwell("car", 36_000, c)).toBe(false);
  });
});
