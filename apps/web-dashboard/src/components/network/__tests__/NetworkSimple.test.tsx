/**
 * NetworkSimple — the Simple-mode "is the internet up?" glance for Home installs.
 *
 * Regression: on the single-box shape the WAN uplink is owned by the appliance
 * host, so the in-box OpenWrt reports the wan interface as `present:false`.
 * The view used to derive online/offline purely from `wan.up`, so a perfectly
 * healthy single-box (routerConnected:true) rendered a red "Offline" Internet
 * hero and a "Status unknown" router — the "router is offline even though the
 * network is set up" bug. Online status must honour the honest signals:
 *   • WAN present + up        → online
 *   • WAN present + down      → offline (a real uplink outage still surfaces)
 *   • WAN absent (single-box) → fall back to routerConnected
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactElement } from "react";

import { NetworkSimple } from "../NetworkSimple";
import { fetchApDevices } from "@/lib/api";
import type { NetworkOverview, InterfaceStatus } from "@/lib/types";
import {
  AP_WIFI_UP,
  CURRENT_WIFI_NONE,
  FAILED_READ_NOTICE,
  HOUSEHOLD_HEADLINE,
  ROUTER_FORM_SUBHEAD,
  currentWifi,
  findSkeleton,
  mockWifiEndpoints,
  type FetchMock,
} from "./wifi-source-fixtures";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchApDevices: vi.fn() };
});

const apsMock = vi.mocked(fetchApDevices);
let fetchMock: FetchMock;

beforeEach(() => {
  apsMock.mockReset();
  // No coverage extenders — keeps the test focused on the internet/router hero.
  apsMock.mockResolvedValue({ aps: [] } as never);
  // WARP-1733: Simple mode now mounts the household Wi-Fi control, whose
  // children run their real fetchers. Stub the global fetch (never let jsdom
  // reach the network) and leave the source unresolved by default, so the
  // hero/router assertions below meet only the calm placeholder.
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockWifiEndpoints(fetchMock, { current: "pending" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** A fresh SWR cache per render — the Wi-Fi reads must not bleed across tests. */
function renderSimple(ui: ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {ui}
    </SWRConfig>,
  );
}

function overviewWith(wan: InterfaceStatus, routerConnected: boolean): NetworkOverview {
  return {
    interfaces: {
      lan: { up: true, present: true, proto: "static" },
      wan,
    },
    wireless: {},
    system: { board: {}, resources: { uptime: 3600 } },
    connectedDeviceCount: 3,
    routerConnected,
  };
}

describe("NetworkSimple internet/router status", () => {
  it("single-box (wan present:false) with a reachable router reads Online, not Offline", () => {
    const overview = overviewWith({ up: false, present: false }, true);
    renderSimple(<NetworkSimple overview={overview} onOpenAdvanced={() => {}} />);

    // The "Online" pill + "Connected" hero copy must show; "Offline" must not.
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
    // Router card reflects router reachability, not the absent WAN up-flag.
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Status unknown")).not.toBeInTheDocument();
  });

  it("a genuinely-down WAN (present:true, up:false) still reads Offline", () => {
    const overview = overviewWith({ up: false, present: true, proto: "dhcp" }, true);
    renderSimple(<NetworkSimple overview={overview} onOpenAdvanced={() => {}} />);

    // "Offline" shows in both the hero status line and the pill.
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
    expect(screen.queryByText("Online")).not.toBeInTheDocument();
  });

  it("a healthy WAN (present:true, up:true) reads Online", () => {
    const overview = overviewWith(
      { up: true, present: true, proto: "dhcp", "ipv4-address": [{ address: "203.0.113.5", mask: 24 }] },
      true,
    );
    renderSimple(<NetworkSimple overview={overview} onOpenAdvanced={() => {}} />);

    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
  });
});

/**
 * WARP-1733 — Simple mode is the home persona's view (ADR-002), and it had no
 * Wi-Fi name/password control at all. Its only Wi-Fi element was a read-only
 * count ("N access points · auto-managed"); the sole route onward was the
 * "All network controls" button, so a household could change its Wi-Fi only by
 * first discovering the Simple/Advanced segmented control and then the right
 * tab inside it.
 *
 * The fix mounts the SAME HouseholdWifiCard the Wi-Fi tab uses — not a copy.
 * A second editable Wi-Fi surface is precisely the bug WARP-1723 removed, and
 * two surfaces would be free to disagree about which radio they write.
 */
