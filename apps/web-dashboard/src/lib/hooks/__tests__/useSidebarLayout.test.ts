/**
 * WARP-2956 — pure helpers behind the desktop sidebar's collapse / resize.
 * The persisted width is clamped on read so a hand-edited or stale
 * localStorage value can never paint a 40px or 900px rail.
 */
import { describe, it, expect } from "vitest";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_RAIL,
} from "@/lib/hooks/useSidebarLayout";

describe("clampSidebarWidth (WARP-2956)", () => {
  it("pins the range at 200–360 with a 260 default and a 64px rail", () => {
    expect(SIDEBAR_MIN).toBe(200);
    expect(SIDEBAR_MAX).toBe(360);
    expect(SIDEBAR_DEFAULT).toBe(260);
    expect(SIDEBAR_RAIL).toBe(64);
  });

  it("clamps below the floor, above the ceiling, keeps in-range, defaults NaN", () => {
    expect(clampSidebarWidth(100)).toBe(200);
    expect(clampSidebarWidth(500)).toBe(360);
    expect(clampSidebarWidth(261)).toBe(261);
    expect(clampSidebarWidth(NaN)).toBe(260);
  });
});
