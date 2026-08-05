/**
 * WARP-100 — URL ⟷ tab mapping for the Network page.
 *
 * The page reads `?tab=<id>` via useSearchParams so deep-links and the
 * cross-tab jump from DeviceDetailPanel land on the right tab. Pin the
 * pure parse so a renamed/removed tab can't silently regress the mapping
 * without mounting the whole hook-heavy page.
 */
import { describe, it, expect } from "vitest";
import { NETWORK_TABS, networkTabHref, parseNetworkTab } from "../tab-url";

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

// WARP-1723 — the inverse mapping. Cross-tab links (the Coverage Extenders
// panel's "Change in Wi-Fi settings") build their hrefs here rather than
// re-typing the `?tab=` scheme inline.
describe("networkTabHref (WARP-1723)", () => {
  it("builds the ?tab= URL for a non-default tab", () => {
    expect(networkTabHref("wifi")).toBe("/network?tab=wifi");
    expect(networkTabHref("devices")).toBe("/network?tab=devices");
  });

  it("overview is the bare /network path (matches the page's own switcher)", () => {
    expect(networkTabHref("overview")).toBe("/network");
  });

  it("round-trips through parseNetworkTab for every tab", () => {
    for (const tab of NETWORK_TABS) {
      const raw = new URL(networkTabHref(tab), "http://droplet.local")
        .searchParams.get("tab");
      expect(parseNetworkTab(raw)).toBe(tab);
    }
  });
});
