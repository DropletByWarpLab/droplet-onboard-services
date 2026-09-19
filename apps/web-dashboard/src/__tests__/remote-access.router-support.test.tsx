/**
 * WARP-2689 — Remote Access page: say so when the router cannot run WireGuard.
 *
 * `configured: true` only means the router holds a wg0 section. On a router
 * flashed without WireGuard the kernel device does not exist, no device added
 * here can ever connect, and until now the page rendered exactly like a
 * working one. The orchestrator now forwards the router's own observation as
 * `interfaceLive: false`; this pins that the page acts on it — and ONLY on a
 * strict false, because null/absent means "the router could not say".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

const fetchVpnStatusMock = vi.fn();
const fetchVpnPeersMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchVpnStatus: (...a: unknown[]) => fetchVpnStatusMock(...a),
  fetchVpnPeers: (...a: unknown[]) => fetchVpnPeersMock(...a),
  createVpnPeer: () => Promise.reject(new Error("not in this test")),
  deleteVpnPeer: () => Promise.reject(new Error("not in this test")),
  mintOverlayLinkToken: () => Promise.resolve({ token: "t", server: "s", box_name: "b", expires_at: "2026-07-21T00:00:00.000Z" }),
  fetchPendingOverlayEnrollments: () => Promise.resolve([]),
  approveOverlayEnrollment: () => Promise.resolve({ state: "approved", device_id: null }),
  denyOverlayEnrollment: () => Promise.resolve({ state: "denied" }),
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({ device: null, devices: [], health: null, isLoading: false, error: null }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "alice", username: "alice", displayName: "Alice", role: "owner" },
  }),
}));

vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));

import RemoteAccessPage from "@/app/remote-access/page";

function statusFixture(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    endpointConfigured: true,
    endpointHost: "casa.droplet-us.com",
    publicFqdn: "casa.droplet-us.com",
    homeEndpointHost: "192.168.9.195",
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
  fetchVpnPeersMock.mockResolvedValue({ peers: [] });
});

describe("Remote Access — router without WireGuard (WARP-2689)", () => {
  it("shows the router guidance and disables Add device when interfaceLive is false", async () => {
    fetchVpnStatusMock.mockResolvedValue(statusFixture({ interfaceLive: false, livePeerCount: null }));
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    expect(screen.getByText(/router can’t run remote access yet/i)).toBeInTheDocument();
    const add = screen.getByRole("button", { name: /add device/i });
    expect(add).toBeDisabled();
    // a11y: the disabled control points at the card that explains why.
    expect(add).toHaveAttribute("aria-describedby", "ra-router-guidance");
  });

  it("changes nothing when the router could not say (interfaceLive null)", async () => {
    fetchVpnStatusMock.mockResolvedValue(statusFixture({ interfaceLive: null }));
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    expect(screen.queryByText(/router can’t run remote access yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add device/i })).toBeEnabled();
  });

  it("changes nothing on an older orchestrator that omits the field", async () => {
    fetchVpnStatusMock.mockResolvedValue(statusFixture());
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    expect(screen.queryByText(/router can’t run remote access yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add device/i })).toBeEnabled();
  });
});
