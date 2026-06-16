/**
 * WARP-807 (K3): when the router/routing service is unreachable, minting a
 * WireGuard peer returns 503 + code UNREACHABLE (via RouterStatusError on the
 * client). The VPN step must render the actionable message
 * ("Your router isn't reachable yet — you can finish this from Remote Access
 * later") instead of the raw error, and keep Skip available.
 *
 * UX review (droplet-ui-ux, CHANGES_REQUESTED): the destination for the VPN
 * surface is "Remote Access" (/remote-access owns WireGuard peers), NOT
 * Settings; and the soft notice must be announced (role="status").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VpnStep } from "./VpnStep";
import { RouterStatusError } from "@/lib/api";

const fetchVpnStatus = vi.fn();
const fetchVpnPeers = vi.fn();
const createVpnPeer = vi.fn();

vi.mock("@/lib/api", async () => {
  // Spread the real module so RouterStatusError + routerUnreachableNotice keep
  // their real behavior; only the network-IO functions are mocked.
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchVpnStatus: (...a: unknown[]) => fetchVpnStatus(...a),
    fetchVpnPeers: (...a: unknown[]) => fetchVpnPeers(...a),
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
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachForm();

    fireEvent.change(screen.getByPlaceholderText(/iPhone/i), {
      target: { value: "Stefan's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create config/i }));

    const notice = await screen.findByText(/router isn't reachable yet/i);
    expect(notice).toBeInTheDocument();
    // Per-surface copy: WireGuard peers live at /remote-access ("Remote
    // Access"), so that — not "Settings" — is the destination we name.
    expect(notice).toHaveTextContent(/finish this from\s+Remote Access later/i);
    expect(notice).not.toHaveTextContent(/Settings/i);
    expect(screen.queryByText(/fetch failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/internal server error/i)).not.toBeInTheDocument();
  });

  it("announces the soft notice to screen readers (role=status, aria-live=polite)", async () => {
    createVpnPeer.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "Create peer: fetch failed", 503),
    );
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachForm();

    fireEvent.change(screen.getByPlaceholderText(/iPhone/i), {
      target: { value: "Stefan's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create config/i }));
    await screen.findByText(/router isn't reachable yet/i);

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(/router isn't reachable yet/i);
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the Skip affordance available on an UNREACHABLE failure", async () => {
    createVpnPeer.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "Create peer: fetch failed", 503),
    );
    const onSkip = vi.fn();
    render(
      <VpnStep onComplete={vi.fn()} onSkip={onSkip} onBackToAddress={vi.fn()} />,
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
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachForm();

    fireEvent.change(screen.getByPlaceholderText(/iPhone/i), {
      target: { value: "Stefan's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create config/i }));

    expect(
      await screen.findByText(/device name already taken/i),
    ).toBeInTheDocument();
    // Urgent failure → role="alert".
    expect(screen.getByRole("alert")).toHaveTextContent(
      /device name already taken/i,
    );
    expect(
      screen.queryByText(/router isn't reachable yet/i),
    ).not.toBeInTheDocument();
  });
});

describe("VpnStep — precheck states (SETUP-WIZARD-SPEC §D)", () => {
  it("renders the blocked view with spec copy when no internet address is configured", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    const onBackToAddress = vi.fn();
    render(
      <VpnStep
        onComplete={vi.fn()}
        onSkip={vi.fn()}
        onBackToAddress={onBackToAddress}
      />,
    );

    expect(
      await screen.findByText(/remote access needs an internet address first/i),
    ).toBeInTheDocument();
    // "Set up internet address" is a render-only back-jump to the address step —
    // no redirect, no peer mint.
    fireEvent.click(
      screen.getByRole("button", { name: /set up internet address/i }),
    );
    expect(onBackToAddress).toHaveBeenCalledTimes(1);
    expect(createVpnPeer).not.toHaveBeenCalled();
  });

  it("renders the returning view (existing active peer) without re-minting; Continue advances", async () => {
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
        {
          id: "p0",
          userId: "owner",
          deviceLabel: "Old laptop",
          publicKey: "OLD=",
          assignedIp: "10.13.13.9",
          status: "revoked",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const onComplete = vi.fn();
    render(
      <VpnStep
        onComplete={onComplete}
        onSkip={vi.fn()}
        onBackToAddress={vi.fn()}
      />,
    );

    // Active peer is summarised; the revoked one is not listed.
    expect(await screen.findByText("Robin's Pixel")).toBeInTheDocument();
    expect(screen.queryByText("Old laptop")).not.toBeInTheDocument();
    expect(screen.getByText(/remote access is set up/i)).toBeInTheDocument();
    // Returning must never re-issue the one-shot key.
    expect(createVpnPeer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("'Add another device' from returning opens the create form, still no re-mint", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "x.duckdns.org",
      peerCount: 1,
    });
    fetchVpnPeers.mockResolvedValue({
      peers: [
        {
          id: "p1",
          userId: "o",
          deviceLabel: "Phone",
          publicKey: "P=",
          assignedIp: "10.13.13.2",
          status: "active",
          createdAt: "now",
        },
      ],
    });
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /add another device/i }),
    );
    expect(await screen.findByPlaceholderText(/iPhone/i)).toBeInTheDocument();
    expect(createVpnPeer).not.toHaveBeenCalled();
  });

  it("renders the error view with a retry when the status check fails; never auto-skips", async () => {
    fetchVpnStatus.mockReset();
    fetchVpnStatus.mockRejectedValue(new Error("network down"));
    const onSkip = vi.fn();
    render(
      <VpnStep onComplete={vi.fn()} onSkip={onSkip} onBackToAddress={vi.fn()} />,
    );

    expect(
      await screen.findByText(/couldn't check remote access/i),
    ).toBeInTheDocument();
    // Hard, must-act failure → assertive alert (not a polite status).
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onSkip).not.toHaveBeenCalled();
    expect(fetchVpnStatus).toHaveBeenCalledTimes(1);

    // "Try again" re-runs the precheck (no auto-advance, no auto-skip).
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(fetchVpnStatus).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
    expect(onSkip).not.toHaveBeenCalled();
  });
});
