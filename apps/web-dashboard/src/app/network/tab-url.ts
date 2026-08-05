// WARP-100 — URL ⟷ tab mapping for the Network page.
//
// The active tab lives in the URL (`/network?tab=schedules`) so deep-links,
// browser back/forward, and the cross-tab jump from DeviceDetailPanel all
// land on the right tab. Keeping the parse here (not inline in page.tsx)
// gives it a cheap unit test without mounting the hook-heavy page.

export type Tab =
  | "overview"
  | "privacy"
  | "devices"
  | "schedules"
  | "wifi"
  | "firewall"
  | "system";

export const NETWORK_TABS: readonly Tab[] = [
  "overview",
  "privacy",
  "devices",
  "schedules",
  "wifi",
  "firewall",
  "system",
] as const;

const VALID = new Set<string>(NETWORK_TABS);

// Map a raw `?tab=` value to a known tab, falling back to "overview" for
// missing/unknown values. Set membership (not `in`/lookup) avoids inherited
// keys like "toString" sneaking through as valid tabs.
export function parseNetworkTab(raw: string | null | undefined): Tab {
  return raw && VALID.has(raw) ? (raw as Tab) : "overview";
}

// WARP-1723 — the inverse mapping, for cross-tab links (e.g. the Coverage
// Extenders panel's "Change in Wi-Fi settings"). Mirrors the page's own tab
// switcher: "overview" is the bare /network path, everything else `?tab=`.
export function networkTabHref(tab: Tab): string {
  return tab === "overview" ? "/network" : `/network?tab=${tab}`;
}
