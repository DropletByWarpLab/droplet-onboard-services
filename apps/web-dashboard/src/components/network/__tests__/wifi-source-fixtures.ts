/**
 * Shared harness for the workspace-Wi-Fi source split (WARP-1723 → WARP-1733).
 *
 * WARP-1733 gives the workspace Wi-Fi control a second mount point (Simple
 * mode), so the same set of `/api/network/wifi/current` states now has to be
 * driven from three suites: WorkspaceWifiCard (the control itself), WifiTab
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
import { act, screen } from "@testing-library/react";
import { useSWRConfig } from "swr";
import type { ApWifiStatus } from "@/lib/api";
import type { CurrentWifi } from "@/lib/types";
import { CURRENT_WIFI_KEY } from "@/components/network/WifiSettingsForm";

export type FetchMock = ReturnType<typeof vi.fn>;

/**
 * The workspace slot's headline. BOTH branches present it — WifiSettingsForm
 * on the router shape, ApWifiCard's `slot="workspace"` variant on the
 * edge-router shape — which is intended: they never mount in that slot
 * simultaneously, and the Devices-tab link promises exactly this label.
 */
export const WORKSPACE_HEADLINE = "Wi-Fi settings";
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

export type CurrentWifiResponse = CurrentWifi | "pending" | "error";

/**
 * Drive every endpoint the Wi-Fi surfaces read.
 *
 * `current` takes the resolved body, or the two non-bodies that matter:
 *   - "pending" — the read never settles (SWR data stays undefined);
 *   - "error"   — the read FAILS (fetchCurrentWifi throws on !ok).
 *
 * `currentAfterFirst` is what the SECOND and later `/wifi/current` reads do,
 * when that differs from the first. The card polls this endpoint every 30s, so
 * "succeeded once, then a poll failed" is an ordinary steady state — and it is
 * the one the single-value form of this helper cannot express (see
 * `pollCurrentWifi`).
 */
export function mockWifiEndpoints(
  fetchMock: FetchMock,
  {
    current,
    apWifi = AP_WIFI_NONE,
    currentAfterFirst,
  }: {
    current: CurrentWifiResponse;
    apWifi?: ApWifiStatus;
    currentAfterFirst?: CurrentWifiResponse;
  },
): void {
  let currentReads = 0;
  fetchMock.mockImplementation((url: string) => {
    const path = String(url);
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (path.includes("/api/network/wifi/current")) {
      const answer =
        currentReads++ > 0 && currentAfterFirst !== undefined
          ? currentAfterFirst
          : current;
      if (answer === "pending") return new Promise(() => {});
      if (answer === "error")
        return Promise.resolve({ ok: false, status: 502, json: async () => ({}) });
      return json(answer);
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

/**
 * A handle on the enclosing <SWRConfig> cache's `mutate`, so a test can fire
 * the 30s poll's revalidation on demand.
 *
 * Why not fake timers: the cards under test also run `setTimeout`-driven status
 * transitions and RTL's async helpers, and advancing a 30s interval through all
 * of that is far more machinery than the one thing being asserted. `mutate(key)`
 * with no data performs exactly the same operation the interval performs — a
 * revalidation against the same key with the same fetcher — so it reproduces
 * the state faithfully and reads as what it is.
 *
 * Mount `<SwrRevalidateHandle handle={h} />` inside the SWRConfig, then await
 * `pollCurrentWifi(h)`.
 */
export type RevalidateHandle = { revalidate?: () => Promise<unknown> };

export function SwrRevalidateHandle({
  handle,
}: {
  handle: RevalidateHandle;
}): null {
  const { mutate } = useSWRConfig();
  handle.revalidate = () => mutate(CURRENT_WIFI_KEY);
  return null;
}

/**
 * Fire one `/api/network/wifi/current` poll and let the result settle.
 *
 * The rejection is swallowed deliberately: a failing poll is the scenario, and
 * SWR surfaces it to the component as `error` — `mutate` re-throwing it at the
 * caller is just the API's way of reporting the same thing twice.
 */
export async function pollCurrentWifi(handle: RevalidateHandle): Promise<void> {
  expect(handle.revalidate).toBeDefined();
  await act(async () => {
    await handle.revalidate!().catch(() => {});
  });
}

/** The placeholder card, reached through its live-region text. */
export async function findSkeleton(): Promise<HTMLElement> {
  const announcement = await screen.findByText(SKELETON_TEXT);
  const region = announcement.closest('[role="status"]');
  expect(region).not.toBeNull();
  return region as HTMLElement;
}
