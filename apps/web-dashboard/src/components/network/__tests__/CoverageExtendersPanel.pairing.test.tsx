/**
 * CoverageExtendersPanel x DevicePairingCard (ADR-071 slice C): a discovered
 * Droplet-image AP whose own pairing window is open offers Pair next to Approve.
 * Vendor-managed APs and APs past approval never ask.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ApDeviceInfo } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "owner" } }) }));

vi.mock("@/lib/api", () => ({
  fetchApDevices: vi.fn(),
  approveApDevice: vi.fn(),
  decommissionApDevice: vi.fn(),
  fetchApWirelessDetail: vi.fn().mockResolvedValue({ supported: false, radios: [] }),
  fetchApWifi: vi.fn().mockResolvedValue({
    supported: false, ssid: null, fiveGhzSsid: null, key: null,
    encryption: null, bandSteering: null, apCount: 0, inSync: true,
  }),
  setApWifi: vi.fn(),
  fetchBandSteering: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
  setBandSteering: vi.fn(),
  fetchNetworkOperation: vi.fn(),
  confirmNetworkCommand: vi.fn(),
  fetchApPairing: vi.fn(),
  pairAp: vi.fn(),
  persistApPairing: vi.fn(),
}));

import { CoverageExtendersPanel } from "../CoverageExtendersPanel";
import { fetchApDevices, fetchApPairing } from "@/lib/api";

const ap = (over: Partial<ApDeviceInfo> = {}): ApDeviceInfo => ({
  mac: "B8:27:EB:00:00:01",
  displayName: "Upstairs",
  model: "Zyxel NWA50BE",
  serial: "ABC123",
  version: "1.0",
  lastIp: "192.168.9.42",
  hostname: "droplet-extender",
  status: "AWAITING_APPROVAL",
  backend: "DROPLET_IMAGE",
  vendor: null,
  failureReason: null,
  approvedSsid: null,
  firstSeen: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
  approvedAt: null,
  approvedBy: null,
  decommissionedAt: null,
  lastOperationId: null,
  ...over,
});

const openWindow = {
  available: true,
  state: "open",
  windowEndsAt: "2026-10-07T00:00:00Z",
  pairedBox: null,
  pairedElsewhere: false,
  pendingPersist: false,
  routerErrorCode: null,
  host: "192.168.9.42",
  model: null,
};

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CoverageExtendersPanel />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CoverageExtendersPanel pairing", () => {
  it("shows Pair next to Approve for a discovered AP whose window is open, naming its model", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({ aps: [ap()] });
    (fetchApPairing as ReturnType<typeof vi.fn>).mockResolvedValue(openWindow);
    renderPanel();
    expect(
      await screen.findByText(/Access point Zyxel NWA50BE at 192\.168\.9\.42 is ready to pair\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pair" })).toBeInTheDocument();
    // Approve is unchanged.
    expect(screen.getByRole("button", { name: /approve upstairs/i })).toBeInTheDocument();
    expect(fetchApPairing).toHaveBeenCalledWith("B8:27:EB:00:00:01");
  });

  it("offers nothing when the AP's window is closed", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({ aps: [ap()] });
    (fetchApPairing as ReturnType<typeof vi.fn>).mockResolvedValue({ ...openWindow, state: "closed" });
    renderPanel();
    expect(await screen.findByText("Upstairs")).toBeInTheDocument();
    await waitFor(() => expect(fetchApPairing).toHaveBeenCalled());
    expect(screen.queryByText(/ready to pair/)).toBeNull();
    expect(screen.getByRole("button", { name: /approve upstairs/i })).toBeInTheDocument();
  });

  it("never reads the pairing state of a vendor-managed AP", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [ap({ backend: "UNIFI", vendor: "Ubiquiti" })],
    });
    renderPanel();
    expect(await screen.findByText("Upstairs")).toBeInTheDocument();
    expect(fetchApPairing).not.toHaveBeenCalled();
  });

  it("never reads the pairing state of an AP that is already ONLINE", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({ aps: [ap({ status: "ONLINE" })] });
    renderPanel();
    expect(await screen.findByText("Upstairs")).toBeInTheDocument();
    expect(fetchApPairing).not.toHaveBeenCalled();
  });
});
