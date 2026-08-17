/**
 * WARP-1993 — byte-string pins for the Folders tile.
 *
 * The endpoint sends decimal STRINGS because a quota can exceed
 * Number.MAX_SAFE_INTEGER. Number() would be right for every value a tester
 * types and wrong for the ones that matter, so these hold the BigInt path —
 * and hold the three non-numeric values apart from zero, which is the
 * distinction the whole tile rests on.
 */
import { describe, it, expect } from "vitest";
import {
  UNREADABLE,
  formatBigint,
  formatBytes,
  parseBytes,
  quotaTone,
  sumBytes,
  usedPercent,
} from "@/app/reports/bytes";

describe("parseBytes", () => {
  it("parses beyond Number.MAX_SAFE_INTEGER without losing precision", () => {
    // 2^63-1. As a Number this rounds to 9223372036854775808 — off by one.
    const huge = "9223372036854775807";
    expect(parseBytes(huge)).toBe(BigInt("9223372036854775807"));
    expect(parseBytes(huge)!.toString()).toBe(huge);
  });

  it("rejects the route's em-dash marker rather than reading it as a size", () => {
    expect(parseBytes("—")).toBeNull();
    expect(parseBytes(UNREADABLE)).toBeNull();
  });

  it("rejects null, empty, negative and non-numeric", () => {
    for (const v of [null, undefined, "", "  ", "-5", "1.5", "10 GB", "NaN"]) {
      expect(parseBytes(v as string | null)).toBeNull();
    }
  });

  it("parses zero as zero, distinct from unreadable", () => {
    expect(parseBytes("0")).toBe(BigInt(0));
    expect(parseBytes("0")).not.toBeNull();
  });
});

describe("formatBytes", () => {
  it("keeps 0 B distinct from unreadable — empty is not unknown", () => {
    expect(formatBytes("0")).toBe("0 B");
    expect(formatBytes("—")).toBe(UNREADABLE);
    expect(formatBytes(null)).toBe(UNREADABLE);
  });

  it("formats binary units", () => {
    expect(formatBytes("512")).toBe("512 B");
    expect(formatBytes("1024")).toBe("1.0 KB");
    expect(formatBytes((1024 ** 3).toString())).toBe("1.0 GB");
    expect(formatBytes((1024 ** 4).toString())).toBe("1.0 TB");
  });

  it("TRUNCATES rather than rounds — 9.99 GB of 10 must not read as 10.0", () => {
    // The failure this pins: a folder that is not yet full rendering as full.
    const nearlyTen = (Math.floor(1024 ** 3 * 9.99)).toString();
    expect(formatBytes(nearlyTen)).toBe("9.9 GB");
  });

  it("handles petabyte-scale without overflowing the unit table", () => {
    expect(formatBytes((BigInt(1024) ** BigInt(5)).toString())).toBe("1.0 PB");
    // Beyond PB it stays in PB rather than reading undefined.
    expect(formatBytes((BigInt(1024) ** BigInt(6)).toString())).toMatch(/PB$/);
  });
});

describe("usedPercent", () => {
  it("computes a normal ratio", () => {
    expect(usedPercent("5", "10")).toBe(50);
  });

  it("returns null for unlimited quota — a bar with no ceiling measures nothing", () => {
    expect(usedPercent("1000", null)).toBeNull();
  });

  it("returns null for an unreadable size", () => {
    expect(usedPercent("—", "10")).toBeNull();
  });

  it("returns null for a zero quota rather than dividing by zero", () => {
    // Zero quota is not "full" — it's unset. Infinity or NaN here would
    // render a bar at some arbitrary width.
    expect(usedPercent("5", "0")).toBeNull();
  });

  it("does not floor a real ratio to 0 — it scales before dividing", () => {
    // The bug this pins: BigInt division truncating (u / q) to zero before
    // the ×100, so every folder under 100% reads as 0%.
    expect(usedPercent("1", "10")).toBe(10);
    expect(usedPercent("9", "10")).toBe(90);
  });

  it("rounds DOWN — 99.6% is not 100%", () => {
    expect(usedPercent("996", "1000")).toBe(99);
  });

  it("reports over-quota above 100 rather than clamping", () => {
    expect(usedPercent("15", "10")).toBe(150);
  });

  it("stays exact at sizes Number would round", () => {
    const quota = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    expect(usedPercent(quota, quota)).toBe(100);
  });
});

describe("quotaTone", () => {
  it("splits at the brief's thresholds", () => {
    expect(quotaTone(0)).toBe("ok");
    expect(quotaTone(74)).toBe("ok");
    expect(quotaTone(75)).toBe("warn");
    expect(quotaTone(95)).toBe("warn");
    expect(quotaTone(96)).toBe("over");
    expect(quotaTone(150)).toBe("over");
  });
});

describe("sumBytes / formatBigint", () => {
  it("skips unreadable rows instead of poisoning the total", () => {
    // The failure this pins: one unresolvable folder turning the box total
    // into NaN, which would render as "NaN GB" across the footer.
    expect(sumBytes(["100", "—", "200", null])).toBe(BigInt(300));
  });

  it("sums past the safe-integer ceiling exactly", () => {
    const big = "9007199254740993";
    expect(sumBytes([big, big])).toBe(BigInt("18014398509481986"));
  });

  it("formats a summed total", () => {
    expect(formatBigint(BigInt(1024) ** BigInt(3))).toBe("1.0 GB");
    expect(formatBigint(BigInt(0))).toBe("0 B");
  });
});
