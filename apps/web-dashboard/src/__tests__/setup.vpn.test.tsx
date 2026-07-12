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
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
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
// WARP-1039 — AddressStep rehydrates from (and the VpnStep blocked precheck
// reads) the saved name; the default beforeEach keeps the no-name baseline.
const fetchBoxNameMock = vi.fn();

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  // WARP-165 — AccountStep probes the claim gate on mount; false = un-gated.
  checkClaimGateEnabled: vi.fn(async () => false),
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
  // WARP-817 — WifiStep reads the host topology on mount to decide its
  // default disclosure state; null (best-effort) leaves the collapsed default.
  // These tests just wander to Home Wi-Fi via the rail and back, never
  // interacting with its fields.
  getNetworkTopology: vi.fn(async () => null),
  // WARP-979 — the reworked AddressStep imports these (the vpn tests skip the
  // Secured step, so they never actually fire).
  checkBoxName: vi.fn(async () => ({
    available: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
    authoritative: false,
  })),
  setBoxName: vi.fn(async () => ({
    ok: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
  })),
  fetchBoxName: () => fetchBoxNameMock(),
  // VpnStep calls routerUnreachableNotice in its mint catch; provide the real
  // "not a router error → null" behaviour so the ordinary-error path works.
  routerUnreachableNotice: vi.fn(() => null),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchCameras: vi.fn(async () => []),
  removeCamera: vi.fn(async () => undefined),
  fetchVpnStatus: () => fetchVpnStatusMock(),
  fetchVpnPeers: vi.fn(async () => ({ peers: [] })),
  createVpnPeer: (label: string) => createVpnPeerMock(label),
  // AI step is downstream — empty mock so its Skip link is always present.
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  // WARP-1036 — voice slots after ai. This suite is about the VPN step, so
  // voice-io is "not deployed" here: the explicit voice_unavailable makes the
  // step auto-skip (ai → voice → team collapses to ai → team), keeping the
  // existing skip chains below valid while ALSO exercising the page-level
  // auto-skip wiring.
  fetchVoiceStatus: vi.fn(async () => {
    const e = new Error("voice unavailable") as Error & { code?: string };
    e.code = "voice_unavailable";
    throw e;
  }),
  sayVoiceTest: vi.fn(async () => ({ ok: true, duration_s: 1.0 })),
  isVoiceUnavailableError: (err: unknown) =>
    (err as { code?: string } | null)?.code === "voice_unavailable",
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
    // WARP-979 — the address step (Secured / name your box) skip label.
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
  });
  // WARP-933 — Storage and Cameras now RENDER (no silent auto-skip). Skip each:
  // storage → discovery → cameras → VPN.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
  }
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
    fetchBoxNameMock.mockReset();
    fetchBoxNameMock.mockResolvedValue({ name: null, fqdn: null });
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

  it("Set up internet address returns the customer to the Address step (and prefills a saved name)", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    // WARP-1039 — mutable saved-name store: empty through the walk (so the
    // blocked view keeps its back-jump), then a saved name appears before the
    // jump so the Address step can rehydrate it.
    let saved: { name: string | null; fqdn: string | null } = {
      name: null,
      fqdn: null,
    };
    fetchBoxNameMock.mockImplementation(async () => saved);
    render(<SetupPage />);
    await advanceToVpn();

    saved = { name: "studio", fqdn: "studio.droplet-us.com" };
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /set up internet address/i }),
      );
    });

    // Onboarding-Flow redesign — the precheck jumps back to the dedicated
    // Address step (not the old combined Internet step). WARP-1109 — because a
    // name is already saved, the step shows the "your box is named X" state (its
    // fqdn + padlock) instead of the empty fresh-pick input; the address is
    // NEVER rendered as an empty/blank picker once the box already holds a name.
    await waitFor(() =>
      expect(screen.getByText(/your box is named/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("studio.droplet-us.com")).toBeInTheDocument();
    expect(screen.queryByLabelText(/box name/i)).not.toBeInTheDocument();
    // Keep-this-address advances; Rename is offered for a change.
    expect(
      screen.getByRole("button", { name: /keep this address/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /rename this address/i }),
    ).toBeInTheDocument();
  });

  it("saving on Address returns the customer to the VPN step, not storage (WARP-1039)", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    let saved: { name: string | null; fqdn: string | null } = {
      name: null,
      fqdn: null,
    };
    fetchBoxNameMock.mockImplementation(async () => saved);
    render(<SetupPage />);
    await advanceToVpn();

    // Blocked without a name → the back-jump is offered.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /set up internet address/i }),
      );
    });
    expect(screen.getByText(/name your secure address/i)).toBeInTheDocument();

    // Choose a name; the debounced availability check enables Continue.
    fireEvent.change(screen.getByLabelText(/box name/i), {
      target: { value: "studio" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled(),
    );
    // The POST persists the name — the remounted VPN precheck now sees it.
    saved = { name: "studio", fqdn: "studio.droplet-us.com" };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Back on the VPN step (NOT storage) — and since the name is now saved,
    // the blocked view is the honest "being set up" variant with no bounce.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /your address is being set up/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/name your storage/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /set up internet address/i }),
    ).not.toBeInTheDocument();
  });

  it("a stale return-to flag is cleared by rail navigation — Address reached via the rail goes forward to storage (WARP-1039)", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
    render(<SetupPage />);
    await advanceToVpn();

    // VPN CTA sets the return-to flag and jumps to Address …
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /set up internet address/i }),
      );
    });
    expect(screen.getByText(/name your secure address/i)).toBeInTheDocument();

    // … but the customer wanders off via the rail instead (flag must clear) …
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to Home Wi-Fi" }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Go to Internet address" }),
      );
    });
    expect(screen.getByText(/name your secure address/i)).toBeInTheDocument();

    // … so skipping Address now moves FORWARD to storage, not back to VPN.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /skip — i'll do this later/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/name your storage/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /turn on remote access/i }),
    ).not.toBeInTheDocument();
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

  it("renders the one-tap toggle when endpoint is configured (WARP-979)", async () => {
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

    expect(screen.getByText(/turn on remote access/i)).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /turn on remote access/i }),
    ).toBeInTheDocument();
    // The advanced named-device form is reachable but not the primary surface.
    expect(screen.queryByPlaceholderText(/stefan's iphone/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /name a specific device instead/i }),
    ).toBeInTheDocument();
  });

  it("the one-tap toggle mints a peer (auto-derived label) + advances to ready", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
      endpointHost: "yourstudio.duckdns.org",
    });
    createVpnPeerMock.mockResolvedValue({
      peer: {
        id: "p1",
        userId: "owner",
        deviceLabel: "This device",
        publicKey: "PUB=",
        assignedIp: "10.13.13.2",
        status: "active",
        createdAt: "2026-05-14T00:00:00Z",
      },
      conf: "[Interface]\nPrivateKey = secret\nAddress = 10.13.13.2/32\n",
    });
    render(<SetupPage />);
    await advanceToVpn();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("switch", { name: /turn on remote access/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createVpnPeerMock).toHaveBeenCalledWith("This device");
    // Ready phase: QR wrapper + how-to-use list.
    expect(screen.getByTestId("vpn-qr-wrapper")).toBeInTheDocument();
    expect(screen.getByText(/scan from qr code/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /i'm connected — continue/i }),
    ).toBeInTheDocument();
  });

  it("the advanced named-device form still mints with the typed name", async () => {
    fetchVpnStatusMock.mockResolvedValue({
      configured: true,
      endpointConfigured: true,
    });
    createVpnPeerMock.mockResolvedValue({
      peer: {
        id: "p1",
        userId: "owner",
        deviceLabel: "Stefan's iPhone",
        publicKey: "P=",
        assignedIp: "10.13.13.2",
        status: "active",
        createdAt: "now",
      },
      conf: "[Interface]\n",
    });
    render(<SetupPage />);
    await advanceToVpn();

    // Open the advanced form from the toggle view.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /name a specific device instead/i }),
      );
      await Promise.resolve();
    });
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
    expect(screen.getByTestId("vpn-qr-wrapper")).toBeInTheDocument();
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
    await act(async () => {
      fireEvent.click(
        screen.getByRole("switch", { name: /turn on remote access/i }),
      );
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
