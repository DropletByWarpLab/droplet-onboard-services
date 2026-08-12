/**
 * WARP-1763 — an owner must be able to see and revoke a QR-linked device.
 *
 * The defect: `PeerRow` gated its revoke button on
 * `peer.userId === currentUser.username`. Overlay peers are written with the
 * synthetic `userId: "overlay"` (`OVERLAY_PEER_USER`), which matches no real
 * account, so the button could never render for exactly the devices the QR
 * link flow creates — while `DELETE /api/vpn/peers/:id` accepted the call
 * from any owner/admin the whole time. Against a hard cap of 20 approved QR
 * devices, a household could fill the cap with no in-product way out.
 *
 * The gate is now the role, matching what the API enforces. These tests pin
 * both directions, because "show the button to everyone" would be the equally
 * wrong fix: a family user pressing it gets a 403.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

const fetchVpnStatusMock = vi.fn();
const fetchVpnPeersMock = vi.fn();
const deleteVpnPeerMock = vi.fn();
const authUser: { current: { id: string; username: string; displayName: string; role: string } } = {
  current: { id: "alice", username: "alice", displayName: "Alice", role: "owner" },
};

vi.mock("@/lib/api", () => ({
  fetchVpnStatus: (...a: unknown[]) => fetchVpnStatusMock(...a),
  fetchVpnPeers: (...a: unknown[]) => fetchVpnPeersMock(...a),
  createVpnPeer: vi.fn(),
  deleteVpnPeer: (...a: unknown[]) => deleteVpnPeerMock(...a),
  mintOverlayLinkToken: () =>
    Promise.resolve({
      token: "t",
      server: "s",
      box_name: "b",
      expires_at: "2026-08-12T00:00:00.000Z",
    }),
  fetchPendingOverlayEnrollments: () => Promise.resolve([]),
  approveOverlayEnrollment: () =>
    Promise.resolve({ state: "approved", device_id: null }),
  denyOverlayEnrollment: () => Promise.resolve({ state: "denied" }),
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
  useAuth: () => ({ user: authUser.current }),
}));

vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));

import RemoteAccessPage from "@/app/remote-access/page";

/** A device linked by scanning the dashboard QR — the shape the approve path
 *  writes: synthetic userId, kind 'overlay', link-token provenance. */
function overlayPeer(over: Record<string, unknown> = {}) {
  return {
    id: "peer-overlay-1",
    userId: "overlay",
    deviceLabel: "Alice's iPhone",
    publicKey: "pk-overlay-1",
    assignedIp: "10.66.0.5",
    status: "active",
    mode: "overlay",
    kind: "overlay",
    createdAt: "2026-08-10T00:00:00.000Z",
    revokedAt: null,
    linkTokenLabel: "Alice's iPhone",
    linkTokenEnrolledBy: "alice",
    enrolledAt: "2026-08-10T00:00:00.000Z",
    provisioned: true,
    lastHandshakeAt: null,
    ...over,
  };
}

beforeEach(() => {
  fetchVpnStatusMock.mockReset();
  fetchVpnPeersMock.mockReset();
  deleteVpnPeerMock.mockReset();
  authUser.current = {
    id: "alice",
    username: "alice",
    displayName: "Alice",
    role: "owner",
  };
  fetchVpnStatusMock.mockResolvedValue({
    configured: true,
    endpointConfigured: true,
    endpointHost: "droplet.example",
    listenPort: 51820,
    addresses: ["10.66.0.0/24"],
    serverPublicKey: "key12345abcdef",
  });
});

describe("Remote Access — QR-linked device management (WARP-1763)", () => {
  it("renders revoke for a QR-linked device whose userId matches no account", async () => {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [overlayPeer()],
      liveStateAvailable: true,
    });

    render(<RemoteAccessPage />);

    expect(
      await screen.findByRole("button", {
        name: /revoke device alice's iphone/i,
      }),
    ).toBeInTheDocument();
  });

  it("marks it as a linked device and attributes it to the owner who approved it", async () => {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [overlayPeer()],
      liveStateAvailable: true,
    });

    render(<RemoteAccessPage />);

    expect(await screen.findByText("Linked device")).toBeInTheDocument();
    // Never the synthetic userId — "overlay" is an implementation detail and
    // means nothing to the person reading the row.
    expect(await screen.findByText(/linked by alice/i)).toBeInTheDocument();
    expect(screen.queryByText(/10\.66\.0\.5 · overlay$/)).toBeNull();
  });

  it("says 'not connected yet' for an approved device that has never handshaken", async () => {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [overlayPeer({ lastHandshakeAt: null })],
      liveStateAvailable: true,
    });

    render(<RemoteAccessPage />);

    expect(
      await screen.findByText(/linked · not connected yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Connected$/)).toBeNull();
  });

  it("says the status is unavailable when the interface could not be read", async () => {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [overlayPeer({ provisioned: undefined, lastHandshakeAt: undefined })],
      liveStateAvailable: false,
    });

    render(<RemoteAccessPage />);

    expect(
      await screen.findByText(/connection status unavailable/i),
    ).toBeInTheDocument();
  });

  it("points at re-approval when the peer never landed on the interface", async () => {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [overlayPeer({ provisioned: false, lastHandshakeAt: undefined })],
      liveStateAvailable: true,
    });

    render(<RemoteAccessPage />);

    expect(
      await screen.findByText(/setup didn’t finish — approve it again/i),
    ).toBeInTheDocument();
  });

  it("hides revoke from a family user, matching the API's owner/admin gate", async () => {
    authUser.current = {
      id: "bob",
      username: "bob",
      displayName: "Bob",
      role: "family",
    };
    fetchVpnPeersMock.mockResolvedValue({
      // A peer Bob owns. The old gate showed him a button the API would 403.
      peers: [
        overlayPeer({
          id: "peer-static-bob",
          userId: "bob",
          kind: "static",
          deviceLabel: "Bob's laptop",
          linkTokenEnrolledBy: null,
          enrolledAt: null,
        }),
      ],
      liveStateAvailable: true,
    });

    render(<RemoteAccessPage />);

    await waitFor(() =>
      expect(screen.getByText("Bob's laptop")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /revoke device/i })).toBeNull();
  });
});
