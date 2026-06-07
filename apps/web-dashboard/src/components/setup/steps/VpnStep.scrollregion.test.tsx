/**
 * WARP-820 / WARP-838 — the VPN step's "returning" peer list is unbounded (a box
 * can accumulate many WireGuard peers), so it lives in the shared <ScrollRegion>
 * — the wizard's single permitted inner-scroll surface. The title, the "Add
 * another device" button, and the Continue CTA stay pinned in the StepShell;
 * only the peer list scrolls, bounded to a viewport-relative max-height so the
 * shell never page-scrolls (the internal viewport lock).
 *
 * Structure assertion (jsdom can't measure scroll): the active peer renders
 * INSIDE the labelled "Connected devices" region, and that region carries the
 * bounded-scroll classes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const fetchVpnStatus = vi.fn();
const fetchVpnPeers = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchVpnStatus: (...a: unknown[]) => fetchVpnStatus(...a),
    fetchVpnPeers: (...a: unknown[]) => fetchVpnPeers(...a),
  };
});

import { VpnStep } from "./VpnStep";

beforeEach(() => {
  vi.clearAllMocks();
  // endpoint live + a peer already exists → the "returning" view.
  fetchVpnStatus.mockResolvedValue({
    configured: true,
    endpointConfigured: true,
    endpointHost: "yourstudio.duckdns.org",
    peerCount: 1,
  });
  fetchVpnPeers.mockResolvedValue({
    peers: [
      {
        id: "p1",
        userId: "owner",
        deviceLabel: "Robin's Pixel",
        publicKey: "PUB=",
        assignedIp: "10.13.13.2",
        status: "active",
        createdAt: "2026-05-14T00:00:00Z",
      },
    ],
  });
});

describe("VpnStep returning list in ScrollRegion (WARP-820)", () => {
  it("renders the existing peers inside a bounded, labelled scroll region", async () => {
    render(
      <VpnStep
        onComplete={() => {}}
        onSkip={() => {}}
        onBackToInternet={() => {}}
      />,
    );

    const region = await screen.findByRole("region", {
      name: /connected devices/i,
    });
    expect(within(region).getByText("Robin's Pixel")).toBeInTheDocument();
    // Viewport lock: scroll is confined to this region (not the shell), and the
    // bound is viewport-relative so it shrinks on a short viewport.
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toContain("overscroll-contain");
    expect(region.className).toMatch(/max-h-\[[^\]]*(vh|dvh|svh)\]/);
  });
});
