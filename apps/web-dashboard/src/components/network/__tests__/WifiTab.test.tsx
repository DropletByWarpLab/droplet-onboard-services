/**
 * WARP-1723 — ONE editable household Wi-Fi surface on Network → Wi-Fi.
 *
 * The tab used to render BOTH the router-radio form (WifiSettingsForm) and
 * the access-point form (ApWifiCard) unconditionally. On the edge-router
 * shape the router hosts no Wi-Fi at all — the household SSID lives only on
 * the approved AP — yet the router form sat in the primary slot, read the
 * AP's values off /api/network/wifi/current, and then SAVED through the
 * router write path: "applied" on screen, nothing changed in the air.
 *
 * This suite pins the split: the resolved `source` from
 * GET /api/network/wifi/current picks which form owns the household slot,
 * and the two editable forms only coexist when they are genuinely two
 * networks (source === "router" plus a separate approved AP).
 *
 * SchedulesTab-style harness: stub the global fetch and let every card's
 * real fetcher run, so the tab mounts exactly as it ships.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { WifiTab } from "../WifiTab";
import type { ApWifiStatus } from "@/lib/api";
import type { CurrentWifi } from "@/lib/types";

type FetchMock = ReturnType<typeof vi.fn>;

/**
 * The household slot's headline. BOTH branches present it — WifiSettingsForm
 * on the router shape, ApWifiCard's `slot="household"` variant on the
 * edge-router shape — which is intended: they never mount in that slot
 * simultaneously, and the Devices-tab link promises exactly this label.
 */
const HOUSEHOLD_HEADLINE = "Wi-Fi settings";
/** WifiSettingsForm's distinguishing line (the ROUTER write path). */
const ROUTER_FORM_SUBHEAD = /Name the Wi-Fi network your Droplet broadcasts/i;

/** A reachable, editable AP — what wifi/ap reports on the edge-router shape. */
const AP_WIFI_UP: ApWifiStatus = {
  supported: true,
  ssid: "Fotonia Home",
  fiveGhzSsid: null,
  key: "correct-horse-psk",
  encryption: "psk2",
  bandSteering: true,
  apCount: 1,
  inSync: true,
};

const AP_WIFI_NONE: ApWifiStatus = {
  supported: false,
  ssid: null,
  fiveGhzSsid: null,
  key: null,
  encryption: null,
  bandSteering: null,
  apCount: 0,
  inSync: true,
};

function currentWifi(overrides: Partial<CurrentWifi> = {}): CurrentWifi {
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

function renderTab() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WifiTab />
    </SWRConfig>,
  );
}

describe("WifiTab household Wi-Fi source split (WARP-1723)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockEndpoints({
    current,
    apWifi = AP_WIFI_NONE,
  }: {
    current: CurrentWifi | "pending" | "error";
    apWifi?: ApWifiStatus;
  }) {
    fetchMock.mockImplementation((url: string) => {
      const path = String(url);
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: async () => body });
      if (path.includes("/api/network/wifi/current")) {
        // "pending" = the read hasn't resolved yet — SWR data stays undefined.
        if (current === "pending") return new Promise(() => {});
        // "error" = the read FAILS (fetchCurrentWifi throws on !ok).
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
      if (path.includes("/api/network/wifi/radio"))
        return json({ supported: false });
      // Bare /api/network/wifi (WifiChannelCard) + phone-home + switch + rest.
      return json({});
    });
  }

  it('source "ap" (edge-router shape): the AP form IS the household form; the router form is gone', async () => {
    mockEndpoints({ current: currentWifi({ source: "ap" }), apWifi: AP_WIFI_UP });
    renderTab();

    // Exactly one household form, and it is the AP's — its input carries the
    // AP write path's id, not the router form's `wifi-ssid`.
    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.getAllByText(HOUSEHOLD_HEADLINE)).toHaveLength(1);
    const ssid = await screen.findByLabelText("Network name (SSID)");
    expect(ssid).toHaveAttribute("id", "ap-wifi-ssid");

    // The router-radio form must NOT render — its save path (POST
    // /api/network/wifi/ssid) writes to a radio that hosts nothing here.
    expect(screen.queryByText(ROUTER_FORM_SUBHEAD)).not.toBeInTheDocument();
    expect(document.getElementById("wifi-ssid")).toBeNull();
  });

  // UX blocker 1 (second pass): promoted into the household slot, the AP card
  // must stop wearing secondary-slot copy. "Access point Wi-Fi" / "the network
  // your COVERAGE EXTENDER broadcasts" reads as an accessory network, so a
  // household admin concludes their own Wi-Fi isn't editable here — and the
  // Devices-tab link's "Change in Wi-Fi settings" promise lands on no such
  // label. The household variant says whose network it is.
  it('source "ap": the promoted card wears household copy, not coverage-extender copy', async () => {
    mockEndpoints({ current: currentWifi({ source: "ap" }), apWifi: AP_WIFI_UP });
    renderTab();

    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
    // It still says WHERE the network is broadcast — honest about the restart.
    expect(
      screen.getByText(/the network your devices join/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/coverage extender/i)).not.toBeInTheDocument();
  });

  it('source "router": the router form owns the household slot and the AP card still renders below (two real networks)', async () => {
    mockEndpoints({
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

  it("source null (couldn't read): the router form renders alone — no redundant AP card beside its honest empty state", async () => {
    mockEndpoints({
      current: currentWifi({
        source: null,
        ssid: null,
        key: null,
        detail: "We couldn't read the Wi-Fi configuration right now.",
      }),
    });
    renderTab();

    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
  });

  it("while the source is unresolved: a single calm placeholder, never both editable forms", async () => {
    mockEndpoints({ current: "pending" });
    renderTab();

    expect(
      await screen.findByRole("status", { name: "Loading Wi-Fi settings" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(HOUSEHOLD_HEADLINE)).not.toBeInTheDocument();
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
  });

  // UX + QA (second pass), compounding live bug WARP-1726: the placeholder
  // measured ~168px and became a ~350px form, so the tab jumped under the
  // scroll clamp. It now reserves the form's height and carries real text
  // inside the live region — an empty region with only aria-label announces
  // inconsistently across screen readers.
  it("the placeholder reserves the form's height and announces with real text", async () => {
    mockEndpoints({ current: "pending" });
    renderTab();

    const skeleton = await screen.findByRole("status", {
      name: "Loading Wi-Fi settings",
    });
    expect(skeleton.style.minHeight).toBe("300px");
    // A live region whose only content is aria-label is unreliable — the
    // announcement must come from a real (visually hidden) text node.
    const srText = skeleton.querySelector(".sr-only");
    expect(srText).not.toBeNull();
    expect(srText?.textContent).toMatch(/loading wi-fi settings/i);
  });

  // QA note 1 (second pass): the ONE state whose failure mode is "the user can
  // never edit Wi-Fi again". A failed read must fall back to the router form —
  // exactly what rendered before the split — never a permanent skeleton.
  it("a FAILED source read falls back to the router form, never a stuck skeleton", async () => {
    mockEndpoints({ current: "error" });
    renderTab();

    expect(await screen.findByText(ROUTER_FORM_SUBHEAD)).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading Wi-Fi settings" }),
    ).not.toBeInTheDocument();
  });
});
