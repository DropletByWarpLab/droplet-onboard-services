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

import { NetworkSimple } from "../NetworkSimple";
import { fetchApDevices } from "@/lib/api";
import type { NetworkOverview, InterfaceStatus } from "@/lib/types";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchApDevices: vi.fn() };
});

const apsMock = vi.mocked(fetchApDevices);

beforeEach(() => {
  apsMock.mockReset();
  // No coverage extenders — keeps the test focused on the internet/router hero.
  apsMock.mockResolvedValue({ aps: [] } as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

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
    render(<NetworkSimple overview={overview} onOpenAdvanced={() => {}} />);

    // The "Online" pill + "Connected" hero copy must show; "Offline" must not.
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
    // Router card reflects router reachability, not the absent WAN up-flag.
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Status unknown")).not.toBeInTheDocument();
  });

  it("a genuinely-down WAN (present:true, up:false) still reads Offline", () => {
    const overview = overviewWith({ up: false, present: true, proto: "dhcp" }, true);
    render(<NetworkSimple overview={overview} onOpenAdvanced={() => {}} />);

    // "Offline" shows in both the hero status line and the pill.
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
    expect(screen.queryByText("Online")).not.toBeInTheDocument();
  });

  it("a healthy WAN (present:true, up:true) reads Online", () => {
    const overview = overviewWith(
      { up: true, present: true, proto: "dhcp", "ipv4-address": [{ address: "203.0.113.5", mask: 24 }] },
      true,
    );
    render(<NetworkSimple overview={overview} onOpenAdvanced={() => {}} />);

    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
  });
});
