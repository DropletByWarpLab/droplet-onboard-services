/**
 * WARP-174 — VPN step (precheck states aligned to SETUP-WIZARD-SPEC §D).
 *
 * Render-only precheck states (the step never redirects):
 *   - blocked: endpoint not configured → "Remote access needs an internet
 *     address first" + "Set up internet address" + "Skip for now" buttons.
 *     (Onboarding-Flow redesign: the address is its own step now, so the
 *     precheck jumps back to `address`, not the old combined `internet` step.)
 *   - form: endpoint OK, no peer yet → device-name input + "Create config" CTA.
 *   - created: peer minted → QR + .conf actions + how-to-use list +
 *     "I'm connected — continue" CTA.
 *   - returning + error states have focused coverage in VpnStep.test.tsx.
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
  useAuth: () => ({ completeSetup: vi.fn(), setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false } }),
}));

const fetchVpnStatusMock = vi.fn();
const createVpnPeerMock = vi.fn();

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  // PR #373 — claim slots before account; the Claim step calls these.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "Front-panel display", online: true },
    supply_chain: { taa_compliant: true, ndaa_889_clear: true, summary: "Verified" },
  })),
  postClaim: vi.fn(async () => ({ claimed: true, next_step: "account" })),
  // PR #380 — org slots after account; the Org step calls postOrg.
  postOrg: vi.fn(async () => ({
    ok: true,
    slug: "acme",
    reserved_host: "droplet.local/acme",
    next_step: "internet",
  })),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchVpnStatus: () => fetchVpnStatusMock(),
  fetchVpnPeers: vi.fn(async () => ({ peers: [] })),
  createVpnPeer: (label: string) => createVpnPeerMock(label),
  // AI step is downstream — empty mock so its Skip link is always present.
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  // PR #381 — team slots after ai; TeamStep imports postTeamInvite.
  postTeamInvite: vi.fn(async () => ({
    ok: true, token: "tok", email: "x@acme.co", role: "family",
    expires_at: "2026-06-04T00:00:00.000Z",
  })),
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
import { passClaimStep } from "./helpers/claim-step";
import { passOrgStep } from "./helpers/org-step";

async function advanceToVpn() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  await passClaimStep();
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
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // PR #380 — pass through the org step (account → org → …).
  await passOrgStep();
  // PR #375 — TwoFactor step → skip (org → twofactor → wifi).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Onboarding-Flow redesign — Internet split into Wi-Fi then Address. Skip both.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(
      screen.getByRole("button", { name: /skip — no remote access/i }),
    );
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

  it("shows the blocked view when endpoint isn't configured", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    render(<SetupPage />);
    await advanceToVpn();

    expect(
      screen.getByText(/remote access needs an internet address first/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /set up internet address/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
    expect(createVpnPeerMock).not.toHaveBeenCalled();
  });

  it("Set up internet address returns the customer to the Address step", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    render(<SetupPage />);
    await advanceToVpn();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /set up internet address/i }),
      );
    });

    // Onboarding-Flow redesign — the precheck now jumps back to the dedicated
    // Address step (not the old combined Internet step), whose title is
    // "Give your box a web address".
    expect(
      screen.getByText(/give your box a web address/i),
    ).toBeInTheDocument();
  });

  it("Skip for now from blocked advances to done", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    render(<SetupPage />);
    await advanceToVpn();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    // VPN finished → AI step → Team step (PR #381). Skip both to reach Done.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(
        screen.getByRole("button", { name: /invite people later/i }),
      );
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

    // VPN finished → AI step → Team step (PR #381). Skip both to reach Done.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(
        screen.getByRole("button", { name: /invite people later/i }),
      );
    });
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
  });
});
