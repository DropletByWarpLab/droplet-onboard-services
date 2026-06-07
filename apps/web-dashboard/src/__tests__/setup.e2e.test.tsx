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
const postClaimMock = vi.fn(async () => ({ claimed: true, next_step: "account" }));
const postOrgMock = vi.fn(async () => ({
  ok: true,
  slug: "acme",
  reserved_host: "droplet.local/acme",
  next_step: "internet",
}));
const setDuckDnsConfigMock = vi.fn();
const updateDriveLabelMock = vi.fn();
const acceptDiscoveredCameraMock = vi.fn();
const createVpnPeerMock = vi.fn();
const sendChatMock = vi.fn();
const postTeamInviteMock = vi.fn();

vi.mock("@/lib/api", () => ({
  // Forwarders use typed Parameters<typeof …> so spread inference passes
  // tsc --noEmit (the original `...args: unknown[]` form tripped TS2556
  // because the real signatures aren't variadic). Uncovered by WARP-482's
  // ship-check tsc-full; the actual mock surface is unchanged.
  setupAdmin: (...args: Parameters<typeof setupAdminMock>) =>
    setupAdminMock(...args),
  loginUser: (...args: Parameters<typeof loginUserMock>) =>
    loginUserMock(...args),
  // PR #372: the wizard persists each step transition via patchSetupStep.
  patchSetupStep: vi.fn(async () => undefined),

  // PR #373 — Claim step (welcome → claim → account). The forwarder lets the
  // e2e assert postClaim actually fired, matching the per-step API contract
  // this test enforces.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "PyPortal lid display", online: true },
    supply_chain: { taa_compliant: true, ndaa_889_clear: true, summary: "Verified" },
  })),
  postClaim: (...args: Parameters<typeof postClaimMock>) => postClaimMock(...args),

  // PR #380 — Org step (account → org → internet). Forwarder so the e2e can
  // assert postOrg actually fired with the workspace name + slug.
  postOrg: (...args: Parameters<typeof postOrgMock>) => postOrgMock(...args),

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

  // PR #381 — team slots after ai. The happy path invites one teammate.
  postTeamInvite: (...args: Parameters<typeof postTeamInviteMock>) =>
    postTeamInviteMock(...args),

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
    postOrgMock.mockClear();
    setDuckDnsConfigMock.mockClear();
    updateDriveLabelMock.mockClear();
    acceptDiscoveredCameraMock.mockClear();
    createVpnPeerMock.mockClear();
    sendChatMock.mockClear();
    postTeamInviteMock.mockClear();
    postTeamInviteMock.mockResolvedValue({
      ok: true,
      token: "tok-e2e",
      email: "romain@acme.co",
      role: "family",
      expires_at: "2026-06-04T00:00:00.000Z",
    });

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

  it("walks welcome → claim → account → org → internet → storage → discovery → cameras → vpn → ai → done with each step actually firing its API", async () => {
    render(<SetupPage />);

    // 1. Welcome → Get Started.
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    // 2. Claim → enter code + claim (PR #373; slots before account).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByPlaceholderText(/DRPL/i), {
      target: { value: "DRPL-7K2Q-9F4M" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /claim this droplet/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(postClaimMock).toHaveBeenCalledWith("DRPL-7K2Q-9F4M");

    // 3. Account → fill + submit.
    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "owner@warp.test" },
    });
    fireEvent.change(screen.getByPlaceholderText(/your name/i), {
      target: { value: "Robin" },
    });
    fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
      target: { value: "Abcdefghijk1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
      target: { value: "Abcdefghijk1" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /create account/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setupAdminMock).toHaveBeenCalledWith("owner@warp.test", "Abcdefghijk1", "Robin");
    expect(loginUserMock).toHaveBeenCalledWith("owner@warp.test", "Abcdefghijk1");

    // 3b. Org (PR #380) → name the workspace + reserve the slug → continue.
    // Org slots directly after account (account → org → twofactor → internet).
    fireEvent.change(screen.getByLabelText(/workspace name/i), {
      target: { value: "Acme HQ" },
    });
    fireEvent.change(screen.getByLabelText(/workspace url/i), {
      target: { value: "acme" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(postOrgMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme HQ", slug: "acme" }),
    );

    // 3c. PR #375 — TwoFactor step → skip (full TOTP flow lives in
    // TwoFactorStep.test.tsx; the e2e just needs to advance past it).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    // 4. Internet → save DuckDNS.
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

    // 4. Storage → name two drives + save. #5: 2+ drives default to pooling
    // ON; toggle it OFF to take the name-the-drives-separately path.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /storage pool/i }));
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
        screen.getByRole("button", { name: /^continue$/i }),
      );
    });

    // 8b. Team (PR #381) → invite one teammate → send invites & continue.
    expect(screen.getByText(/bring in your team/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/invite by email/i), {
      target: { value: "romain@acme.co" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(postTeamInviteMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: "romain@acme.co", role: "family" }),
    );
    expect(screen.getByText("romain@acme.co")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /send invites & continue/i }),
      );
    });

    // 9. Done → WelcomeFlourish.
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
    // Personalised — display name from account step survived.
    expect(screen.getByText(/welcome, robin/i)).toBeInTheDocument();
  });
});
