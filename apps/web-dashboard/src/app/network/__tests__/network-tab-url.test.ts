/**
 * WARP-100 — URL ⟷ tab mapping for the Network page.
 *
 * The page reads `?tab=<id>` via useSearchParams so deep-links and the
 * cross-tab jump from DeviceDetailPanel land on the right tab. Pin the
 * pure parse so a renamed/removed tab can't silently regress the mapping
 * without mounting the whole hook-heavy page.
 */
import { describe, it, expect } from "vitest";
import { parseNetworkTab } from "../tab-url";

describe("parseNetworkTab (WARP-100)", () => {
  it("maps a valid tab id through unchanged", () => {
    expect(parseNetworkTab("schedules")).toBe("schedules");
    expect(parseNetworkTab("devices")).toBe("devices");
    expect(parseNetworkTab("wifi")).toBe("wifi");
    expect(parseNetworkTab("firewall")).toBe("firewall");
    expect(parseNetworkTab("system")).toBe("system");
    expect(parseNetworkTab("privacy")).toBe("privacy");
    expect(parseNetworkTab("overview")).toBe("overview");
  });

  it("falls back to overview for missing/null/unknown values", () => {
    expect(parseNetworkTab(null)).toBe("overview");
    expect(parseNetworkTab(undefined)).toBe("overview");
    expect(parseNetworkTab("")).toBe("overview");
    expect(parseNetworkTab("nope")).toBe("overview");
    // No prototype-pollution surprise: inherited keys aren't valid tabs.
    expect(parseNetworkTab("toString")).toBe("overview");
  });
});
