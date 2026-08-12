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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
import { ToastProvider } from "@/components/Toast";

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
    // `mode` is the reach-the-box axis ("away" | "home", CHECK-constrained in
    // schema.prisma); "overlay" is the `kind` value on the line below. An
    // overlay row is written with OVERLAY_PEER_MODE = "away".
    mode: "away",
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

/**
 * The revoke that only half-happened (WARP-1763 review).
 *
 * Routing answers `DELETE /vpn/peers` with 200 + `applied: false` when its
 * `uci.apply` fails: the peer is out of the config, still live on wg0. The
 * orchestrator now refuses to call that "revoked" and answers 502
 * REVOKE_STAGED instead. This surface is where the owner finds out — and the
 * one thing it must not do is flatten that into the generic "we couldn't
 * update remote access right now", which a person reads as "nothing happened,
 * the device is still linked but harmless" rather than "the phone you are
 * trying to cut off is still on your network".
 */
describe("Remote Access — a revoke the router staged but never applied", () => {
  function stagedRevokeError() {
    const err = new Error(
      "We removed this device from the router's configuration, but the change didn't take effect — the device is still connected. Try revoking it again in a moment.",
    ) as Error & { code?: string; status?: number };
    err.code = "REVOKE_STAGED";
    err.status = 502;
    return err;
  }

  async function revokeTheDevice() {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [overlayPeer()],
      liveStateAvailable: true,
    });
    render(
      <ToastProvider>
        <RemoteAccessPage />
      </ToastProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /revoke device alice's iphone/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
  }

  it("tells the owner the device is STILL CONNECTED, not a generic retry", async () => {
    deleteVpnPeerMock.mockRejectedValue(stagedRevokeError());

    await revokeTheDevice();

    expect(
      await screen.findByText(/still connected/i),
    ).toBeInTheDocument();
    // The generic vpn fallback would be the failure mode here.
    expect(
      screen.queryByText(/couldn't update remote access right now/i),
    ).toBeNull();
  });

  it("never claims the device was revoked, and keeps the retry in reach", async () => {
    deleteVpnPeerMock.mockRejectedValue(stagedRevokeError());

    await revokeTheDevice();

    await waitFor(() => expect(deleteVpnPeerMock).toHaveBeenCalled());
    expect(screen.queryByText(/^Revoked "Alice's iPhone"\.$/)).toBeNull();
    // The confirm dialog stays open on a rejected onConfirm, so the owner can
    // press Revoke again without hunting for the row. Losing this would leave
    // a still-connected device behind a closed dialog and a dismissed toast.
    expect(
      await screen.findByRole("button", { name: /^revoke$/i }),
    ).toBeInTheDocument();
  });

  it("still says 'Revoked' when the revoke really did apply", async () => {
    deleteVpnPeerMock.mockResolvedValue(undefined);

    await revokeTheDevice();

    expect(await screen.findByText(/^Revoked "Alice's iPhone"\.$/)).toBeInTheDocument();
  });
});
