/**
 * VpnStep — one-tap remote access (WARP-979) + the WARP-807 calm-error ladder.
 *
 * The PRIMARY entry (endpoint configured, no peer yet) is now a single
 * role="switch" toggle: flipping it on mints the first peer with an auto-derived
 * label and lands on the QR/.conf view. The advanced named-device form is kept
 * reachable ("Name a specific device instead" / "Add another device").
 *
 * WARP-807: when the router/routing service is unreachable, minting a peer
 * returns 503 + code UNREACHABLE (RouterStatusError on the client). The step
 * must render the actionable "finish from Remote Access later" notice
 * (role="status"), not the raw error, and keep Skip available.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VpnStep } from "./VpnStep";
import { RouterStatusError } from "@/lib/api";

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
  // Endpoint configured, no peer → land on the one-tap toggle.
  fetchVpnStatus.mockResolvedValue({
    configured: true,
    endpointConfigured: true,
    endpointHost: "yourstudio.duckdns.org",
    peerCount: 0,
  });
  // WARP-1039 — no saved name by default: the blocked precheck keeps its
  // pre-existing "set up internet address" back-jump baseline.
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

const toggle = () => screen.getByRole("switch", { name: /turn on remote access/i });

async function reachToggle() {
  await waitFor(() => expect(toggle()).toBeInTheDocument());
}

describe("VpnStep — one-tap remote access (WARP-979)", () => {
  it("lands on the one-tap toggle (not a form) when no peer exists", async () => {
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    // Ported one-tap copy is present.
    expect(
      screen.getByText(/one tap connects this device to your droplet/i),
    ).toBeInTheDocument();
    // The named-device form is NOT the primary surface.
    expect(screen.queryByPlaceholderText(/iPhone/i)).not.toBeInTheDocument();
  });

  it("mints a peer with an auto-derived label and shows the QR when toggled on", async () => {
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(toggle());

    await waitFor(() =>
      expect(createVpnPeer).toHaveBeenCalledWith("This device"),
    );
    // Lands on the created (QR) view.
    expect(await screen.findByTestId("vpn-qr-wrapper")).toBeInTheDocument();
  });

  it("keeps the advanced named-device form reachable from the toggle view", async () => {
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(
      screen.getByRole("button", { name: /name a specific device instead/i }),
    );
    // The advanced form appears with its device-name input.
    expect(await screen.findByPlaceholderText(/iPhone/i)).toBeInTheDocument();
    // No peer minted yet — the form path is opt-in.
    expect(createVpnPeer).not.toHaveBeenCalled();
  });

  it("allows Skip from the toggle view", async () => {
    const onSkip = vi.fn();
    render(
      <VpnStep onComplete={vi.fn()} onSkip={onSkip} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(screen.getByRole("button", { name: /i'll do this later/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe("VpnStep — honest away-from-home copy (WARP-993)", () => {
  // The default fixture omits offLanReachable — the honest default: the
  // split-horizon FQDN has no public A record (ADR-023 §3), so the minted
  // conf only works on the home LAN until the ADR-025 relay lands.

  it("does NOT promise 'from anywhere' on the toggle view when offLanReachable is absent/false", async () => {
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    expect(screen.queryAllByText(/from anywhere/i)).toHaveLength(0);
    // Low-key forward-looking note instead.
    expect(screen.queryAllByText(/coming soon/i).length).toBeGreaterThan(0);
    // The one-tap headline copy still anchors the step.
    expect(
      screen.getByText(/one tap connects this device to your droplet/i),
    ).toBeInTheDocument();
  });

  it("keeps the full 'from anywhere' promise on the toggle view when offLanReachable is true", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "vpn.example.com",
      peerCount: 0,
      offLanReachable: true,
    });
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    expect(screen.queryAllByText(/from anywhere/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0);
  });

  it("gates the QR (created) view copy when offLanReachable is false", async () => {
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(toggle());
    expect(await screen.findByTestId("vpn-qr-wrapper")).toBeInTheDocument();

    expect(screen.queryAllByText(/from anywhere/i)).toHaveLength(0);
    // Don't send the customer to a coffee shop to "test" a dead endpoint.
    expect(screen.queryAllByText(/cellular/i)).toHaveLength(0);
    expect(screen.queryAllByText(/coming soon/i).length).toBeGreaterThan(0);
  });

  it("keeps the cellular test guidance on the created view when offLanReachable is true", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "vpn.example.com",
      peerCount: 0,
      offLanReachable: true,
    });
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(toggle());
    expect(await screen.findByTestId("vpn-qr-wrapper")).toBeInTheDocument();

    expect(screen.queryAllByText(/from anywhere/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/cellular/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0);
  });

  it("does not promise 'from anywhere' on the blocked view either", async () => {
    fetchVpnStatus.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    expect(
      await screen.findByText(/remote access needs an internet address first/i),
    ).toBeInTheDocument();
    expect(screen.queryAllByText(/from anywhere/i)).toHaveLength(0);
  });
});

describe("VpnStep — blocked precheck honesty when a name IS saved (WARP-1039)", () => {
  beforeEach(() => {
    fetchVpnStatus.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
  });

  it("renders the 'address is being set up' variant instead of the back-jump when a name is saved", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
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
      await screen.findByRole("heading", {
        name: /your address is being set up/i,
      }),
    ).toBeInTheDocument();
    // The saved fqdn is named so the customer knows exactly what's pending.
    expect(
      screen.getAllByText(/studio\.droplet-us\.com/i).length,
    ).toBeGreaterThan(0);
    // The honest copy: remote access finishes on its own — no bounce-back.
    expect(
      screen.getByText(/lights up automatically/i),
    ).toBeInTheDocument();
    // NO back-jump button: the customer already finished the Address step.
    expect(
      screen.queryByRole("button", { name: /set up internet address/i }),
    ).not.toBeInTheDocument();
    expect(onBackToAddress).not.toHaveBeenCalled();
    expect(createVpnPeer).not.toHaveBeenCalled();
  });

  it("Continue advances (onComplete) and Skip skips (onSkip) from the with-name blocked view", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    const onComplete = vi.fn();
    const onSkip = vi.fn();
    render(
      <VpnStep
        onComplete={onComplete}
        onSkip={onSkip}
        onBackToAddress={vi.fn()}
      />,
    );
    await screen.findByRole("heading", {
      name: /your address is being set up/i,
    });

    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing back-jump blocked view when NO name is saved", async () => {
    // Default fetchBoxName → { name: null } from beforeEach.
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    expect(
      await screen.findByText(/remote access needs an internet address first/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /set up internet address/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is being set up/i)).not.toBeInTheDocument();
  });

  it("falls back to the back-jump blocked view when the name read fails (best-effort)", async () => {
    fetchBoxName.mockRejectedValueOnce(new Error("network down"));
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    expect(
      await screen.findByText(/remote access needs an internet address first/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /set up internet address/i }),
    ).toBeInTheDocument();
  });
});

describe("VpnStep — router unreachable (WARP-807)", () => {
  it("renders the actionable notice (not the raw error) when the one-tap mint returns UNREACHABLE", async () => {
    createVpnPeer.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "Create peer: fetch failed", 503),
    );
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(toggle());

    const notice = await screen.findByText(/router isn't reachable yet/i);
    expect(notice).toHaveTextContent(/finish this from\s+Remote Access later/i);
    expect(notice).not.toHaveTextContent(/Settings/i);
    expect(screen.queryByText(/fetch failed/i)).not.toBeInTheDocument();
  });

  it("announces the soft notice to screen readers (role=status, aria-live=polite)", async () => {
    createVpnPeer.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "Create peer: fetch failed", 503),
    );
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(toggle());
    await screen.findByText(/router isn't reachable yet/i);

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(/router isn't reachable yet/i);
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("keeps Skip available on an UNREACHABLE failure", async () => {
    createVpnPeer.mockRejectedValueOnce(
      new RouterStatusError("UNREACHABLE", "Create peer: fetch failed", 503),
    );
    const onSkip = vi.fn();
    render(
      <VpnStep onComplete={vi.fn()} onSkip={onSkip} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(toggle());
    await screen.findByText(/router isn't reachable yet/i);

    fireEvent.click(screen.getByRole("button", { name: /i'll do this later/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("still surfaces the real message for an ordinary (non-router) failure", async () => {
    createVpnPeer.mockRejectedValueOnce(new Error("Device name already taken"));
    render(
      <VpnStep onComplete={vi.fn()} onSkip={vi.fn()} onBackToAddress={vi.fn()} />,
    );
    await reachToggle();
    fireEvent.click(toggle());

    expect(
      await screen.findByText(/device name already taken/i),
    ).toBeInTheDocument();
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

    expect(await screen.findByText("Robin's Pixel")).toBeInTheDocument();
    expect(screen.queryByText("Old laptop")).not.toBeInTheDocument();
    expect(screen.getByText(/remote access is set up/i)).toBeInTheDocument();
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
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onSkip).not.toHaveBeenCalled();
    expect(fetchVpnStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(fetchVpnStatus).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
    expect(onSkip).not.toHaveBeenCalled();
  });
});
