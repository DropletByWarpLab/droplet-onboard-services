/**
 * WARP-3514 / ADR-070 — the sizing maths behind the camera-recordings allocation.
 *
 * Every expected byte count below is an exact integer worked out independently of
 * the implementation (BigInt rational arithmetic — `base × MIB × 24 × days ×
 * headroom × 1.02`, rounded UP) and then checked against the float evaluation
 * order the spec fixes. Where a value is derived with `ceil(x × 1.1)` the inputs
 * are chosen so the float product is exact (25/50/85/90/95/100/110/180/200/220/
 * 400 GiB are NOT: `ceil(100 GiB × 1.1)` is one byte more than the decimal
 * answer — harmless in production, but a hard-coded expectation would be wrong).
 *
 * These are the only numbers the allocator will ever reserve a customer's drive
 * with, so the tests pin the arithmetic, the boundaries and the invariants
 * ("never shrink", "never below used × 1.1"), not just the happy path.
 */
import { describe, expect, it } from "vitest";
import {
  GIB,
  GROW_TARGET_FACTOR,
  GROW_TRIGGER_RATIO,
  HEADROOM,
  MIB,
  MIN_HISTORY_SAMPLES,
  NEED_FLOOR_BYTES,
  NEW_CAMERA_HEADROOM,
  SAMPLE_RETENTION_DAYS,
  SHRINK_FLOOR_FACTOR,
  SIZING_WINDOW_HOURS,
  SNAPSHOT_CLIP_OVERHEAD,
  cameraNeedBytes,
  computeSizing,
  growthDecision,
  initialReservedBytes,
  percentile,
  reservedForMode,
  sizingRetentionDays,
  type BitrateSample,
} from "./recordings-sizing.js";

const H = 3_600_000;
const NOW = new Date("2026-10-03T12:00:00.000Z");

/** A sample taken `hoursAgo` hours before NOW. */
const at = (hoursAgo: number, mbPerHour: number): BitrateSample => ({
  sampledAt: new Date(NOW.getTime() - hoursAgo * H),
  mbPerHour,
});
/** `n` hourly samples at one rate, 1..n hours old (so all inside the 72 h window for n ≤ 72). */
const steady = (n: number, mbPerHour: number): BitrateSample[] =>
  Array.from({ length: n }, (_, i) => at(i + 1, mbPerHour));
const g = (gib: number): number => gib * GIB;

describe("constants (the spec's numbers, pinned)", () => {
  it("exports every sizing constant with the agreed value", () => {
    expect(MIB).toBe(1_048_576);
    expect(GIB).toBe(1_073_741_824);
    expect(SIZING_WINDOW_HOURS).toBe(72);
    expect(HEADROOM).toBe(1.25);
    expect(NEW_CAMERA_HEADROOM).toBe(1.5);
    expect(SNAPSHOT_CLIP_OVERHEAD).toBe(1.02);
    expect(NEED_FLOOR_BYTES).toBe(20 * GIB);
    expect(GROW_TRIGGER_RATIO).toBe(0.85);
    expect(GROW_TARGET_FACTOR).toBe(1.1);
    expect(SHRINK_FLOOR_FACTOR).toBe(1.1);
    expect(SAMPLE_RETENTION_DAYS).toBe(14);
    expect(MIN_HISTORY_SAMPLES).toBe(2);
  });
});

