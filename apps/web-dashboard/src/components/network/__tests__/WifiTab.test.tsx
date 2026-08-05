/**
 * WifiTab — the Advanced-mode Wi-Fi tab's COMPOSITION (WARP-1723 → WARP-1733).
 *
 * WARP-1723 gave the household Wi-Fi one editable surface, picked by where
 * that Wi-Fi actually lives, and this suite pinned the whole thing. WARP-1733
 * extracted the choice into HouseholdWifiCard so Simple mode can mount the
 * same control, and moved the five render-state tests (ap / router / null /
 * unresolved / failed read) to `HouseholdWifiCard.test.tsx`, where the
 * component that now owns them lives.
 *
 * What stays here is what the TAB owns and nothing else can prove:
 *   1. the household control occupies the tab's primary slot;
 *   2. the AP's OWN network appears as a second card only when it genuinely
 *      IS a second network (`source: "router"`, or a failed read that can't
 *      rule one out) — never on the edge-router shape, where that card has
 *      already been promoted into the household slot, and never while the
 *      source is still unresolved;
 *   3. the power-user cards below it survive the extraction.
 *
 * SchedulesTab-style harness (shared via ./wifi-source-fixtures): stub the
 * global fetch and let every card's real fetcher run, so the tab mounts
 * exactly as it ships.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { WifiTab } from "../WifiTab";
import {
  AP_WIFI_UP,
  CURRENT_WIFI_NONE,
  HOUSEHOLD_HEADLINE,
  ROUTER_FORM_SUBHEAD,
  SwrRevalidateHandle,
  currentWifi,
  findSkeleton,
  mockWifiEndpoints,
  pollCurrentWifi,
  type FetchMock,
  type RevalidateHandle,
} from "./wifi-source-fixtures";

function renderTab() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WifiTab />
    </SWRConfig>,
  );
}

describe("WifiTab household slot + second-network composition (WARP-1723)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('source "ap" (edge-router shape): one household form, and no second AP card beside it', async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
    });
    renderTab();

    // The household slot is filled by the AP's form (its input carries the AP
    // write path's id) — and that same card must not ALSO render below as the
    // "second network", which would be one AP shown as two.
    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.getAllByText(HOUSEHOLD_HEADLINE)).toHaveLength(1);
    expect(await screen.findByLabelText("Network name (SSID)")).toHaveAttribute(
      "id",
      "ap-wifi-ssid",
    );
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
    expect(screen.queryByText(ROUTER_FORM_SUBHEAD)).not.toBeInTheDocument();
  });

  it('source "router": the household form owns the primary slot and the AP card follows it (two real networks)', async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "router" }),
      apWifi: AP_WIFI_UP,
    });
    renderTab();

    const routerForm = await screen.findByText(HOUSEHOLD_HEADLINE);
    const apCard = await screen.findByText("Access point Wi-Fi");
    expect(routerForm).toBeInTheDocument();
    expect(apCard).toBeInTheDocument();
    // Only ONE card claims the household headline; the second network keeps
    // the secondary-slot copy verbatim.
    expect(screen.getAllByText(HOUSEHOLD_HEADLINE)).toHaveLength(1);
    expect(screen.getByText(/coverage extender/i)).toBeInTheDocument();
    // The household form keeps the primary slot; the AP card follows it.
    expect(
      routerForm.compareDocumentPosition(apCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  it("source null (couldn't read): no redundant AP card beside the form's honest empty state", async () => {
    mockWifiEndpoints(fetchMock, { current: CURRENT_WIFI_NONE });
    renderTab();

    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
  });

  it("while the source is unresolved: the placeholder holds the slot, and no AP card yet", async () => {
    mockWifiEndpoints(fetchMock, { current: "pending", apWifi: AP_WIFI_UP });
    renderTab();

    expect(await findSkeleton()).toBeInTheDocument();
    expect(screen.queryByText(HOUSEHOLD_HEADLINE)).not.toBeInTheDocument();
    // The second-network card is gated on a RESOLVED source: rendering it
    // beside the placeholder would assert "there are two networks" before
    // anything knows whether there is one.
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
  });

  // Review finding 4 (WARP-1723 third pass): the AP card is self-sufficient —
  // its own read, its own honesty states — so a transient wifi/current failure
  // must not take it away. Dropping it strands a router-shape household with a
  // real extender: the Devices panel is read-only since WARP-1723, so its
  // "Change in Wi-Fi settings" link would land on a tab that can't edit what
  // it promised.
  it("a FAILED source read keeps the AP card — its own read is independent", async () => {
    mockWifiEndpoints(fetchMock, { current: "error", apWifi: AP_WIFI_UP });
    renderTab();

    expect(await screen.findByText(ROUTER_FORM_SUBHEAD)).toBeInTheDocument();
    // Secondary-slot copy verbatim: nothing here resolved the household to the
    // AP, so this card must not claim the household slot.
    expect(await screen.findByText("Access point Wi-Fi")).toBeInTheDocument();
    expect(screen.getByText(/coverage extender/i)).toBeInTheDocument();
    // …and it is genuinely editable, which is the whole point of keeping it.
    expect(document.getElementById("ap-wifi-ssid")).not.toBeNull();
  });

  /**
   * The duplicate-editable-form state, reached by a poll rather than a read.
   *
   * The two gates disagreed about what a stale cache means. HouseholdWifiCard
   * reads `source` (still "ap" — the cached body survives) and promotes the AP
   * form into the household slot; this tab's second-card gate read `failedRead`
   * (true, because SWR raised `error` beside that surviving body) and rendered
   * the SAME AP card again as the "second network". Two editable forms for one
   * access point, on one SWR key, with a duplicate `#ap-wifi-ssid` id and two
   * contradictory titles — the exact invariant WARP-1723 established.
   *
   * The suite's other failed-read test starts from `current: "error"` with no
   * prior success, so `source` is null there and this branch is never reached.
   * The state needs a read that SUCCEEDS and then a poll that fails.
   */
  it('source "ap" then a FAILED poll: still one editable AP card, not two', async () => {
    const handle: RevalidateHandle = {};
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
      currentAfterFirst: "error",
    });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SwrRevalidateHandle handle={handle} />
        <WifiTab />
      </SWRConfig>,
    );

    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(await screen.findByLabelText("Network name (SSID)")).toHaveAttribute(
      "id",
      "ap-wifi-ssid",
    );

    // The 30s poll fails; the cached `source: "ap"` body survives it.
    await pollCurrentWifi(handle);

    // One AP form, so one `#ap-wifi-ssid` — a duplicate id would also break
    // every `<label for>` on the second copy.
    expect(screen.getAllByLabelText("Network name (SSID)")).toHaveLength(1);
    expect(document.querySelectorAll("#ap-wifi-ssid")).toHaveLength(1);
    // …and one story about that radio: the household's, not the household's
    // plus a "coverage extender" describing the same hardware.
    expect(screen.getAllByText(HOUSEHOLD_HEADLINE)).toHaveLength(1);
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
    expect(screen.queryByText(/coverage extender/i)).not.toBeInTheDocument();
  });

  /**
   * WARP-1733 UX review, item B. The household control now mounts in two
   * places whose heading trees differ, so its level travels from the mount.
   * HERE the h3 is CORRECT and must stay: inside the Wi-Fi tab panel the card
   * genuinely is a subsection, and every sibling card below it is an h3 too.
   * This is the regression guard on the Simple-mode fix — an h2 here would
   * misnest the whole tab.
   */
  it("keeps the household card at h3 — inside this panel it IS a subsection", async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "router" }),
      apWifi: AP_WIFI_UP,
    });
    renderTab();

    expect(
      await screen.findByRole("heading", {
        name: HOUSEHOLD_HEADLINE,
        level: 3,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: HOUSEHOLD_HEADLINE, level: 2 }),
    ).not.toBeInTheDocument();
    // The AP's own second network is a peer subsection, not a child of it.
    expect(
      screen.getByRole("heading", { name: "Access point Wi-Fi", level: 3 }),
    ).toBeInTheDocument();
  });

  it("keeps the promoted AP form at h3 on the edge-router shape too", async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
    });
    renderTab();

    expect(
      await screen.findByRole("heading", {
        name: HOUSEHOLD_HEADLINE,
        level: 3,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: HOUSEHOLD_HEADLINE, level: 2 }),
    ).not.toBeInTheDocument();
  });

  // The extraction moved one child out of this tab. Pin the rest, so a future
  // move can't quietly take a power-user card with it — none of these have a
  // render test of their own at the tab level.
  it("keeps its power-user cards below the household slot", async () => {
    mockWifiEndpoints(fetchMock, { current: currentWifi({ source: "router" }) });
    renderTab();

    const household = await screen.findByText(HOUSEHOLD_HEADLINE);
    for (const heading of [
      "WiFi channel",
      "Wireless radio",
      "Band steering",
      "Guest Wi-Fi",
      "Camera privacy",
      "Nearby Networks",
    ]) {
      const card = await screen.findByText(heading);
      expect(card).toBeInTheDocument();
      expect(
        household.compareDocumentPosition(card) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeGreaterThan(0);
    }
  });
});
