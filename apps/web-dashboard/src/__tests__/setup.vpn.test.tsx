/**
 * WARP-174 — VPN step.
 *
 * Three observable states:
 *   - preCheck: endpoint not configured → "Internet step not finished"
 *     hint + "Back to internet setup" + "Skip for now" buttons.
 *   - form: endpoint OK → device-name input + "Create config" CTA.
 *   - ready: peer minted → QR + .conf actions + how-to-use list +
 *     "I'm connected — continue" CTA.
 *
 * Tests assert on DOM-visible strings + that createVpnPeer is/isn't
 * called per path. Mocks fetchVpnStatus + createVpnPeer at the module-
 * resolution layer (same pattern as the rest of the setup tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ completeSetup: vi.fn() }),
}));

const fetchVpnStatusMock = vi.fn();
const createVpnPeerMock = vi.fn();

vi.mock("@/lib/api", () => ({
  setupAdmin: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchVpnStatus: () => fetchVpnStatusMock(),
  createVpnPeer: (label: string) => createVpnPeerMock(label),
  // AI step is downstream — empty mock so its Skip link is always present.
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  fetchMatterDevices: vi.fn(async () => ({
    lights: [],
    switches: [],
    climate: [],
    sensors: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
  })),
}));

import SetupPage from "@/app/setup/page";

async function advanceToVpn() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  fireEvent.change(screen.getByPlaceholderText(/your-username/i), {
    target: { value: "owner" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/min\. 8 characters/i), {
    target: { value: "longenoughpw" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "longenoughpw" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // Internet → skip
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Storage auto-skip → Discovery → skip → Cameras auto-skip → VPN.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Let VpnStep's fetchVpnStatus effect resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup VPN step (WARP-174)", () => {
  beforeEach(() => {
    fetchVpnStatusMock.mockReset();
    createVpnPeerMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the preCheck view when endpoint isn't configured", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    render(<SetupPage />);
    await advanceToVpn();

    expect(
      screen.getByText(/internet step not finished/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /back to internet setup/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
    expect(createVpnPeerMock).not.toHaveBeenCalled();
  });

  it("Back to internet returns the customer to the Internet step", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    render(<SetupPage />);
    await advanceToVpn();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /back to internet setup/i }),
      );
    });

    // Internet step's title is back on screen.
    expect(
      screen.getByText(/connect to the internet/i),
    ).toBeInTheDocument();
  });

  it("Skip for now from preCheck advances to done", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    render(<SetupPage />);
    await advanceToVpn();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    // VPN finished → AI step. Skip it to reach Done.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
    expect(createVpnPeerMock).not.toHaveBeenCalled();
  });

  it("renders the device-name form when endpoint is configured", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "yourstudio.duckdns.org",
      listenPort: 51820,
      peerCount: 0,
      addresses: ["10.13.13.1/24"],
    });
    render(<SetupPage />);
    await advanceToVpn();

    expect(screen.getByText(/connect your phone/i)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/stefan's iphone/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create config/i }),
    ).toBeInTheDocument();
    // Endpoint host shown so the customer can sanity-check.
    expect(
      screen.getByText(/yourstudio\.duckdns\.org/),
    ).toBeInTheDocument();
  });

  it("Create config calls createVpnPeer with the device name + advances to ready", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "yourstudio.duckdns.org",
    });
    createVpnPeerMock.mockResolvedValue({
      peer: {
        id: "p1",
        userId: "owner",
        deviceLabel: "Stefan's iPhone",
        publicKey: "PUB=",
        assignedIp: "10.13.13.2",
        status: "active",
        createdAt: "2026-05-14T00:00:00Z",
      },
      conf: "[Interface]\nPrivateKey = secret\nAddress = 10.13.13.2/32\n",
    });
    render(<SetupPage />);
    await advanceToVpn();

    fireEvent.change(screen.getByPlaceholderText(/stefan's iphone/i), {
      target: { value: "Stefan's iPhone" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create config/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createVpnPeerMock).toHaveBeenCalledWith("Stefan's iPhone");
    // Ready phase: QR wrapper + how-to-use list.
    expect(screen.getByTestId("vpn-qr-wrapper")).toBeInTheDocument();
    expect(screen.getByText(/scan from qr code/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /i'm connected — continue/i }),
    ).toBeInTheDocument();
  });

  it("rejects empty device name without calling createVpnPeer", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
    });
    render(<SetupPage />);
    await advanceToVpn();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create config/i }));
      await Promise.resolve();
    });

    expect(screen.getByText(/give this device a name/i)).toBeInTheDocument();
    expect(createVpnPeerMock).not.toHaveBeenCalled();
  });

  it("'I'm connected — continue' from ready advances to done", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
    });
    createVpnPeerMock.mockResolvedValue({
      peer: {
        id: "p1",
        userId: "owner",
        deviceLabel: "iPhone",
        publicKey: "P=",
        assignedIp: "10.13.13.2",
        status: "active",
        createdAt: "now",
      },
      conf: "[Interface]\n",
    });
    render(<SetupPage />);
    await advanceToVpn();
    fireEvent.change(screen.getByPlaceholderText(/stefan's iphone/i), {
      target: { value: "iPhone" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create config/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /i'm connected — continue/i }),
      );
    });

    // VPN finished → AI step. Skip it to reach Done.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
  });
});
