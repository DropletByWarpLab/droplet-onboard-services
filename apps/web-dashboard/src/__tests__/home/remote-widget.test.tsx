/**
 * RemoteAccessWidget (WARP-1351) — the one-tap Connect toggle on Home.
 *
 * Pins the ported WARP-979 contract: honest blocked state while the box has
 * no web address yet; one-tap mint with the auto-derived "This device" label
 * plus the one-shot QR dialog; and the confirm-gated off-flip that revokes
 * only the current user's own active peers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  VpnPeerCreatedInfo,
  VpnPeerInfo,
  VpnStatusInfo,
} from "@/lib/types";

const mockFetchVpnStatus = vi.fn();
const mockFetchVpnPeers = vi.fn();
const mockCreateVpnPeer = vi.fn();
const mockDeleteVpnPeer = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchVpnStatus: (...a: unknown[]) => mockFetchVpnStatus(...a),
  fetchVpnPeers: (...a: unknown[]) => mockFetchVpnPeers(...a),
  createVpnPeer: (...a: unknown[]) => mockCreateVpnPeer(...a),
  deleteVpnPeer: (...a: unknown[]) => mockDeleteVpnPeer(...a),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { username: "stefan" } }),
}));

import { RemoteAccessWidget } from "@/components/home/widgets";

const SIZE = { w: 4, h: 2 };

const READY: VpnStatusInfo = {
  configured: true,
  endpointConfigured: true,
  endpointHost: "warp-lab.droplet-us.com",
  publicFqdn: "warp-lab.droplet-us.com",
  // WARP-1391: the one-tap mint is HOME mode, so the switch is only live once
  // the box has discovered its home-facing LAN IP.
  homeEndpointHost: "192.168.1.87",
  listenPort: 51820,
  peerCount: 0,
};

const MY_PEER: VpnPeerInfo = {
  id: "p1",
  userId: "stefan",
  deviceLabel: "This device",
  publicKey: "pk1",
  assignedIp: "10.13.13.2",
  status: "active",
  createdAt: "2026-07-17T00:00:00.000Z",
};

const OTHERS_PEER: VpnPeerInfo = {
  ...MY_PEER,
  id: "p2",
  userId: "someone-else",
  deviceLabel: "Their phone",
  assignedIp: "10.13.13.3",
};

const CREATED: VpnPeerCreatedInfo = {
  peer: MY_PEER,
  conf: "[Interface]\nPrivateKey = secret\nDNS = 192.168.20.1\n[Peer]\nEndpoint = warp-lab.droplet-us.com:51820\n",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RemoteAccessWidget (WARP-1351)", () => {
  it("shows the honest blocked state while the box has no web address", async () => {
    mockFetchVpnStatus.mockResolvedValue({
      ...READY,
      endpointConfigured: false,
      publicFqdn: null,
      endpointHost: null,
    });

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() =>
      expect(screen.getByText(/web address not ready yet/i)).toBeInTheDocument(),
    );
    expect(sw).toHaveAttribute("aria-disabled", "true");

    // An inert switch must not mint.
    fireEvent.click(sw);
    expect(mockCreateVpnPeer).not.toHaveBeenCalled();
  });

  it("one tap mints the auto-derived 'This device' peer and shows the one-shot QR dialog", async () => {
    mockFetchVpnStatus.mockResolvedValue(READY);
    mockCreateVpnPeer.mockResolvedValue(CREATED);
    // After the mint, reload sees the new peer.
    mockFetchVpnStatus.mockResolvedValueOnce(READY).mockResolvedValue({
      ...READY,
      peerCount: 1,
    });
    mockFetchVpnPeers.mockResolvedValue({ peers: [MY_PEER] });

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() =>
      expect(screen.getByText(/off · tap to connect this device/i)).toBeInTheDocument(),
    );

    fireEvent.click(sw);
    await waitFor(() =>
      // WARP-1391: the one-tap mint sends HOME mode explicitly (Endpoint = box
      // LAN IP), not the away-mode default that bakes a dead public-NXDOMAIN
      // Endpoint.
      expect(mockCreateVpnPeer).toHaveBeenCalledWith("This device", "home"),
    );

    // The one-shot dialog: heading + private-key warning; switch reports on.
    await screen.findByText(/scan to connect/i);
    expect(screen.getByText(/the private key is shown once/i)).toBeInTheDocument();
    // WARP-993 honesty gate: no offLanReachable on the create response ⇒
    // never promise "from anywhere". WARP-1810: business build says "local
    // network", not "home network".
    expect(screen.getByText(/on your local network/i)).toBeInTheDocument();
    expect(screen.queryByText(/from anywhere/i)).not.toBeInTheDocument();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(
      screen.getByText(/on · 1 connected device$/i),
    ).toBeInTheDocument();
  });

  it("promises 'from anywhere' only when the create response says off-LAN is reachable", async () => {
    mockFetchVpnStatus.mockResolvedValue(READY);
    mockCreateVpnPeer.mockResolvedValue({ ...CREATED, offLanReachable: true });
    mockFetchVpnPeers.mockResolvedValue({ peers: [MY_PEER] });

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() =>
      expect(screen.getByText(/off · tap to connect this device/i)).toBeInTheDocument(),
    );
    fireEvent.click(sw);

    await screen.findByText(/scan to connect/i);
    expect(screen.getByText(/from anywhere/i)).toBeInTheDocument();
  });

  it("shows the secure address and reports on when active peers exist", async () => {
    mockFetchVpnStatus.mockResolvedValue({ ...READY, peerCount: 2 });
    mockFetchVpnPeers.mockResolvedValue({ peers: [MY_PEER, OTHERS_PEER] });

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText(/on · 2 connected devices/i)).toBeInTheDocument();
    expect(
      screen.getByText("https://warp-lab.droplet-us.com"),
    ).toBeInTheDocument();
  });

  it("off-flip is confirm-gated and revokes only the current user's own peers", async () => {
    mockFetchVpnStatus.mockResolvedValue({ ...READY, peerCount: 2 });
    mockFetchVpnPeers.mockResolvedValue({ peers: [MY_PEER, OTHERS_PEER] });
    mockDeleteVpnPeer.mockResolvedValue(undefined);

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));

    // Nothing revoked until the confirm.
    fireEvent.click(sw);
    expect(mockDeleteVpnPeer).not.toHaveBeenCalled();
    await screen.findByText(/turn off remote access\?/i);

    fireEvent.click(screen.getByRole("button", { name: /^turn off$/i }));
    await waitFor(() => expect(mockDeleteVpnPeer).toHaveBeenCalledTimes(1));
    expect(mockDeleteVpnPeer).toHaveBeenCalledWith("p1");
  });

  it("keeps the switch inert when only other members' devices are connected", async () => {
    mockFetchVpnStatus.mockResolvedValue({ ...READY, peerCount: 1 });
    mockFetchVpnPeers.mockResolvedValue({ peers: [OTHERS_PEER] });

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(sw).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(sw);
    expect(screen.queryByText(/turn off remote access\?/i)).not.toBeInTheDocument();
    expect(mockDeleteVpnPeer).not.toHaveBeenCalled();
  });

  it("surfaces a mint failure and rolls the switch back off", async () => {
    mockFetchVpnStatus.mockResolvedValue(READY);
    mockCreateVpnPeer.mockRejectedValue(new Error("boom"));

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() =>
      expect(screen.getByText(/off · tap to connect this device/i)).toBeInTheDocument(),
    );

    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
});

describe("RemoteAccessWidget — home-mode gate (WARP-1391)", () => {
  it("mints HOME mode on the wire when the box has a discovered home endpoint", async () => {
    mockFetchVpnStatus.mockResolvedValue(READY);
    mockCreateVpnPeer.mockResolvedValue(CREATED);
    mockFetchVpnPeers.mockResolvedValue({ peers: [MY_PEER] });

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() =>
      expect(screen.getByText(/off · tap to connect this device/i)).toBeInTheDocument(),
    );
    fireEvent.click(sw);

    // The component seam carries mode:"home"; the on-the-wire serialization of
    // that arg into the POST body is proven in lib/api.vpn-create-peer.test.ts
    // (real authFetch transport, per the WARP-1288 no-seam-mocked-dead-code
    // lesson).
    await waitFor(() =>
      expect(mockCreateVpnPeer).toHaveBeenCalledWith("This device", "home"),
    );
  });

  it("is inert and does NOT mint when homeEndpointHost is absent", async () => {
    // Endpoint IS configured, but the box hasn't discovered its home LAN IP yet
    // (field omitted) → a home mint would 503, so the switch must not fire one.
    mockFetchVpnStatus.mockResolvedValue({ ...READY, homeEndpointHost: undefined });

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() =>
      expect(screen.getByText(/local address not ready yet/i)).toBeInTheDocument(),
    );
    expect(sw).toHaveAttribute("aria-disabled", "true");
    // aria-describedby already points at the sub text, so SR users hear WHY.
    expect(sw).toHaveAttribute("aria-describedby", "w-remote-sub");

    fireEvent.click(sw);
    expect(mockCreateVpnPeer).not.toHaveBeenCalled();
  });

  it("treats an explicit null homeEndpointHost as 'not reachable at home yet'", async () => {
    mockFetchVpnStatus.mockResolvedValue({ ...READY, homeEndpointHost: null });

    render(<RemoteAccessWidget {...SIZE} />);

    const sw = await screen.findByRole("switch", { name: /^remote access$/i });
    await waitFor(() =>
      expect(screen.getByText(/local address not ready yet/i)).toBeInTheDocument(),
    );
    expect(sw).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(sw);
    expect(mockCreateVpnPeer).not.toHaveBeenCalled();
  });
});
