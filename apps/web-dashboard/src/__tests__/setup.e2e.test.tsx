/**
 * WARP-174 — Full wizard happy path.
 *
 * Walks a customer through every step end-to-end with realistic
 * (mocked) backend responses:
 *
 *   welcome → account → internet (save DuckDNS) →
 *   storage (rename two drives) → discovery (skip) →
 *   cameras (accept all) → vpn (mint peer, scan, continue) →
 *   ai (ask sample prompt, advance) → done
 *
 * Each step's individual test covers its branches; this one proves the
 * step-machine wiring doesn't drop state on the way through and the
 * cross-step values (displayName from account, endpoint from internet,
 * etc.) reach the right downstream call.
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

const setupAdminMock = vi.fn(async () => undefined);
const loginUserMock = vi.fn(async () => undefined);
const setDuckDnsConfigMock = vi.fn();
const updateDriveLabelMock = vi.fn();
const acceptDiscoveredCameraMock = vi.fn();
const createVpnPeerMock = vi.fn();
const sendChatMock = vi.fn();

vi.mock("@/lib/api", () => ({
  // Forwarders use typed Parameters<typeof …> so spread inference passes
  // tsc --noEmit (the original `...args: unknown[]` form tripped TS2556
  // because the real signatures aren't variadic). Uncovered by WARP-482's
  // ship-check tsc-full; the actual mock surface is unchanged.
  setupAdmin: (...args: Parameters<typeof setupAdminMock>) =>
    setupAdminMock(...args),
  loginUser: (...args: Parameters<typeof loginUserMock>) =>
    loginUserMock(...args),

  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: (opts: unknown) => setDuckDnsConfigMock(opts),

  fetchDrives: vi.fn(async () => ({
    drives: [
      {
        device: "/dev/sda1",
        mount: "/mnt/droplet/data",
        label: "TOSHIBA EXT",
        uuid: "UUID-A",
        size_bytes: 2_000_000_000_000,
        used_bytes: 0,
        free_bytes: 2_000_000_000_000,
        mounted: true,
        displayName: null,
        icon: null,
        notes: null,
      },
      {
        device: "/dev/sda2",
        mount: "/mnt/droplet/nvr",
        label: "WD ELEMENTS",
        uuid: "UUID-B",
        size_bytes: 1_000_000_000_000,
        used_bytes: 0,
        free_bytes: 1_000_000_000_000,
        mounted: true,
        displayName: null,
        icon: null,
        notes: null,
      },
    ],
    count: 2,
  })),
  updateDriveLabel: (uuid: string, patch: unknown) =>
    updateDriveLabelMock(uuid, patch),

  fetchDiscoveredCameras: vi.fn(async () => [
    {
      id: "cam-1",
      name: "hikvision-45",
      ip: "192.168.100.45",
      mac: "aa:bb:cc:dd:ee:01",
      manufacturer: "Hikvision",
      model: "DS-2CD2143G2",
      discoveredAt: "2026-05-14T12:00:00Z",
    },
  ]),
  acceptDiscoveredCamera: (id: string) => acceptDiscoveredCameraMock(id),

  // VPN endpoint configured — auto-derive landed in commit 4.
  fetchVpnStatus: vi.fn(async () => ({
    configured: true,
    endpointConfigured: true,
    endpointHost: "yourstudio.duckdns.org",
    listenPort: 51820,
    peerCount: 0,
    addresses: ["10.13.13.1/24"],
  })),
  createVpnPeer: (label: string) => createVpnPeerMock(label),

  fetchModels: vi.fn(async () => ({
    models: [
      {
        id: "llama3.1:8b-instruct-q8_0",
        provider: "ollama",
        name: "Llama 3.1 8B",
        context_window: 8192,
      },
    ],
  })),
  sendChat: (req: unknown) => sendChatMock(req),

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

describe("setup wizard E2E happy path (WARP-174)", () => {
  beforeEach(() => {
    setupAdminMock.mockClear();
    loginUserMock.mockClear();
    setDuckDnsConfigMock.mockClear();
    updateDriveLabelMock.mockClear();
    acceptDiscoveredCameraMock.mockClear();
    createVpnPeerMock.mockClear();
    sendChatMock.mockClear();

    setDuckDnsConfigMock.mockResolvedValue({
      configured: true,
      subdomain: "yourstudio",
      fullDomain: "yourstudio.duckdns.org",
      enabled: true,
      tokenSet: true,
    });
    updateDriveLabelMock.mockResolvedValue({
      uuid: "UUID-A",
      displayName: "Wedding Photos",
      icon: null,
      notes: null,
      createdAt: "now",
      updatedAt: "now",
    });
    acceptDiscoveredCameraMock.mockResolvedValue(undefined);
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
      conf: "[Interface]\nPrivateKey = secret\nAddress = 10.13.13.2/32\n",
    });
    sendChatMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: { role: "assistant", content: "I can help with your files." },
      }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("walks welcome → account → internet → storage → discovery → cameras → vpn → ai → done with each step actually firing its API", async () => {
    render(<SetupPage />);

    // 1. Welcome → Get Started.
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    // 2. Account → fill + submit.
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
      fireEvent.click(
        screen.getByRole("button", { name: /create account/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setupAdminMock).toHaveBeenCalledWith("owner", "longenoughpw", "Robin");
    expect(loginUserMock).toHaveBeenCalledWith("owner", "longenoughpw");

    // 3. Internet → save DuckDNS.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByPlaceholderText(/yourstudio/i), {
      target: { value: "yourstudio" },
    });
    fireEvent.change(screen.getByPlaceholderText(/paste your duckdns token/i), {
      target: { value: "duck-token-1234567" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setDuckDnsConfigMock).toHaveBeenCalledWith({
      subdomain: "yourstudio",
      token: "duck-token-1234567",
      enabled: true,
    });

    // 4. Storage → name two drives + save.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const driveInputs = screen.getAllByPlaceholderText(
      /e\.g\. wedding photos/i,
    );
    fireEvent.change(driveInputs[0], { target: { value: "Wedding Photos" } });
    fireEvent.change(driveInputs[1], { target: { value: "Camera Footage" } });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(updateDriveLabelMock).toHaveBeenCalledWith("UUID-A", {
      displayName: "Wedding Photos",
    });
    expect(updateDriveLabelMock).toHaveBeenCalledWith("UUID-B", {
      displayName: "Camera Footage",
    });

    // 5. Discovery → skip (Matter has nothing, fixture returns empty).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    // 6. Cameras → "Add this camera" (1 in the fixture).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /add this camera/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(acceptDiscoveredCameraMock).toHaveBeenCalledWith("cam-1");

    // 7. VPN → form (endpoint configured) → mint peer → continue.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByPlaceholderText(/stefan's iphone/i), {
      target: { value: "iPhone" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /create config/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createVpnPeerMock).toHaveBeenCalledWith("iPhone");
    // Ready phase visible.
    expect(screen.getByTestId("vpn-qr-wrapper")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /i'm connected — continue/i }),
      );
    });

    // 8. AI → ask sample prompt → continue.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendChatMock).toHaveBeenCalledTimes(1);
    expect(sendChatMock.mock.calls[0][0].model).toBe("llama3.1:8b-instruct-q8_0");
    expect(screen.getByTestId("ai-response")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /take me to the dashboard/i }),
      );
    });

    // 9. Done → WelcomeFlourish.
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
    // Personalised — display name from account step survived.
    expect(screen.getByText(/welcome, robin/i)).toBeInTheDocument();
  });
});
