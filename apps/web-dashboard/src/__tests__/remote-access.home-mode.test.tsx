/**
 * WARP-1391 — Remote Access page mints HOME mode, gated on homeEndpointHost.
 *
 * Same interim fix as the wizard's VpnStep: the "Add device" dialog POSTed a
 * peer with no `mode`, so the orchestrator fell back to its byte-identical
 * compat default `away`, baking the split-horizon public FQDN Endpoint — a
 * public-NXDOMAIN address (WARP-954 / ADR-023) the stock WireGuard app can't
 * handshake. Silent dead config.
 *
 * The page now mints `mode:"home"` (Endpoint = box LAN IP, works today at home)
 * and gates the "Add device" affordance on `homeEndpointHost` from
 * GET /api/vpn/status. Missing/null ⇒ do not offer a mint (a home mint 503s);
 * mirror the existing endpoint-not-ready guidance instead. Never over-promise
 * (the WARP-993 offLanReachable convention).
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
    user: { id: "alice", username: "alice", displayName: "Alice", role: "owner" },
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
    homeEndpointHost: "192.168.1.87",
    listenPort: 51820,
    addresses: ["10.13.13.1/24"],
    serverPublicKey: "key12345abcdef",
    peerCount: 0,
    ...overrides,
  };
}

function createdPeer() {
  return {
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
  };
}

beforeEach(() => {
  fetchVpnStatusMock.mockReset();
  fetchVpnPeersMock.mockReset();
  createVpnPeerMock.mockReset();
  deleteVpnPeerMock.mockReset();
  fetchVpnPeersMock.mockResolvedValue({ peers: [] });
  createVpnPeerMock.mockResolvedValue(createdPeer());
});

describe("Remote Access — home-mode mint (WARP-1391)", () => {
  it("mints HOME mode from the Add-device dialog when the box has a home endpoint", async () => {
    fetchVpnStatusMock.mockResolvedValue(statusFixture());
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    const addBtn = screen.getByRole("button", { name: /add device/i });
    expect(addBtn).not.toBeDisabled();
    fireEvent.click(addBtn);
    fireEvent.change(await screen.findByPlaceholderText(/iphone/i), {
      target: { value: "Alice's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() =>
      expect(createVpnPeerMock).toHaveBeenCalledWith("Alice's iPhone", "home"),
    );
  });

  it("does NOT offer a mint when homeEndpointHost is absent — button disabled, guidance shown", async () => {
    fetchVpnStatusMock.mockResolvedValue(
      statusFixture({ homeEndpointHost: null }),
    );
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    // The Add-device affordance is gated off — a home mint would 503.
    expect(screen.getByRole("button", { name: /add device/i })).toBeDisabled();
    // Honest guidance that the box is still discovering its home address.
    expect(
      screen.getByText(/still setting up its (home )?(web )?address/i),
    ).toBeInTheDocument();
    expect(createVpnPeerMock).not.toHaveBeenCalled();
  });

  it("treats a missing homeEndpointHost field as 'not reachable at home yet'", async () => {
    const s = statusFixture();
    delete (s as Record<string, unknown>).homeEndpointHost;
    fetchVpnStatusMock.mockResolvedValue(s);
    render(<RemoteAccessPage />);
    await screen.findByText("casa.droplet-us.com");

    expect(screen.getByRole("button", { name: /add device/i })).toBeDisabled();
    expect(createVpnPeerMock).not.toHaveBeenCalled();
  });
});
