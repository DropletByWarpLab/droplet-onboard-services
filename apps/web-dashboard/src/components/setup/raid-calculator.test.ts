/**
 * BUG-3 / ADR-019 — RAID storage calculator (setup wizard).
 *
 * The calculator is a PURE function over the detected-drive sizes. It computes
 * usable capacity per applicable RAID level and reports which levels the
 * drive count can / can't support, so the setup step can grey out the ones
 * that don't apply and show an honest usable figure for the ones that do.
 *
 * Capacity rules (ADR-019 levels; smallest-drive rule for any redundant level):
 *   - jbod  / raid0 → sum of all drives        (no redundancy; raid0 needs ≥2)
 *   - raid1         → smallest                  (mirror;   needs ≥2)
 *   - raid5         → (N−1) × smallest          (parity;   needs ≥3)
 *   - raid6         → (N−2) × smallest          (2-parity; needs ≥4)
 *   - raid10        → (N/2) × smallest          (stripe+mirror; needs ≥4, even)
 *
 * These tests are the core of the feature — every level, every drive count,
 * mixed sizes, and the greyed-out / needs-N-drives logic.
 */
import { describe, it, expect } from "vitest";
import {
  calculateRaidOptions,
  minDrivesFor,
  type RaidCalcDrive,
} from "./raid-calculator";

const TB = 1_000_000_000_000;

/** Helper: build n drives of equal size. */
function drives(...sizes: number[]): RaidCalcDrive[] {
  return sizes.map((size_bytes, i) => ({
    device: `/dev/sd${String.fromCharCode(97 + i)}`,
    size_bytes,
  }));
}

/** Pull one level option out of the result by its enum value. */
function level(opts: ReturnType<typeof calculateRaidOptions>, lvl: string) {
  const found = opts.find((o) => o.level === lvl);
  if (!found) throw new Error(`level ${lvl} not in options`);
  return found;
}

describe("minDrivesFor", () => {
  it("encodes the per-level minimum drive count", () => {
    expect(minDrivesFor("jbod")).toBe(1);
    expect(minDrivesFor("raid0")).toBe(2);
    expect(minDrivesFor("raid1")).toBe(2);
    expect(minDrivesFor("raid5")).toBe(3);
    expect(minDrivesFor("raid6")).toBe(4);
    expect(minDrivesFor("raid10")).toBe(4);
  });
});

describe("calculateRaidOptions — level coverage + ordering", () => {
  it("returns every ADR-019 level exactly once", () => {
    const opts = calculateRaidOptions(drives(TB, TB));
    const levels = opts.map((o) => o.level).sort();
    expect(levels).toEqual(
      ["jbod", "raid0", "raid1", "raid10", "raid5", "raid6"].sort(),
    );
  });
});

describe("calculateRaidOptions — 2 equal drives (the box's real shape)", () => {
  // The box ships 2× 1.8 TB. Only JBOD/RAID0 (3.6 TB) and RAID1 (1.8 TB)
  // are selectable; 5/6/10 are greyed.
  const config = drives(1.8 * TB, 1.8 * TB);

  it("JBOD = sum, selectable", () => {
    const o = level(calculateRaidOptions(config), "jbod");
    expect(o.usableBytes).toBe(3.6 * TB);
    expect(o.selectable).toBe(true);
  });

  it("RAID 0 = sum, selectable at 2 drives", () => {
    const o = level(calculateRaidOptions(config), "raid0");
    expect(o.usableBytes).toBe(3.6 * TB);
    expect(o.selectable).toBe(true);
  });

  it("RAID 1 = smallest, selectable at 2 drives", () => {
    const o = level(calculateRaidOptions(config), "raid1");
    expect(o.usableBytes).toBe(1.8 * TB);
    expect(o.selectable).toBe(true);
  });

  it("RAID 5/6/10 greyed out with a needs-N-drives reason", () => {
    const opts = calculateRaidOptions(config);
    for (const lvl of ["raid5", "raid6", "raid10"]) {
      const o = level(opts, lvl);
      expect(o.selectable).toBe(false);
      expect(o.unavailableReason).toMatch(/needs \d+\+? drives/i);
    }
    // RAID 5 needs 3, RAID 6 and 10 need 4 — the copy names the real number.
    expect(level(opts, "raid5").unavailableReason).toMatch(/3/);
    expect(level(opts, "raid6").unavailableReason).toMatch(/4/);
    expect(level(opts, "raid10").unavailableReason).toMatch(/4/);
  });
});

describe("calculateRaidOptions — 3 equal drives", () => {
  const config = drives(2 * TB, 2 * TB, 2 * TB);

  it("JBOD / RAID 0 sum all three", () => {
    expect(level(calculateRaidOptions(config), "jbod").usableBytes).toBe(6 * TB);
    expect(level(calculateRaidOptions(config), "raid0").usableBytes).toBe(6 * TB);
  });

  it("RAID 1 is still the smallest single drive", () => {
    expect(level(calculateRaidOptions(config), "raid1").usableBytes).toBe(2 * TB);
  });

  it("RAID 5 becomes selectable at 3 drives: (N-1) × smallest", () => {
    const o = level(calculateRaidOptions(config), "raid5");
    expect(o.selectable).toBe(true);
    expect(o.usableBytes).toBe(4 * TB); // (3-1) × 2TB
  });

  it("RAID 6 still needs 4 drives", () => {
    expect(level(calculateRaidOptions(config), "raid6").selectable).toBe(false);
  });

  it("RAID 10 still needs 4 (and even)", () => {
    expect(level(calculateRaidOptions(config), "raid10").selectable).toBe(false);
  });
});

