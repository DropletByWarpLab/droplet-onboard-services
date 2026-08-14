/**
 * WARP-1712 — an access point appears ONCE, as infrastructure.
 *
 * Our own flashed AP takes a DHCP lease like anything else, so the reconciler
 * creates a NetworkDevice row for it. Rendering that row in the devices grid
 * would put the same hardware in two places, where an operator can rename it
 * in one and be confused by the other.
 *
 * The dedupe itself is server-side (`listDevices` filters DROPLET_IMAGE AP
 * MACs — pinned in orchestrator's network-device.service.test.ts). What THIS
 * suite pins is the dashboard's half of the contract:
 *
 *   * the Devices tab renders exactly what `/api/network/devices` returns and
 *     never re-adds AP rows from the extenders data on its own; and
 *   * the AP does show up — as a Coverage Extender, tagged as Droplet
 *     infrastructure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";

const AP_MAC = "B8:27:EB:00:00:01";

const useNetworkDevicesMock = vi.fn();
const useNetworkGroupsMock = vi.fn();

vi.mock("@/lib/hooks/useNetworkDevices", () => ({
  useNetworkDevices: (...a: any[]) => useNetworkDevicesMock(...a),
}));
vi.mock("@/lib/hooks/useNetworkGroups", () => ({
  useNetworkGroups: (...a: any[]) => useNetworkGroupsMock(...a),
}));

vi.mock("@/lib/api", () => ({
  fetchApDevices: vi.fn(),
  approveApDevice: vi.fn(),
  decommissionApDevice: vi.fn(),
  fetchNetworkOperation: vi.fn(),
  fetchApWirelessDetail: vi.fn().mockResolvedValue({ supported: false, radios: [] }),
  fetchApWifi: vi.fn().mockResolvedValue({
    supported: false, ssid: null, fiveGhzSsid: null, key: null,
    encryption: null, bandSteering: null, apCount: 0, inSync: true,
  }),
  setApWifi: vi.fn(),
  fetchBandSteering: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
  setBandSteering: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

import { fetchApDevices } from "@/lib/api";
import { DevicesTab } from "@/components/network/DevicesTab";

const AP_ROW = {
  mac: AP_MAC,
  displayName: "Upstairs extender",
  model: "Zyxel NWA50BE",
  serial: null,
  version: "1.0",
  lastIp: "192.168.50.42",
  hostname: "droplet-ap",
  status: "ONLINE" as const,
  backend: "DROPLET_IMAGE" as const,
  vendor: null,
  failureReason: null,
  approvedSsid: "Droplet",
  firstSeen: new Date(Date.now() - 86_400_000).toISOString(),
  lastSeen: new Date().toISOString(),
  approvedAt: new Date(Date.now() - 3_600_000).toISOString(),
  approvedBy: "stefan",
  decommissionedAt: null,
  lastOperationId: null,
};

/** What the orchestrator returns once the dedupe has run: no AP row. */
const CLIENT_DEVICES = [
  {
    mac: "AA:BB:CC:DD:EE:10",
    displayName: "Living Room TV",
    hostname: "tv",
    vendor: "Samsung",
    lastIp: "192.168.1.5",
    groups: [],
    online: true,
    lastSeen: new Date().toISOString(),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  useNetworkDevicesMock.mockReturnValue({
    data: { devices: CLIENT_DEVICES },
    isLoading: false,
    mutate: vi.fn(),
  });
  useNetworkGroupsMock.mockReturnValue({ data: { groups: [] }, mutate: vi.fn() });
  (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({ aps: [AP_ROW] });
});

function renderTab() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DevicesTab />
    </SWRConfig>,
  );
}

describe("the AP appears once, as infrastructure", () => {
  it("shows the AP in Coverage extenders", async () => {
    renderTab();
    expect(await screen.findByText("Upstairs extender")).toBeInTheDocument();
  });

  it("does not also list the AP among the connected devices", async () => {
    renderTab();
    await screen.findByText("Upstairs extender");
    // Exactly one mention of the AP anywhere on the tab — the extender card.
    expect(screen.getAllByText("Upstairs extender")).toHaveLength(1);
    // And the tab never re-derives a device row from the extenders payload.
    expect(screen.queryByText("droplet-ap")).not.toBeInTheDocument();
    expect(screen.queryByText(AP_MAC)).not.toBeInTheDocument();
  });

  it("still lists genuine client devices", async () => {
    renderTab();
    expect(await screen.findByText("Living Room TV")).toBeInTheDocument();
  });

  it("keeps a third-party AP visible as a device when the server sends it", async () => {
    // The server-side dedupe is scoped to DROPLET_IMAGE — vendor-managed gear
    // stays in the grid so it can still be seen, grouped and blocked.
    useNetworkDevicesMock.mockReturnValue({
      data: {
        devices: [
          ...CLIENT_DEVICES,
          {
            mac: "AA:BB:CC:DD:EE:C1",
            displayName: "Ubiquiti AP",
            hostname: "unifi",
            vendor: "Ubiquiti",
            lastIp: "192.168.1.9",
            groups: [],
            online: true,
            lastSeen: new Date().toISOString(),
          },
        ],
      },
      isLoading: false,
      mutate: vi.fn(),
    });
    renderTab();
    expect(await screen.findByText("Ubiquiti AP")).toBeInTheDocument();
  });
});
