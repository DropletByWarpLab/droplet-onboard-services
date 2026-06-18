import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

// Force the reduced-motion branch in WelcomeFlourish so the assertion fires
// on synchronous render, not after timers. (See research doc §5.2.)
const useReducedMotionMock = vi.fn(() => true);
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>(
    "framer-motion",
  );
  return {
    ...actual,
    useReducedMotion: () => useReducedMotionMock(),
  };
});

// Auth context — minimal stub. completeSetup is invoked on transition out of
// `account`; we don't need it to do anything for these tests.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    completeSetup: vi.fn(),
    setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false },
  }),
}));

// API stubs. setupAdmin + loginUser must resolve so the page advances to
// `internet`; fetchDuckDnsStatus returns "unconfigured" so the wizard's
// Internet step renders its form (and its "Skip for now" button) without
// reaching the network; fetchMatterDevices keeps the discovery polling
// loop quiet.
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
  // Storage step auto-skips when zero drives — keep the bridge "empty"
  // so the flow test doesn't have to click anything on that step.
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  // Cameras step auto-skips when zero discovered cameras — same idea.
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  // VPN step: endpoint not configured → preCheck phase, "Skip for now"
  // is always present.
  fetchVpnStatus: vi.fn(async () => ({
    configured: false,
    endpointConfigured: false,
  })),
  createVpnPeer: vi.fn(),
  // AI step: no models yet → "Skip for now" is always present.
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  // PR #381 — team slots after ai; TeamStep imports postTeamInvite. The flow
  // test skips the step (no invite), but the import must resolve.
  postTeamInvite: vi.fn(async () => ({
    ok: true,
    token: "tok",
    email: "x@acme.co",
    role: "family",
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

describe("setup flow → done state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useReducedMotionMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders WelcomeFlourish on the done step (not the legacy 'Sign In' screen)", async () => {
    render(<SetupPage />);

    // Welcome screen → click Get Started.
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    // PR #373 — Claim step (welcome → claim → account). Let the contract fetch
    // resolve, enter a code, claim → advance to account.
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

    // Account form. Fill required fields and submit.
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
      // Flush the in-flight setupAdmin/loginUser promises.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // PR #380 — we're now on `org`. Name the workspace + continue to
    // `twofactor` (account → org → twofactor → internet).
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

    // PR #375 — we're now on `twofactor`. Skip TOTP enrollment to advance
    // to `wifi` (the gate is exercised in TwoFactorStep.test.tsx).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    // Onboarding-Flow redesign — the single Internet step is now two: `wifi`
    // then `address`. Skip both to reach `discovery`. The Wi-Fi step has no
    // async mount load; the Address step's fetchDuckDnsStatus effect resolves
    // before its skip link is queried (the skip link is always rendered).
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

    // We're now on `discovery`. Skip again. Cameras auto-skips on 0,
    // VPN lands on preCheck (endpointConfigured: false), one more skip
    // gets us to `done`.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    // VPN step preCheck → skip → AI.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    // AI step → skip → Team (PR #381 slots team after ai). fetchModels mocked
    // empty so the picker just shows "No models available yet"; the Skip link
    // is always rendered.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    // Team step → skip ("I'll invite people later") → Done. Team IS skippable
    // (solo owner is a valid end state).
    expect(screen.getByText(/bring in your team/i)).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(
        screen.getByRole("button", { name: /invite people later/i }),
      );
    });

    // The new flourish must render — not the legacy static check screen.
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
    expect(screen.getByText(/Welcome, Robin/i)).toBeInTheDocument();
    // The legacy screen exposed a "Sign In" button — make sure it's gone.
    expect(
      screen.queryByRole("button", { name: /sign in/i }),
    ).not.toBeInTheDocument();
  });
});
