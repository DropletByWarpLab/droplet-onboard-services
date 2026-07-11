/**
 * WARP-1283 — VpnStep error-phase copy when the routing sidecar is down.
 *
 * The precheck's generic error copy ("This usually clears on its own") was
 * shown for EVERY status-fetch failure, including the known, recoverable case
 * where the box's routing service simply isn't reachable yet. The orchestrator
 * now answers that case with 503 + code ROUTING_UNAVAILABLE, and
 * `fetchVpnStatus` carries the code on the thrown error — so the error phase
 * can be honest: the box's network service isn't responding right now, try
 * again in a minute. Title, "Try again" and "Skip for now" are unchanged, and
 * an untyped failure keeps the pre-existing generic copy.
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

/** The error shape fetchVpnStatus throws for the orchestrator's typed 503. */
function routingUnavailableError(): Error {
  const e = new Error(
    "The box's network service isn't responding right now. Try again in a minute.",
  ) as Error & { code?: string; status?: number };
  e.code = "ROUTING_UNAVAILABLE";
  e.status = 503;
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchBoxName.mockResolvedValue({ name: null, fqdn: null });
});

describe("VpnStep — routing service unavailable (WARP-1283)", () => {
  it("renders the specific 'network service isn't responding' copy for code ROUTING_UNAVAILABLE", async () => {
    fetchVpnStatus.mockRejectedValue(routingUnavailableError());
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );

    // Title stays the same.
    expect(
      await screen.findByText(/couldn't check remote access/i),
    ).toBeInTheDocument();
    // The honest, specific subtitle + body (apostrophes are typographic).
    expect(
      screen.getByText(/network service isn.t responding right now/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/try again in a minute/i)).toBeInTheDocument();
    // NOT the potentially-false generic copy.
    expect(
      screen.queryByText(/this usually clears on its own/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/something went wrong reaching the box/i),
    ).not.toBeInTheDocument();
    // Both affordances stay.
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
  });

  it("keeps the pre-existing generic copy for an untyped failure", async () => {
    fetchVpnStatus.mockRejectedValue(new Error("network down"));
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );

    expect(
      await screen.findByText(/couldn't check remote access/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/something went wrong reaching the box/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/this usually clears on its own/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/network service isn.t responding/i),
    ).not.toBeInTheDocument();
  });

  it("recovers via Try again once the routing service is back (no stale copy)", async () => {
    fetchVpnStatus.mockRejectedValueOnce(routingUnavailableError());
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "vpn.example.com",
      peerCount: 0,
    });
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await screen.findByText(/network service isn.t responding right now/i);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: /turn on remote access/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/isn.t responding right now/i),
    ).not.toBeInTheDocument();
  });

  it("keeps Skip working from the routing-unavailable error view", async () => {
    fetchVpnStatus.mockRejectedValue(routingUnavailableError());
    const onSkip = vi.fn();
    render(
      <VpnStep onComplete={vi.fn()} onSkip={onSkip} onBackToAddress={vi.fn()} />,
    );
    await screen.findByText(/network service isn.t responding right now/i);

    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
