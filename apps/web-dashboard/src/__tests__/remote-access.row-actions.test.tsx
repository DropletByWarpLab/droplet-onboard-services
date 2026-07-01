/**
 * WARP-292 — Remote Access PeerRow revoke action.
 *
 * Mirror of the WARP-220 pattern. The revoke icon used to be hidden
 * behind `opacity-0 group-hover:opacity-100` — invisible on touch and
 * unreachable for keyboard-only users.
 *
 * Invariants:
 *   - Revoke is always rendered (no opacity-0 gate) for active peers
 *     the current user owns.
 *   - The button carries an aria-label naming the action AND the
 *     row's primary identifier (deviceLabel).
 *   - The design system's icon-button hit-target token (`k-iconbtn`,
 *     a fixed 30×30px area per droplet-shell.css — above the WCAG
 *     2.5.8 24px floor; replaced the old Tailwind `p-2.5`).
 *   - Clicking opens <ConfirmDialog> with deviceLabel in the title
 *     (preserved from WARP-291).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const fetchVpnStatusMock = vi.fn();
const fetchVpnPeersMock = vi.fn();
const createVpnPeerMock = vi.fn();
const deleteVpnPeerMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchVpnStatus: (...a: any[]) => fetchVpnStatusMock(...a),
  fetchVpnPeers: (...a: any[]) => fetchVpnPeersMock(...a),
  createVpnPeer: (...a: any[]) => createVpnPeerMock(...a),
  deleteVpnPeer: (...a: any[]) => deleteVpnPeerMock(...a),
  // ShellPage's status chip reads /api/orchestrator/health via this fetcher.
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

// ShellPage's status chip also calls useDevice (which would pull fetchDevices
// / fetchHealth off the api mock) — stub the hook like the other shell-page
// suites do.
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

// QRCodeSVG isn't relevant here; keep it light.
vi.mock("qrcode.react", () => ({
  QRCodeSVG: () => null,
}));

import RemoteAccessPage from "@/app/remote-access/page";

beforeEach(() => {
  fetchVpnStatusMock.mockReset();
  fetchVpnPeersMock.mockReset();
  createVpnPeerMock.mockReset();
  deleteVpnPeerMock.mockReset();
  fetchVpnStatusMock.mockResolvedValue({
    configured: true,
    endpointConfigured: true,
    endpointHost: "droplet.example",
    listenPort: 51820,
    addresses: ["10.10.0.0/24"],
    serverPublicKey: "key12345abcdef",
  });
});

describe("Remote Access — PeerRow revoke action (WARP-292)", () => {
  it("revoke button is visible without hover and carries deviceLabel in aria-label", async () => {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [
        {
          id: "peer-1",
          userId: "alice",
          deviceLabel: "Alice's iPhone",
          publicKey: "pk-1",
          assignedIp: "10.10.0.2",
          status: "active",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<RemoteAccessPage />);

    const revokeBtn = await screen.findByRole("button", {
      name: /revoke device alice's iphone/i,
    });
    expect(revokeBtn).toBeInTheDocument();
    expect(revokeBtn.className).not.toMatch(/opacity-0/);
    const container = revokeBtn.closest("div");
    expect(container?.className ?? "").not.toMatch(/opacity-0/);

    // Hit-target floor — the shell's 30×30px icon-button token.
    expect(revokeBtn.className).toMatch(/(^|\s)k-iconbtn(\s|$)/);
  });

  it("revoke aria-label falls back to peer id when deviceLabel is empty", async () => {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [
        {
          id: "peer-xyz",
          userId: "alice",
          deviceLabel: "",
          publicKey: "pk-2",
          assignedIp: "10.10.0.3",
          status: "active",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<RemoteAccessPage />);

    expect(
      await screen.findByRole("button", { name: /revoke device peer-xyz/i }),
    ).toBeInTheDocument();
  });

  it("clicking revoke opens ConfirmDialog whose title contains deviceLabel", async () => {
    fetchVpnPeersMock.mockResolvedValue({
      peers: [
        {
          id: "peer-3",
          userId: "alice",
          deviceLabel: "Romain's Pixel",
          publicKey: "pk-3",
          assignedIp: "10.10.0.4",
          status: "active",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<RemoteAccessPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /revoke device romain's pixel/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog").textContent ?? "").toMatch(/romain's pixel/i);
  });
});
