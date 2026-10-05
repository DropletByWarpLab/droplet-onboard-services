/**
 * Direct WireGuard and internal DNS: local configs do not wait for fleet TLS,
 * and away configs require a configured direct endpoint.
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
  // WARP-1475: overlay QR-enroll fns the page now imports (owner view mounts
  // the pending-approval queue). Stub them so the wholesale api mock stays complete.
  mintOverlayLinkToken: () => Promise.resolve({ token: "t", server: "s", box_name: "b", expires_at: "2026-07-21T00:00:00.000Z" }),
  fetchPendingOverlayEnrollments: () => Promise.resolve([]),
  approveOverlayEnrollment: () => Promise.resolve({ state: "approved", device_id: null }),
  denyOverlayEnrollment: () => Promise.resolve({ state: "denied" }),
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
    publicFqdn: null,
    internalHostname: "droplet-ai.lan",
    overlayEnrollmentAvailable: false,
    // WARP-1391: a configured box has discovered its home LAN IP, so the
    // "Add device" affordance (a HOME-mode mint) is enabled.
    homeEndpointHost: "192.168.1.87",
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
    // Wait for the locally provisioned DNS name.
    await screen.findByText("https://droplet-ai.lan");

    expect(screen.queryAllByText(/from anywhere/i)).toHaveLength(0);
    expect(screen.queryAllByText(/office and away/i)).toHaveLength(0);
    expect(screen.queryAllByText(/coming soon|secure relay|still setting up its web address/i)).toHaveLength(0);
    expect(screen.getByText("WireGuard endpoint needs configuration")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add device/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /link a device/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/devices waiting to link/i)).not.toBeInTheDocument();
    // The "Away from the office" stat no longer instructs a dead-end Connect tap.
    expect(
      screen.queryAllByText(/turn on connect in the app/i),
    ).toHaveLength(0);
  });

  it("treats a missing offLanReachable field as false (honest default)", async () => {
    fetchVpnStatusMock.mockResolvedValue(statusFixture());
    render(<RemoteAccessPage />);
    await screen.findByText("https://droplet-ai.lan");

    expect(screen.queryAllByText(/from anywhere/i)).toHaveLength(0);
    expect(screen.getByText("WireGuard endpoint needs configuration")).toBeInTheDocument();
  });

  it("shows configured direct WireGuard away access", async () => {
    fetchVpnStatusMock.mockResolvedValue(
      statusFixture({ offLanReachable: true }),
    );
    render(<RemoteAccessPage />);
    await screen.findByText("https://droplet-ai.lan");

    expect(screen.getByText("Direct WireGuard endpoint configured")).toBeInTheDocument();
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0);
    expect(screen.queryAllByText(/turn on connect in the app/i)).toHaveLength(0);
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
    await screen.findByText("https://droplet-ai.lan");

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
    expect(screen.queryAllByText(/coming soon|secure relay/i)).toHaveLength(0);
    expect(screen.getAllByText("https://droplet-ai.lan").length).toBeGreaterThan(1);
  });

  it("does not disable office minting on an older status response with no fleet endpoint", async () => {
    fetchVpnStatusMock.mockResolvedValue(statusFixture({ endpointConfigured: false }));
    render(<RemoteAccessPage />);
    await screen.findByText("https://droplet-ai.lan");
    expect(screen.getByRole("button", { name: /add device/i })).toBeEnabled();
    expect(screen.queryByText(/endpoint not ready yet/i)).not.toBeInTheDocument();
  });

  it("can mint an away config when a public direct endpoint is configured", async () => {
    fetchVpnStatusMock.mockResolvedValue(statusFixture({ offLanReachable: true }));
    createVpnPeerMock.mockResolvedValue({
      peer: { id: "p1", deviceLabel: "Laptop", status: "active" },
      conf: "DNS = 192.168.20.1\nEndpoint = vpn.example.com:51820\n",
      offLanReachable: true,
    });
    render(<RemoteAccessPage />);
    await screen.findByText("https://droplet-ai.lan");
    fireEvent.click(screen.getByRole("button", { name: /add device/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /connection/i }), { target: { value: "away" } });
    fireEvent.change(screen.getByPlaceholderText(/iphone/i), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));
    await screen.findByText(/scan to connect/i);
    expect(createVpnPeerMock).toHaveBeenCalledWith("Laptop", "away");
    expect(screen.getByText(/test this connection from cellular/i)).toBeInTheDocument();
  });

  it("shows a status failure and allows a refresh instead of offering an unverified mint", async () => {
    fetchVpnStatusMock.mockRejectedValueOnce(new Error("Status unavailable"));
    render(<RemoteAccessPage />);
    const refresh = await screen.findByRole("button", { name: /refresh remote access/i });
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(screen.getByRole("button", { name: /add device/i })).toBeDisabled();
    fetchVpnStatusMock.mockResolvedValue(statusFixture());
    fireEvent.click(refresh);
    await screen.findByText("https://droplet-ai.lan");
    expect(screen.getByRole("button", { name: /add device/i })).toBeEnabled();
  });
});
