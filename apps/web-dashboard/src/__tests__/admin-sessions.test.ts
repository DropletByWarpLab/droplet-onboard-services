/**
 * WARP-2820 — /admin/sessions wording.
 *
 * These two helpers are where a unit mistake becomes a lie on screen. The
 * session store's clocks are EPOCH SECONDS; the browser's are milliseconds.
 * Mixing them does not throw — it renders "56 y ago" or "expiring now" on a
 * session that has seven hours left, and an operator acts on that.
 */
import { describe, it, expect } from "vitest";
import { ago, untilPhrase } from "@/app/admin/sessions/format";

/** A fixed "now", in the unit the session store uses. */
const NOW = 1_788_800_000;

describe("ago (WARP-2820)", () => {
  it("says just now inside the first minute", () => {
    expect(ago(NOW, NOW)).toBe("just now");
    expect(ago(NOW - 59, NOW)).toBe("just now");
  });

  it("crosses to minutes, hours and days at the right boundaries", () => {
    expect(ago(NOW - 60, NOW)).toBe("1 min ago");
    expect(ago(NOW - 59 * 60, NOW)).toBe("59 min ago");
    expect(ago(NOW - 60 * 60, NOW)).toBe("1 h ago");
    expect(ago(NOW - 23 * 3600, NOW)).toBe("23 h ago");
    expect(ago(NOW - 24 * 3600, NOW)).toBe("1 d ago");
  });

  it("never renders a negative age", () => {
    // A record written by a box whose clock is a second ahead of the browser
    // is ordinary. "-1 min ago" reads as a broken product.
    expect(ago(NOW + 30, NOW)).toBe("just now");
  });

  it("treats its input as SECONDS, not milliseconds", () => {
    // The trap: passing Date.now() (ms) as the epoch. If this helper ever
    // starts dividing or multiplying internally, an hour-old session stops
    // reading as an hour old and this fails.
    expect(ago(NOW - 3600, NOW)).toBe("1 h ago");
    expect(ago(NOW - 3600, NOW)).not.toContain("y ago");
  });
});

describe("untilPhrase (WARP-2820)", () => {
  it("counts down in minutes, then hours", () => {
    expect(untilPhrase(NOW + 5 * 60, NOW)).toBe("5 min left");
    expect(untilPhrase(NOW + 59 * 60, NOW)).toBe("59 min left");
    expect(untilPhrase(NOW + 2 * 3600, NOW)).toBe("2 h left");
  });

  it("says expiring now rather than a negative remainder", () => {
    // A session past its deadline has simply not been swept yet. "-3 min left"
    // reads as a bug; "expiring now" is what is actually true.
    expect(untilPhrase(NOW, NOW)).toBe("expiring now");
    expect(untilPhrase(NOW - 600, NOW)).toBe("expiring now");
  });

  it("never rounds a live session down to zero", () => {
    // Under a minute left is still left. "0 min left" would read as expired.
    expect(untilPhrase(NOW + 30, NOW)).toBe("1 min left");
  });
});