describe("percentile — nearest-rank, never interpolated", () => {
  const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it("an empty list is 0, not NaN or undefined", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("a single value is its own percentile", () => {
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it("p95 of 1..20 is the 19th value (rank ceil(0.95 × 20) = 19)", () => {
    expect(percentile(upTo(20), 95)).toBe(19);
  });

  it("p95 of 1..100 is 95 and of 1..10 is 10 (rank ceil(9.5) = 10)", () => {
    expect(percentile(upTo(100), 95)).toBe(95);
    expect(percentile(upTo(10), 95)).toBe(10);
  });

  it("p95 over a full 72-sample window is rank 69 (ceil(68.4))", () => {
    expect(percentile(upTo(72), 95)).toBe(69);
  });

  it("p50 of [1,2,3,4] is 2 — a real sample, not the interpolated 2.5", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it("does not depend on input order and does not mutate its input", () => {
    const shuffled = Object.freeze([9, 1, 7, 3, 5, 2, 8, 4, 6, 10]);
    expect(percentile(shuffled, 95)).toBe(10);
    expect(percentile(shuffled, 50)).toBe(5);
    expect(shuffled).toEqual([9, 1, 7, 3, 5, 2, 8, 4, 6, 10]);
  });

  it("clamps: p100 is the maximum, p0 and below the minimum, above 100 the maximum", () => {
    const v = [5, 1, 9, 3];
    expect(percentile(v, 100)).toBe(9);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile(v, -10)).toBe(1);
    expect(percentile(v, 250)).toBe(9);
  });

  it("the rank arithmetic is exact for a non-integer p (99.9 of 1..1000 is 999, not 1000)", () => {
    // Naive `ceil(p / 100 * n)` evaluates 99.9/100*1000 as 999.0000000000001
    // and picks rank 1000 — the maximum, i.e. p100 — one rank too high.
    expect(percentile(upTo(1000), 99.9)).toBe(999);
  });

  it("ignores non-finite values rather than letting NaN poison the rank", () => {
    expect(percentile([Number.NaN, 5, Number.POSITIVE_INFINITY, 3], 100)).toBe(5);
    expect(percentile([Number.NaN, Number.POSITIVE_INFINITY], 95)).toBe(0);
  });
});

describe("cameraNeedBytes — one camera's need over the retention window", () => {
  it("no samples: nothing to size from, reported as such", () => {
    expect(cameraNeedBytes([], NOW, 7)).toEqual({ needBytes: 0, basis: "none", mbPerHour: null });
  });

  it("ONE sample is 'no history': first measurement × 1.5 headroom × 1.02 overhead", () => {
    // 400 MiB/h × 24 × 7 × 1.5 × 1.02 = 102 816 MiB
    const r = cameraNeedBytes([at(2, 400)], NOW, 7);
    expect(r).toEqual({ needBytes: 107_810_390_016, basis: "first_measurement", mbPerHour: 400 });
  });

  it("a lone sample of any age still sizes the camera (no window applies to it)", () => {
    expect(cameraNeedBytes([at(24 * 10, 400)], NOW, 7).needBytes).toBe(107_810_390_016);
  });

  it("TWO samples are enough for history (MIN_HISTORY_SAMPLES = 2)", () => {
    const r = cameraNeedBytes([at(2, 1000), at(1, 1000)], NOW, 7);
    expect(r.basis).toBe("history");
    expect(r.mbPerHour).toBe(1000);
  });

  it("history: 1000 MiB/h for 7 days = 1000 × MIB × 24 × 7 × 1.25 × 1.02, exactly", () => {
    // 1000 MiB/h × 24 h × 7 d × 1.25 × 1.02 = 214 200 MiB
    const r = cameraNeedBytes(steady(72, 1000), NOW, 7);
    expect(r.needBytes).toBe(224_604_979_200);
    expect(r.needBytes).toBe(Math.ceil(1000 * MIB * 24 * 7 * HEADROOM * SNAPSHOT_CLIP_OVERHEAD));
    expect(r.basis).toBe("history");
    expect(r.mbPerHour).toBe(1000);
  });

  it("scales linearly with the retention days (3 days of 1000 MiB/h)", () => {
    expect(cameraNeedBytes(steady(72, 1000), NOW, 3).needBytes).toBe(
      Math.ceil(1000 * MIB * 24 * 3 * HEADROOM * SNAPSHOT_CLIP_OVERHEAD),
    );
    expect(cameraNeedBytes(steady(72, 1000), NOW, 1).needBytes).toBe(32_086_425_600);
  });

  it("base = max(p95, latest): a latest sample ABOVE the p95 wins", () => {
    // 71 samples at 100 and one fresh spike at 700. n = 72, p95 rank = 69 →
    // still a 100 (only the very top rank is the spike), so p95 = 100 < latest.
    const s = [...Array.from({ length: 71 }, (_, i) => at(i + 2, 100)), at(1, 700)];
    const r = cameraNeedBytes(s, NOW, 7);
    expect(r.mbPerHour).toBe(700);
    expect(r.needBytes).toBe(157_223_485_440);
  });

  it("base = max(p95, latest): a p95 ABOVE the latest sample wins", () => {
    // 19 samples at 300 and the newest at 50. n = 20, p95 rank = 19 → 300.
    const s = [at(1, 50), ...Array.from({ length: 19 }, (_, i) => at(i + 2, 300))];
    const r = cameraNeedBytes(s, NOW, 7);
    expect(r.mbPerHour).toBe(300);
    expect(r.needBytes).toBe(67_381_493_760);
  });

  it("only the last 72 h count when the window has samples (a 5000 MiB/h week-old burst is ignored)", () => {
    const s = [at(100, 5000), at(101, 5000), at(102, 5000), at(3, 100), at(2, 110), at(1, 120)];
    const r = cameraNeedBytes(s, NOW, 7);
    // window = [100, 110, 120]: p95 rank ceil(2.85) = 3 → 120; latest = 120.
    expect(r.mbPerHour).toBe(120);
    expect(r.needBytes).toBe(26_952_597_504);
  });

  it("when NOTHING falls in the window, all samples are used (a camera that has been off for days)", () => {
    const s = [at(100, 100), at(110, 200), at(120, 300)];
    const r = cameraNeedBytes(s, NOW, 7);
    // p95 of [100,200,300] = 300; latest (the newest, 100 h old) = 100.
    expect(r.basis).toBe("history");
    expect(r.mbPerHour).toBe(300);
    expect(r.needBytes).toBe(67_381_493_760);
  });

  it("the window edge is inclusive at exactly 72 h and excludes 72 h + 1 ms", () => {
    const edge: BitrateSample = { sampledAt: new Date(NOW.getTime() - 72 * H), mbPerHour: 900 };
    const justOut: BitrateSample = { sampledAt: new Date(NOW.getTime() - 72 * H - 1), mbPerHour: 900 };
    expect(cameraNeedBytes([edge, at(1, 100), at(2, 100)], NOW, 7).mbPerHour).toBe(900);
    expect(cameraNeedBytes([justOut, at(1, 100), at(2, 100)], NOW, 7).mbPerHour).toBe(100);
  });

  it("rounds the byte count UP to an integer", () => {
    // 0.5 MiB/h × 24 × 1 × 1.25 × 1.02 × MIB = 16 043 212.8 bytes
    const r = cameraNeedBytes([at(2, 0.5), at(1, 0.5)], NOW, 1);
    expect(Number.isInteger(r.needBytes)).toBe(true);
    expect(r.needBytes).toBe(16_043_213);
  });

  it("is deterministic for any input order (every permutation of a mixed set gives one answer)", () => {
    const base: BitrateSample[] = [at(1, 40), at(5, 20), at(9, 30), at(30, 10)];
    const permutations = (xs: BitrateSample[]): BitrateSample[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    const results = permutations(base).map((p) => cameraNeedBytes(p, NOW, 7));
    expect(results).toHaveLength(24);
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it("two samples that share the NEWEST timestamp resolve to the higher rate, whatever the order", () => {
    // 18 older samples at 10 plus two tied at the newest instant (10 and 50):
    // n = 20 so p95 = rank 19 = 10 — only the tie-break can lift the base to 50.
    const t = new Date(NOW.getTime() - 1 * H);
    const older = Array.from({ length: 18 }, (_, i) => at(i + 2, 10));
    const lowFirst = [...older, { sampledAt: t, mbPerHour: 10 }, { sampledAt: t, mbPerHour: 50 }];
    const highFirst = [...older, { sampledAt: t, mbPerHour: 50 }, { sampledAt: t, mbPerHour: 10 }];
    expect(cameraNeedBytes(lowFirst, NOW, 7).mbPerHour).toBe(50);
    expect(cameraNeedBytes(highFirst, NOW, 7)).toEqual(cameraNeedBytes(lowFirst, NOW, 7));
  });

  it("does not mutate the samples it is given", () => {
    const s = Object.freeze([at(3, 30), at(1, 10), at(2, 20)]);
    expect(() => cameraNeedBytes(s, NOW, 7)).not.toThrow();
    expect(s.map((x) => x.mbPerHour)).toEqual([30, 10, 20]);
  });

  it("drops unusable rows (NaN, negative, infinite rate, invalid date) instead of propagating NaN", () => {
    const junk: BitrateSample[] = [
      at(1, Number.NaN),
      at(2, -5),
      at(3, Number.POSITIVE_INFINITY),
      { sampledAt: new Date("not a date"), mbPerHour: 100 },
    ];
    const r = cameraNeedBytes([...junk, at(4, 1000), at(5, 1000)], NOW, 7);
    expect(r).toEqual({ needBytes: 224_604_979_200, basis: "history", mbPerHour: 1000 });
    expect(cameraNeedBytes(junk, NOW, 7)).toEqual({ needBytes: 0, basis: "none", mbPerHour: null });
  });

  it("refuses a retention that is not a positive number rather than returning NaN", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => cameraNeedBytes(steady(3, 100), NOW, bad)).toThrow(RangeError);
    }
  });
});

describe("computeSizing — the whole box", () => {
  const samples = (mb: number): BitrateSample[] => [at(2, mb), at(1, mb)];

  it("sums the per-camera needs; the total is the sum when it is above the floor", () => {
    const sizing = computeSizing(
      new Map([
        ["front_door", samples(1000)],
        ["garage", samples(500)],
      ]),
      NOW,
      7,
    );
    expect(sizing.retentionDays).toBe(7);
    expect(sizing.cameras).toEqual([
      { name: "front_door", mbPerHour: 1000, needBytes: 224_604_979_200, basis: "history" },
      { name: "garage", mbPerHour: 500, needBytes: 112_302_489_600, basis: "history" },
    ]);
    expect(sizing.sumBytes).toBe(336_907_468_800);
    expect(sizing.needTotalBytes).toBe(336_907_468_800);
  });

  it("sizes mixed cameras from each camera's longest resolved retention window", () => {
    const sizing = computeSizing(
      new Map([["archive", samples(1000)], ["standard", samples(500)]]),
      NOW,
      7,
      ["archive", "standard"],
      new Map([["archive", 90], ["standard", 7]]),
    );
    expect(sizing.retentionDays).toBe(90);
    expect(sizing.cameras).toEqual([
      { name: "archive", mbPerHour: 1000, needBytes: Math.ceil(1000 * MIB * 24 * 90 * HEADROOM * SNAPSHOT_CLIP_OVERHEAD), basis: "history" },
      { name: "standard", mbPerHour: 500, needBytes: 112_302_489_600, basis: "history" },
    ]);
    expect(sizing.needTotalBytes).toBe(sizing.cameras.reduce((sum, camera) => sum + camera.needBytes, 0));
  });

  it("no cameras at all: the total is the 20 GiB floor, the sum is 0", () => {
    const sizing = computeSizing(new Map(), NOW, 7);
    expect(sizing.cameras).toEqual([]);
    expect(sizing.sumBytes).toBe(0);
    expect(sizing.needTotalBytes).toBe(NEED_FLOOR_BYTES);
    expect(NEED_FLOOR_BYTES).toBe(21_474_836_480);
  });

  it("a need below the floor is raised to it; sumBytes keeps the pre-floor figure", () => {
    // 10 MiB/h × 7 d × 1.275 ≈ 2.1 GiB — far below 20 GiB.
    const sizing = computeSizing(new Map([["porch", samples(10)]]), NOW, 7);
    expect(sizing.sumBytes).toBe(2_246_049_792);
    expect(sizing.needTotalBytes).toBe(NEED_FLOOR_BYTES);
  });

  it("a deleted camera must not keep reserving space: samples of unconfigured names are ignored", () => {
    const map = new Map([
      ["front_door", samples(1000)],
      ["deleted_cam", samples(50_000)],
    ]);
    const kept = computeSizing(map, NOW, 7, ["front_door"]);
    expect(kept.cameras.map((c) => c.name)).toEqual(["front_door"]);
    expect(kept.needTotalBytes).toBe(224_604_979_200);

    // Any iterable works, not just an array.
    expect(computeSizing(map, NOW, 7, new Set(["front_door"])).needTotalBytes).toBe(224_604_979_200);

    // Without a configured list nothing is excluded.
    expect(computeSizing(map, NOW, 7).cameras.map((c) => c.name)).toEqual(["front_door", "deleted_cam"]);
  });

  it("an EMPTY configured list is still a list: every sample is ignored and the floor applies", () => {
    const sizing = computeSizing(new Map([["front_door", samples(1000)]]), NOW, 7, []);
    expect(sizing.cameras).toEqual([]);
    expect(sizing.needTotalBytes).toBe(NEED_FLOOR_BYTES);
  });

  it("a camera with a map entry but no samples is reported as basis 'none', need 0", () => {
    const sizing = computeSizing(new Map([["new_cam", []]]), NOW, 7);
    expect(sizing.cameras).toEqual([{ name: "new_cam", mbPerHour: null, needBytes: 0, basis: "none" }]);
  });

  it("a brand-new single-sample camera uses the 1.5 first-measurement headroom", () => {
    const sizing = computeSizing(new Map([["new_cam", [at(1, 400)]]]), NOW, 7);
    expect(sizing.cameras[0]).toEqual({
      name: "new_cam",
      mbPerHour: 400,
      needBytes: 107_810_390_016,
      basis: "first_measurement",
    });
  });

  it("keeps the order of the input map (the loader sorts by camera name)", () => {
    const sizing = computeSizing(
      new Map([
        ["zeta", samples(10)],
        ["alpha", samples(10)],
      ]),
      NOW,
      7,
    );
    expect(sizing.cameras.map((c) => c.name)).toEqual(["zeta", "alpha"]);
  });
});

describe("sizingRetentionDays", () => {
  const d = (continuousDays: number, motionDays: number, alertsRetainDays: number, detectionsRetainDays: number) => ({
    continuousDays,
    motionDays,
    alertsRetainDays,
    detectionsRetainDays,
  });

  it("is the longest of the four windows", () => {
    expect(sizingRetentionDays(d(3, 30, 14, 14))).toBe(30);
    expect(sizingRetentionDays(d(7, 7, 7, 7))).toBe(7);
    expect(sizingRetentionDays(d(7, 7, 21, 7))).toBe(21);
    expect(sizingRetentionDays(d(1, 2, 3, 4))).toBe(4);
  });

  it("never drops below 1 day, even when every window is off", () => {
    expect(sizingRetentionDays(d(0, 0, 0, 0))).toBe(1);
  });

  it("ignores snapshots (they are covered by the 2 % overhead) and accepts the full defaults object", () => {
    const full = { ...d(7, 7, 7, 7), preCaptureSec: 20, postCaptureSec: 20, snapshotRetainDays: 90 };
    expect(sizingRetentionDays(full)).toBe(7);
  });
});

describe("growthDecision — when and how far the slice grows", () => {
  const grow = (over: Partial<Parameters<typeof growthDecision>[0]> = {}) =>
    growthDecision({
      mode: "AUTO_RESERVED",
      reservedBytes: g(100),
      needTotalBytes: g(120),
      usedBytes: g(60),
      fsFreeBytes: g(900),
      fsSizeBytes: g(1000),
      ...over,
    });

  it("whole-drive (FULL) mode never grows — the slice already IS the filesystem", () => {
    const d = grow({ mode: "FULL", needTotalBytes: g(5000) });
    expect(d.action).toBe("none");
    expect(d.targetBytes).toBeUndefined();
  });

  it("a need within 85 % of the reservation needs nothing — the boundary is inclusive", () => {
    expect(grow({ needTotalBytes: g(80) }).action).toBe("none");
    expect(grow({ needTotalBytes: g(85) }).action).toBe("none"); // exactly 0.85 × 100 GiB
  });

  it("over 85 % but the grow target (need × 1.1) is not above the reservation: still nothing — never shrink", () => {
    // 90 GiB × 1.1 = 99 GiB ≤ 100 GiB. Growing "to" 99 GiB would SHRINK the quota.
    const d = grow({ needTotalBytes: g(90) });
    expect(d.action).toBe("none");
    expect(d.targetBytes).toBeUndefined();
  });

  it("a grow target exactly EQUAL to the reservation is still 'nothing' — growth needs a target above it", () => {
    // need 120 GiB → target 132 GiB; the slice already is exactly 132 GiB.
    const d = grow({ reservedBytes: g(132), needTotalBytes: g(120) });
    expect(d.action).toBe("none");
    expect(d.targetBytes).toBeUndefined();
  });

  it("grows to need × 1.1 when it is above the reservation and the drive has room", () => {
    const d = grow(); // 120 GiB × 1.1 = 132 GiB
    expect(d).toMatchObject({ action: "grow", targetBytes: g(132), partial: false });
    expect(typeof d.reason).toBe("string");
  });

  it("just over the reservation: need 91 GiB → target 100.1 GiB (rounded up) is a grow", () => {
    const d = grow({ needTotalBytes: g(91) });
    expect(d.action).toBe("grow");
    expect(d.targetBytes).toBe(107_481_556_583);
    expect(d.targetBytes).toBeGreaterThan(g(100));
  });

  it("is bounded by what the drive can hold (used + free) but not partial while it still covers the need", () => {
    // R 80, need 100, used 50, free 55 → ceiling 105 GiB < target 110 GiB, ≥ need.
    const d = grow({ reservedBytes: g(80), needTotalBytes: g(100), usedBytes: g(50), fsFreeBytes: g(55) });
    expect(d).toMatchObject({ action: "grow", targetBytes: g(105), partial: false });
  });

  it("partial means STRICTLY below the need: a ceiling exactly at the need is a complete grow", () => {
    // R 80, need 100, used 50 + free 50 = a ceiling of exactly 100 GiB.
    const d = grow({ reservedBytes: g(80), needTotalBytes: g(100), usedBytes: g(50), fsFreeBytes: g(50) });
    expect(d).toMatchObject({ action: "grow", targetBytes: g(100), partial: false });
  });

  it("PARTIAL grow: the drive can only give part of what is needed — the caller marks DEGRADED", () => {
    // need 200, used 90, free 30 → ceiling 120 GiB: more than the 100 reserved, less than the need.
    const d = grow({ needTotalBytes: g(200), usedBytes: g(90), fsFreeBytes: g(30) });
    expect(d).toMatchObject({ action: "grow", targetBytes: g(120), partial: true });
  });

  it("DEGRADE when there is no room at all (ceiling is not above the reservation)", () => {
    // used 95 + free 5 = 100 GiB = what is already reserved.
    const d = grow({ needTotalBytes: g(200), usedBytes: g(95), fsFreeBytes: g(5) });
    expect(d.action).toBe("degrade");
    expect(d.targetBytes).toBeUndefined();
    expect(d.partial).toBeUndefined();
  });

  it("DEGRADE when the whole drive is no larger than the slice", () => {
    const d = grow({ fsSizeBytes: g(100), usedBytes: g(40), fsFreeBytes: g(60), needTotalBytes: g(150) });
    expect(d.action).toBe("degrade");
  });

  it("the filesystem size caps the ceiling even if used + free claims more", () => {
    const d = grow({ fsSizeBytes: g(110), usedBytes: g(60), fsFreeBytes: g(900), needTotalBytes: g(150) });
    expect(d).toMatchObject({ action: "grow", targetBytes: g(110), partial: true });
  });

  it("figures that are not known are not guessed: no action, with a reason", () => {
    for (const over of [
      { usedBytes: null },
      { fsFreeBytes: undefined },
      { fsSizeBytes: Number.NaN },
      { usedBytes: -1 },
    ]) {
      const d = grow(over);
      expect(d.action).toBe("none");
      expect(d.reason).toMatch(/unavailable/);
    }
  });

  it("never returns a target at or below the reservation, nor above what the drive can hold (sweep)", () => {
    let grows = 0;
    for (const reserved of [g(40), g(100), g(500)]) {
      for (const need of [g(20), g(35), g(60), g(85), g(95), g(150), g(400), g(2000)]) {
        for (const used of [g(0), g(30), reserved - g(5), reserved]) {
          for (const free of [g(0), g(10), g(300), g(5000)]) {
            for (const size of [g(100), g(1000), g(6000)]) {
              const d = growthDecision({
                mode: "AUTO_RESERVED",
                reservedBytes: reserved,
                needTotalBytes: need,
                usedBytes: used,
                fsFreeBytes: free,
                fsSizeBytes: size,
              });
              if (d.action === "grow") {
                grows++;
                expect(d.targetBytes).toBeGreaterThan(reserved);
                expect(d.targetBytes).toBeLessThanOrEqual(Math.min(size, used + free));
                expect(d.targetBytes).toBeLessThanOrEqual(Math.ceil(need * GROW_TARGET_FACTOR));
                expect(d.partial).toBe((d.targetBytes as number) < need);
              } else {
                expect(d.targetBytes).toBeUndefined();
              }
            }
          }
        }
      }
    }
    expect(grows).toBeGreaterThan(50); // the sweep really exercised the grow branch
  });
});

describe("reservedForMode — what a mode switch reserves", () => {
  const base = { needTotalBytes: g(150), usedBytes: g(60), fsSizeBytes: g(1000), fsFreeBytes: g(900) };

  it("FULL is the whole filesystem", () => {
    expect(reservedForMode("FULL", base)).toBe(g(1000));
  });

  it("AUTO_RESERVED is the measured need when that is above used × 1.1", () => {
    expect(reservedForMode("AUTO_RESERVED", base)).toBe(g(150));
  });

  it("AUTO_RESERVED never goes below used × 1.1, however small the measured need", () => {
    // need = 20 GiB floor, but 60 GiB are already there → 66 GiB.
    expect(reservedForMode("AUTO_RESERVED", { ...base, needTotalBytes: g(20) })).toBe(g(66));
  });

  it("AUTO_RESERVED is bounded by what the drive can hold (used + free)", () => {
    expect(reservedForMode("AUTO_RESERVED", { ...base, needTotalBytes: g(950), fsFreeBytes: g(100) })).toBe(g(160));
  });

  it("AUTO_RESERVED is bounded by the filesystem size", () => {
    expect(
      reservedForMode("AUTO_RESERVED", { ...base, needTotalBytes: g(2000), fsFreeBytes: g(2000) }),
    ).toBe(g(1000));
  });

  it("when the drive has no room even for the 10 % headroom, it is capped at what the drive holds — never below used", () => {
    // 900 GiB used + 10 GiB free = a 910 GiB ceiling; used × 1.1 = 990 GiB cannot fit.
    const r = reservedForMode("AUTO_RESERVED", {
      needTotalBytes: g(20),
      usedBytes: g(900),
      fsSizeBytes: g(1000),
      fsFreeBytes: g(10),
    });
    expect(r).toBe(g(910));
    expect(r).toBeGreaterThanOrEqual(g(900));
  });

  it("refuses figures that are not finite, non-negative numbers (a NaN quota must never reach the host)", () => {
    expect(() => reservedForMode("AUTO_RESERVED", { ...base, fsSizeBytes: Number.NaN })).toThrow(RangeError);
    expect(() => reservedForMode("FULL", { ...base, fsSizeBytes: -1 })).toThrow(RangeError);
    expect(() => reservedForMode("AUTO_RESERVED", { ...base, usedBytes: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe("initialReservedBytes — the first reservation on a new drive", () => {
  it("is the measured need when the drive has that much free", () => {
    expect(initialReservedBytes(g(20), g(500))).toBe(g(20));
  });

  it("is capped at what the drive has free", () => {
    expect(initialReservedBytes(g(300), g(100))).toBe(g(100));
  });

  it("refuses figures that are not finite, non-negative numbers", () => {
    expect(() => initialReservedBytes(Number.NaN, g(1))).toThrow(RangeError);
    expect(() => initialReservedBytes(g(1), -5)).toThrow(RangeError);
  });
});
