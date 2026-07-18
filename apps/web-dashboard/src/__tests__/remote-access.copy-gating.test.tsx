/**
 * WARP-993 — Remote Access page: honest away-from-home copy gating.
 *
 * With DROPLET_PUBLIC_FQDN set, the minted WireGuard conf's Endpoint is the
 * split-horizon FQDN (ADR-023 §3 — no public A record), so the tunnel only
 * works on the home LAN. Until the ADR-025 relay lands, the orchestrator
 * reports `offLanReachable: false` and every "from anywhere" promise on this
 * page must swap to honest home-network wording plus a low-key
 * "secure relay — coming soon" note. When `offLanReachable: true`
 * (public operator endpoint or relay mode) the full promise stays.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const fetchVpnStatusMock = vi.fn();
const fetchVpnPeersMock = vi.fn();
const createVpnPeerMock = vi.fn();
const deleteVpnPeerMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchVpnStatus: (...a: unknown[]) => fetchVpnStatusMock(...a),
  fetchVpnPeers: (...a: unknown[]) => fetchVpnPeersMock(...a),
  createVpnPeer: (...a: unknown[]) => createVpnPeerMock(...a),
  deleteVpnPeer: (...a: unknown[]) => deleteVpnPeerMock(...a),
  // ShellPage's status chip reads /api/orchestrator/health via this fetcher.
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: null,
    devices: [],
    health: null,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "alice",
      username: "alice",
      displayName: "Alice",
      role: "owner",
    },
  }),
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: () => null,
}));

import RemoteAccessPage from "@/app/remote-access/page";

function statusFixture(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    endpointConfigured: true,
    endpointHost: "casa.droplet-us.com",
    publicFqdn: "casa.droplet-us.com",
    listenPort: 51820,
    addresses: ["10.13.13.1/24"],
    serverPublicKey: "key12345abcdef",
    peerCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  fetchVpnStatusMock.mockReset();
  fetchVpnPeersMock.mockReset();
  createVpnPeerMock.mockReset();
  deleteVpnPeerMock.mockReset();
  fetchVpnPeersMock.mockResolvedValue({ peers: [] });
});

describe("Remote Access — honest away-from-home copy (WARP-993)", () => {
  it("swaps every 'from anywhere' promise for honest home-network wording when offLanReachable is false", async () => {
    fetchVpnStatusMock.mockResolvedValue(
      statusFixture({ offLanReachable: false }),
    );
    render(<RemoteAccessPage />);
    // Wait for status to land (the address card shows the FQDN).
    await screen.findByText("casa.droplet-us.com");

    expect(screen.queryAllByText(/from anywhere/i)).toHaveLength(0);
    expect(screen.queryAllByText(/office and away/i)).toHaveLength(0);
    // The low-key forward-looking note is present.
    expect(screen.queryAllByText(/coming soon/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/secure relay/i).length).toBeGreaterThan(0);
    // The "Away from the office" stat no longer instructs a dead-end Connect tap.
    expect(
      screen.queryAllByText(/turn on connect in the app/i),
    ).toHaveLength(0);
  });

  it("treats a missing offLanReachable field as false (honest default)", async () => {
    fetchVpnStatusMock.mockResolvedValue(statusFixture());
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    expect(screen.queryAllByText(/from anywhere/i)).toHaveLength(0);
    expect(screen.queryAllByText(/coming soon/i).length).toBeGreaterThan(0);
  });

  it("keeps the full promise when offLanReachable is true", async () => {
    fetchVpnStatusMock.mockResolvedValue(
      statusFixture({ offLanReachable: true }),
    );
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    expect(screen.queryAllByText(/from anywhere/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0);
    expect(
      screen.queryAllByText(/turn on connect in the app/i).length,
    ).toBeGreaterThan(0);
  });

  it("gates the Add-device QR step copy on offLanReachable", async () => {
    fetchVpnStatusMock.mockResolvedValue(
      statusFixture({ offLanReachable: false }),
    );
    createVpnPeerMock.mockResolvedValue({
      peer: {
        id: "p1",
        userId: "alice",
        deviceLabel: "Alice's iPhone",
        publicKey: "PUB=",
        assignedIp: "10.13.13.2",
        status: "active",
        createdAt: new Date().toISOString(),
      },
      conf: "[Interface]\nPrivateKey = priv\nAddress = 10.13.13.2/32\nDNS = 192.168.20.1\n",
      offLanReachable: false,
    });
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    fireEvent.click(screen.getByRole("button", { name: /add device/i }));
    fireEvent.change(await screen.findByPlaceholderText(/iphone/i), {
      target: { value: "Alice's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    // Ready step: install/scan instructions appear…
    await screen.findByText(/scan to connect/i);
    await waitFor(() =>
      expect(screen.queryAllByText(/wireguard/i).length).toBeGreaterThan(0),
    );
    // …but the copy stays honest.
    expect(screen.queryAllByText(/from anywhere/i)).toHaveLength(0);
    expect(screen.queryAllByText(/coming soon/i).length).toBeGreaterThan(0);
  });
});
