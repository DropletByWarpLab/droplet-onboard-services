/**
 * WARP-3515 — `formatBinaryBytes`, extracted from the /cameras/system page.
 *
 * The page carried a private `fmtBytes` (binary maths, binary labels —
 * WARP-1960). The Recording storage card sits on that same page and has to
 * format drive figures identically, so the one function moved here rather than
 * being copied a second time. These cases pin the behaviour that moved.
 */
import { describe, it, expect } from "vitest";
import { formatBinaryBytes } from "./format-bytes";

const KIB = 1024;
const MIB = KIB ** 2;
const GIB = KIB ** 3;
const TIB = KIB ** 4;

describe("formatBinaryBytes", () => {
  it.each([
    [0, "0.00 B"],
    [512, "512 B"],
    [1.5 * KIB, "1.50 KiB"],
    [5 * MIB, "5.00 MiB"],
    [12.5 * GIB, "12.5 GiB"],
    [150 * GIB, "150 GiB"],
    [2 * TIB, "2.00 TiB"],
  ])("%d -> %s", (bytes, expected) => {
    expect(formatBinaryBytes(bytes)).toBe(expected);
  });

  it("clamps at TiB rather than inventing a unit", () => {
    expect(formatBinaryBytes(2048 * TIB)).toBe("2048 TiB");
  });

  it("renders an em dash for a figure it cannot trust", () => {
    expect(formatBinaryBytes(Number.NaN)).toBe("—");
    expect(formatBinaryBytes(-1)).toBe("—");
    expect(formatBinaryBytes(Infinity)).toBe("—");
  });
});
