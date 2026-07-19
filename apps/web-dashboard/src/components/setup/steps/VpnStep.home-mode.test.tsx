/**
 * WARP-1391 — VpnStep mints HOME mode, gated on homeEndpointHost.
 *
 * The interim remote-access fix (verified live on .87 2026-07-18): the one-tap
 * toggle POSTed a peer with no `mode`, so the orchestrator fell back to its
 * byte-identical compat default `away`, which bakes the split-horizon public
 * FQDN Endpoint — a public-NXDOMAIN address (WARP-954 / ADR-023) the stock
 * WireGuard app can't handshake. The peer showed keepalive but ZERO handshakes:
 * a silent dead config.
 *
 * The decided fix: user-facing surfaces mint `mode:"home"` (Endpoint = box LAN
 * IP, works today at home), gated on `homeEndpointHost` from GET /api/vpn/status.
 * When that field is null/absent a home mint would 503, so the step must NOT
 * attempt one — it shows the existing routing-unavailable guidance instead
 * (same established pattern as VpnStep.routing-unavailable.test.tsx / WARP-1283),
 * never over-promising (the WARP-993 offLanReachable convention).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VpnStep } from "./VpnStep";

const fetchVpnStatus = vi.fn();
const fetchVpnPeers = vi.fn();
const createVpnPeer = vi.fn();
const fetchBoxName = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchVpnStatus: (...a: unknown[]) => fetchVpnStatus(...a),
    fetchVpnPeers: (...a: unknown[]) => fetchVpnPeers(...a),
    createVpnPeer: (...a: unknown[]) => createVpnPeer(...a),
    fetchBoxName: (...a: unknown[]) => fetchBoxName(...a),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchBoxName.mockResolvedValue({ name: null, fqdn: null });
  createVpnPeer.mockResolvedValue({
    peer: {
      id: "p1",
      userId: "owner",
      deviceLabel: "This device",
      publicKey: "PUB=",
      assignedIp: "10.13.13.2",
      status: "active",
      createdAt: "now",
    },
    conf: "[Interface]\nPrivateKey=abc\n",
  });
});

const toggle = () =>
  screen.getByRole("switch", { name: /turn on remote access/i });

describe("VpnStep — home-mode mint (WARP-1391)", () => {
  it("mints HOME mode when the box has a discovered home endpoint", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "studio.droplet-us.com",
      homeEndpointHost: "192.168.1.87",
      peerCount: 0,
    });
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    fireEvent.click(toggle());

    // The load-bearing assertion at the component seam: the outbound payload is
    // home mode (the api-layer wire shape is proven in api.vpn-create-peer.test).
    await waitFor(() =>
      expect(createVpnPeer).toHaveBeenCalledWith("This device", "home"),
    );
    expect(await screen.findByTestId("vpn-qr-wrapper")).toBeInTheDocument();
  });

  it("does NOT attempt a mint when homeEndpointHost is absent — shows routing guidance", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "studio.droplet-us.com",
      // homeEndpointHost omitted → box hasn't discovered its home LAN IP; a home
      // mint would 503, so the toggle must not appear.
      peerCount: 0,
    });
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );

    // The established routing-unavailable guidance (WARP-1283), reused verbatim.
    expect(
      await screen.findByText(/network service isn.t responding right now/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/try again in a minute/i)).toBeInTheDocument();
    // No dead toggle, and critically no dead mint.
    expect(
      screen.queryByRole("switch", { name: /turn on remote access/i }),
    ).not.toBeInTheDocument();
    expect(createVpnPeer).not.toHaveBeenCalled();
    // Both recovery affordances stay.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skip for now/i })).toBeInTheDocument();
  });

  it("treats an explicit null homeEndpointHost as 'not reachable at home yet'", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "studio.droplet-us.com",
      homeEndpointHost: null,
      peerCount: 0,
    });
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    expect(
      await screen.findByText(/network service isn.t responding right now/i),
    ).toBeInTheDocument();
    expect(createVpnPeer).not.toHaveBeenCalled();
  });
});
