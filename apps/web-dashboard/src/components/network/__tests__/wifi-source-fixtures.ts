/**
 * Shared harness for the household-Wi-Fi source split (WARP-1723 → WARP-1733).
 *
 * WARP-1733 gives the household Wi-Fi control a second mount point (Simple
 * mode), so the same set of `/api/network/wifi/current` states now has to be
 * driven from three suites: HouseholdWifiCard (the control itself), WifiTab
 * (the Advanced-mode composition around it), and NetworkSimple (the
 * Simple-mode mount). Copying the endpoint stub three ways would let the three
 * suites drift into testing three different backends — the thing that would
 * quietly hide a regression in one mount. One harness, three consumers.
 *
 * Not a `*.test.ts` file, so vitest's `include` (src/**\/*.test.{ts,tsx}) does
 * not collect it as a suite.
 *
 * SchedulesTab-style: stub the global fetch and let every card's real fetcher
 * run, so the components mount exactly as they ship.
 */
import { expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { ApWifiStatus } from "@/lib/api";
import type { CurrentWifi } from "@/lib/types";

export type FetchMock = ReturnType<typeof vi.fn>;

/**
 * The household slot's headline. BOTH branches present it — WifiSettingsForm
 * on the router shape, ApWifiCard's `slot="household"` variant on the
 * edge-router shape — which is intended: they never mount in that slot
 * simultaneously, and the Devices-tab link promises exactly this label.
 */
export const HOUSEHOLD_HEADLINE = "Wi-Fi settings";
/** WifiSettingsForm's distinguishing line (the ROUTER write path). */
export const ROUTER_FORM_SUBHEAD =
  /Name the Wi-Fi network your Droplet broadcasts/i;
/**
 * The placeholder's announcement. It is a real (visually hidden) TEXT NODE —
 * the region carried a duplicate `aria-label` with the same words, which risks
 * a double announcement in NVDA/JAWS, so the label is gone and the text stays.
 * Query by text accordingly; `getByRole("status", { name })` would now find
 * nothing, because role=status takes no accessible name from its contents.
 */
export const SKELETON_TEXT = /loading wi-fi settings/i;
/**
 * The failed-read notice. On the edge-router shape the form below it writes a
 * radio that hosts nothing, so a bare form there is a silent wrong-write
 * surface.
 */
export const FAILED_READ_NOTICE =
  /We couldn't read your current Wi-Fi settings just now/i;

/** A reachable, editable AP — what wifi/ap reports on the edge-router shape. */
export const AP_WIFI_UP: ApWifiStatus = {
  supported: true,
  ssid: "Fotonia Home",
  fiveGhzSsid: null,
  key: "correct-horse-psk",
  encryption: "psk2",
  bandSteering: true,
  apCount: 1,
  inSync: true,
};

export const AP_WIFI_NONE: ApWifiStatus = {
  supported: false,
  ssid: null,
  fiveGhzSsid: null,
  key: null,
  encryption: null,
  bandSteering: null,
  apCount: 0,
  inSync: true,
};

export function currentWifi(overrides: Partial<CurrentWifi> = {}): CurrentWifi {
  return {
    ssid: "Fotonia Home",
    key: "correct-horse-psk",
    source: "ap",
    detail: "",
    section: null,
    radio: null,
    ...overrides,
  };
}

/** The resolved `source: null` answer — "we asked, there's nothing". */
export const CURRENT_WIFI_NONE = currentWifi({
  source: null,
  ssid: null,
  key: null,
  detail: "We couldn't read the Wi-Fi configuration right now.",
});

/**
 * Drive every endpoint the Wi-Fi surfaces read.
 *
 * `current` takes the resolved body, or the two non-bodies that matter:
 *   - "pending" — the read never settles (SWR data stays undefined);
 *   - "error"   — the read FAILS (fetchCurrentWifi throws on !ok).
 */
export function mockWifiEndpoints(
  fetchMock: FetchMock,
  {
    current,
    apWifi = AP_WIFI_NONE,
  }: {
    current: CurrentWifi | "pending" | "error";
    apWifi?: ApWifiStatus;
  },
): void {
  fetchMock.mockImplementation((url: string) => {
    const path = String(url);
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (path.includes("/api/network/wifi/current")) {
      if (current === "pending") return new Promise(() => {});
      if (current === "error")
        return Promise.resolve({ ok: false, status: 502, json: async () => ({}) });
      return json(current);
    }
    if (path.includes("/api/network/wifi/ap")) return json(apWifi);
    if (path.includes("/api/network/wifi/band-steering"))
      return json({ supported: false, enabled: false });
    if (path.includes("/api/network/wifi/guest"))
      return json({
        configured: false,
        enabled: false,
        ssid: null,
        password: null,
        supported: false,
      });
    if (path.includes("/api/network/wifi/radio")) return json({ supported: false });
    if (path.includes("/api/aps")) return json({ aps: [] });
    // Bare /api/network/wifi (WifiChannelCard) + phone-home + switch + rest.
    return json({});
  });
}

/** The placeholder card, reached through its live-region text. */
export async function findSkeleton(): Promise<HTMLElement> {
  const announcement = await screen.findByText(SKELETON_TEXT);
  const region = announcement.closest('[role="status"]');
  expect(region).not.toBeNull();
  return region as HTMLElement;
}