describe("calculateRaidOptions — 4 equal drives", () => {
  const config = drives(2 * TB, 2 * TB, 2 * TB, 2 * TB);

  it("JBOD / RAID 0 sum all four", () => {
    expect(level(calculateRaidOptions(config), "jbod").usableBytes).toBe(8 * TB);
    expect(level(calculateRaidOptions(config), "raid0").usableBytes).toBe(8 * TB);
  });

  it("RAID 5 = (N-1) × smallest = 6 TB", () => {
    const o = level(calculateRaidOptions(config), "raid5");
    expect(o.selectable).toBe(true);
    expect(o.usableBytes).toBe(6 * TB);
  });

  it("RAID 6 becomes selectable at 4 drives: (N-2) × smallest = 4 TB", () => {
    const o = level(calculateRaidOptions(config), "raid6");
    expect(o.selectable).toBe(true);
    expect(o.usableBytes).toBe(4 * TB);
  });

  it("RAID 10 becomes selectable at 4 even drives: (N/2) × smallest = 4 TB", () => {
    const o = level(calculateRaidOptions(config), "raid10");
    expect(o.selectable).toBe(true);
    expect(o.usableBytes).toBe(4 * TB);
  });
});

describe("calculateRaidOptions — 5 drives (odd count, RAID 10 edge)", () => {
  const config = drives(2 * TB, 2 * TB, 2 * TB, 2 * TB, 2 * TB);

  it("RAID 5 = (5-1) × smallest = 8 TB", () => {
    expect(level(calculateRaidOptions(config), "raid5").usableBytes).toBe(8 * TB);
  });

  it("RAID 6 = (5-2) × smallest = 6 TB", () => {
    expect(level(calculateRaidOptions(config), "raid6").usableBytes).toBe(6 * TB);
  });

  it("RAID 10 is NOT selectable on an odd drive count", () => {
    const o = level(calculateRaidOptions(config), "raid10");
    expect(o.selectable).toBe(false);
    expect(o.unavailableReason).toMatch(/even/i);
  });
});

describe("calculateRaidOptions — mixed drive sizes (smallest-drive rule)", () => {
  // 1 TB + 2 TB + 3 TB. Redundant levels are bounded by the SMALLEST drive,
  // not the average — this is the rule users get wrong, so test it directly.
  const config = drives(1 * TB, 2 * TB, 3 * TB);

  it("JBOD / RAID 0 sum the raw bytes (6 TB), ignoring the smallest rule", () => {
    expect(level(calculateRaidOptions(config), "jbod").usableBytes).toBe(6 * TB);
    expect(level(calculateRaidOptions(config), "raid0").usableBytes).toBe(6 * TB);
  });

  it("RAID 1 = the SMALLEST drive (1 TB), not the average", () => {
    expect(level(calculateRaidOptions(config), "raid1").usableBytes).toBe(1 * TB);
  });

  it("RAID 5 = (N-1) × SMALLEST = 2 TB, not (sum - largest)", () => {
    // (3-1) × 1TB = 2TB — a naive "sum minus one drive" would wrongly give 3TB.
    expect(level(calculateRaidOptions(config), "raid5").usableBytes).toBe(2 * TB);
  });
});

describe("calculateRaidOptions — mixed sizes, 4 drives, RAID 6 / 10", () => {
  const config = drives(1 * TB, 2 * TB, 2 * TB, 4 * TB);

  it("RAID 6 = (N-2) × smallest = 2 TB", () => {
    expect(level(calculateRaidOptions(config), "raid6").usableBytes).toBe(2 * TB);
  });

  it("RAID 10 = (N/2) × smallest = 2 TB", () => {
    expect(level(calculateRaidOptions(config), "raid10").usableBytes).toBe(2 * TB);
  });
});

describe("calculateRaidOptions — degenerate inputs", () => {
  it("a single drive: only JBOD is selectable; everything else greyed", () => {
    const opts = calculateRaidOptions(drives(2 * TB));
    expect(level(opts, "jbod").selectable).toBe(true);
    expect(level(opts, "jbod").usableBytes).toBe(2 * TB);
    for (const lvl of ["raid0", "raid1", "raid5", "raid6", "raid10"]) {
      expect(level(opts, lvl).selectable).toBe(false);
    }
  });

  it("zero drives: nothing is selectable and capacities are zero", () => {
    const opts = calculateRaidOptions([]);
    for (const o of opts) {
      expect(o.selectable).toBe(false);
      expect(o.usableBytes).toBe(0);
    }
  });

  it("ignores zero/negative-sized drives when counting and summing", () => {
    // A bridge can momentarily report a drive with size_bytes 0; it must not
    // inflate the count (turning RAID 1 selectable on a single real drive) nor
    // the sum.
    const opts = calculateRaidOptions(drives(2 * TB, 0, -5));
    expect(level(opts, "jbod").usableBytes).toBe(2 * TB);
    expect(level(opts, "raid1").selectable).toBe(false); // only 1 real drive
  });
});

describe("calculateRaidOptions — every option carries a redundancy note", () => {
  it("each level has a plain-language blurb (reused from pool-display)", () => {
    const opts = calculateRaidOptions(drives(2 * TB, 2 * TB, 2 * TB, 2 * TB));
    for (const o of opts) {
      expect(o.blurb.length).toBeGreaterThan(0);
    }
    // Redundancy framing is honest: raid0/jbod say "no redundancy"; mirrors
    // and parity say they survive a failure.
    expect(level(opts, "raid0").blurb).toMatch(/no redundancy/i);
    expect(level(opts, "jbod").blurb).toMatch(/no redundancy/i);
    expect(level(opts, "raid1").blurb).toMatch(/survives one drive/i);
    expect(level(opts, "raid6").blurb).toMatch(/two drives/i);
  });
});
