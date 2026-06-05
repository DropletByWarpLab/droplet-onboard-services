/**
 * WARP-807 (K3): when the router/routing service is unreachable, minting a
 * WireGuard peer returns 503 + code UNREACHABLE (via RouterStatusError on the
 * client). The VPN step must render the actionable message
 * ("Your router isn't reachable yet — you can finish this from Settings
 * later") instead of the raw error, and keep Skip available.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VpnStep } from "./VpnStep";
import { RouterStatusError } from "@/lib/api";

const fetchVpnStatus = vi.fn();
const createVpnPeer = vi.fn();

vi.mock("@/lib/api", async () => {
  // Spread the real module so RouterStatusError + routerUnreachableNotice keep
  // their real behavior; only the network-IO functions are mocked.
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchVpnStatus: (...a: unknown[]) => fetchVpnStatus(...a),
    createVpnPeer: (...a: unknown[]) => createVpnPeer(...a),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  // Endpoint configured → land directly on the device-name form.
  fetchVpnStatus.mockResolvedValue({
    endpointConfigured: true,
    endpointHost: "yourstudio.duckdns.org",
  });
});

async function reachForm() {
  await waitFor(() =>
    expect(screen.getByPlaceholderText(/iPhone/i)).toBeInTheDocument(),
  );
}

describe("VpnStep — router unreachable (WARP-807)", () => {
  it("renders an actionable message (not the raw error) when peer creation returns UNREACHABLE", async () => {
    createVpnPeer.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "Create peer: fetch failed", 503),
    );
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToInternet={vi.fn()} />,
    );
    await reachForm();

    fireEvent.change(screen.getByPlaceholderText(/iPhone/i), {
      target: { value: "Stefan's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create config/i }));

    expect(
      await screen.findByText(/router isn't reachable yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/fetch failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/internal server error/i)).not.toBeInTheDocument();
  });

  it("keeps the Skip affordance available on an UNREACHABLE failure", async () => {
    createVpnPeer.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "Create peer: fetch failed", 503),
    );
    const onSkip = vi.fn();
    render(
      <VpnStep onComplete={vi.fn()} onSkip={onSkip} onBackToInternet={vi.fn()} />,
    );
    await reachForm();

    fireEvent.change(screen.getByPlaceholderText(/iPhone/i), {
      target: { value: "Stefan's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create config/i }));
    await screen.findByText(/router isn't reachable yet/i);

    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("still surfaces the real message for an ordinary (non-router) failure", async () => {
    createVpnPeer.mockRejectedValueOnce(new Error("Device name already taken"));
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToInternet={vi.fn()} />,
    );
    await reachForm();

    fireEvent.change(screen.getByPlaceholderText(/iPhone/i), {
      target: { value: "Stefan's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create config/i }));

    expect(
      await screen.findByText(/device name already taken/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/router isn't reachable yet/i),
    ).not.toBeInTheDocument();
  });
});