describe("NetworkSimple household Wi-Fi control (WARP-1733)", () => {
  const overview = overviewWith(
    { up: true, present: true, proto: "dhcp" },
    true,
  );

  function renderWithSource(current: Parameters<typeof mockWifiEndpoints>[1]) {
    mockWifiEndpoints(fetchMock, current);
    return renderSimple(
      <NetworkSimple overview={overview} onOpenAdvanced={() => {}} />,
    );
  }

  // THE regression this ticket exists for: a real, editable Wi-Fi affordance
  // in Simple mode — reachable without discovering Advanced.
  it("offers a real editable Wi-Fi affordance without a trip through Advanced", async () => {
    const onOpenAdvanced = vi.fn();
    mockWifiEndpoints(fetchMock, { current: currentWifi({ source: "router" }) });
    renderSimple(
      <NetworkSimple overview={overview} onOpenAdvanced={onOpenAdvanced} />,
    );

    // An editable network name, an editable password, and a way to save —
    // present on first paint of Simple mode, not behind another click.
    const ssid = await screen.findByLabelText("Network name (SSID)");
    expect(ssid).toBeInTheDocument();
    expect(ssid).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /save wi-fi settings/i }),
    ).toBeInTheDocument();
    // Nothing had to open Advanced to get here.
    expect(onOpenAdvanced).not.toHaveBeenCalled();
  });

  // Discoverability is the whole point: the control sits with the everyday
  // glance (right after the Internet hero), not below the escape hatch to
  // Advanced, which would reproduce the complaint one scroll lower.
  it("puts the Wi-Fi control above the escape hatch to Advanced", async () => {
    renderWithSource({ current: currentWifi({ source: "router" }) });

    const wifi = await screen.findByText(HOUSEHOLD_HEADLINE);
    const internet = screen.getByText("Internet");
    const advanced = screen.getByRole("button", {
      name: /all network controls/i,
    });
    expect(
      internet.compareDocumentPosition(wifi) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(
      wifi.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  it('source "ap" (edge-router shape): the AP form is the one that renders', async () => {
    renderWithSource({
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
    });

    const ssid = await screen.findByLabelText("Network name (SSID)");
    expect(ssid).toHaveAttribute("id", "ap-wifi-ssid");
    // The router form writes a radio that hosts nothing on this shape.
    expect(screen.queryByText(ROUTER_FORM_SUBHEAD)).not.toBeInTheDocument();
    expect(document.getElementById("wifi-ssid")).toBeNull();
    // ONE household control, never two.
    expect(screen.getAllByText(HOUSEHOLD_HEADLINE)).toHaveLength(1);
  });

  it('source "router": the router form is the one that renders', async () => {
    renderWithSource({
      current: currentWifi({ source: "router" }),
      apWifi: AP_WIFI_UP,
    });

    expect(await screen.findByText(ROUTER_FORM_SUBHEAD)).toBeInTheDocument();
    expect(document.getElementById("wifi-ssid")).not.toBeNull();
    // The AP's own second network belongs to the Wi-Fi tab, not to the
    // Simple-mode glance — Simple mode carries the household network only.
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
    expect(screen.getAllByText(HOUSEHOLD_HEADLINE)).toHaveLength(1);
  });

  it("source null (couldn't read): the form still renders, with its honest notice", async () => {
    renderWithSource({ current: CURRENT_WIFI_NONE });

    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(
      screen.getByText("We couldn't read the Wi-Fi configuration right now."),
    ).toBeInTheDocument();
  });

  it("while the source is unresolved: the calm placeholder, not an empty gap", async () => {
    renderWithSource({ current: "pending" });

    const skeleton = await findSkeleton();
    expect(skeleton.style.minHeight).toBe("300px");
    expect(screen.queryByText(HOUSEHOLD_HEADLINE)).not.toBeInTheDocument();
  });

  it("a FAILED source read keeps the form and says where it writes", async () => {
    renderWithSource({ current: "error" });

    expect(await screen.findByText(FAILED_READ_NOTICE)).toBeInTheDocument();
    expect(screen.getByText(ROUTER_FORM_SUBHEAD)).toBeInTheDocument();
  });

  // The read-only coverage count stays what it always was — a count. It is not
  // a Wi-Fi control and must not be mistaken for the fix.
  it("keeps the auto-managed coverage read-out alongside the new control", async () => {
    apsMock.mockResolvedValue({
      aps: [{ id: "ap1", status: "ONLINE" }],
    } as never);
    renderWithSource({ current: currentWifi({ source: "router" }) });

    expect(
      await screen.findByText(/wi-fi coverage · auto-managed/i),
    ).toBeInTheDocument();
  });
});

/**
 * WARP-1733 UX review — the two Simple-mode-only findings. Both are caused by
 * the new mount rather than by anything the Wi-Fi control does wrong: in
 * Advanced the card sat first inside a Wi-Fi-only tab panel, and here it is one
 * sibling card in a five-card column under a page `<h1>`.
 */
describe("NetworkSimple — WARP-1733 UX polish", () => {
  const overview = overviewWith({ up: true, present: true, proto: "dhcp" }, true);

  function renderWithSource(current: Parameters<typeof mockWifiEndpoints>[1]) {
    mockWifiEndpoints(fetchMock, current);
    return renderSimple(
      <NetworkSimple overview={overview} onOpenAdvanced={() => {}} />,
    );
  }

  /**
   * Item B. ShellPage renders `<h1>Network</h1>`, so this column reads
   * h1 → `<h2>Internet</h2>` → the Wi-Fi card. A hardcoded `h3` on that card
   * makes the heading tree claim the household Wi-Fi is a subsection of the
   * Internet hero. It is a sibling card, so it is an h2 here — while staying
   * h3 in the Advanced tab panel, where the subsection reading is correct.
   */
  it("mounts the household Wi-Fi card as a SIBLING of the Internet hero, not under it", async () => {
    renderWithSource({ current: currentWifi({ source: "router" }) });

    const wifi = await screen.findByRole("heading", {
      name: HOUSEHOLD_HEADLINE,
      level: 2,
    });
    const internet = screen.getByRole("heading", { name: "Internet", level: 2 });
    expect(wifi).toBeInTheDocument();
    expect(internet).toBeInTheDocument();
    // Nothing in Simple mode claims the Wi-Fi card is a subsection.
    expect(
      screen.queryByRole("heading", { name: HOUSEHOLD_HEADLINE, level: 3 }),
    ).not.toBeInTheDocument();
  });

  // …and on the edge-router shape, where the AP card IS the household form.
  it("levels the promoted AP form the same way", async () => {
    renderWithSource({
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
    });

    expect(
      await screen.findByRole("heading", {
        name: HOUSEHOLD_HEADLINE,
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: HOUSEHOLD_HEADLINE, level: 3 }),
    ).not.toBeInTheDocument();
  });

  /**
   * Item C. On the edge-router shape the Wi-Fi card says the household network
   * is "broadcast by your Droplet access point" (editable) while the card 16px
   * below says "N access points · auto-managed" (read-only) — so an owner asks
   * which of the two they just edited, and "auto-managed" flatly contradicts
   * the editable form above. The count is still worth showing; the colliding
   * noun is not. (The Wi-Fi card's own copy is WARP-1752, not this ticket.)
   */
  it("stops the coverage read-out from colliding with the Wi-Fi card's own noun", async () => {
    apsMock.mockResolvedValue({
      aps: [{ id: "ap1", status: "ONLINE" }],
    } as never);
    renderWithSource({
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
    });

    // The editable household form is present and still names where it writes.
    expect(
      await screen.findByText(/broadcast by your Droplet access point/i),
    ).toBeInTheDocument();
    // The read-only coverage line no longer answers to the same noun.
    expect(
      screen.queryByText(/access points? · auto-managed/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/wi-fi coverage · auto-managed/i),
    ).toBeInTheDocument();
  });

  it("keeps the count on the reworded coverage read-out", async () => {
    apsMock.mockResolvedValue({
      aps: [
        { id: "ap1", status: "ONLINE" },
        { id: "ap2", status: "ONLINE" },
      ],
    } as never);
    renderWithSource({ current: currentWifi({ source: "router" }) });

    const readout = await screen.findByText(/wi-fi coverage · auto-managed/i);
    // The number sits immediately above its label, as it always has.
    expect(readout.previousElementSibling?.textContent).toBe("2");
  });

  // No extenders at all: the whole read-out stays hidden, as before.
  it("hides the coverage read-out when there are no access points", async () => {
    apsMock.mockResolvedValue({ aps: [] } as never);
    renderWithSource({ current: currentWifi({ source: "router" }) });

    await screen.findByText(HOUSEHOLD_HEADLINE);
    expect(
      screen.queryByText(/wi-fi coverage · auto-managed/i),
    ).not.toBeInTheDocument();
  });
});
