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
  }),
}));

// API stubs. setupAdmin + loginUser must resolve so the page advances to
// `internet`; fetchDuckDnsStatus returns "unconfigured" so the wizard's
// Internet step renders its form (and its "Skip for now" button) without
// reaching the network; fetchMatterDevices keeps the discovery polling
// loop quiet.
vi.mock("@/lib/api", () => ({
  setupAdmin: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
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

    // Account form. Fill required fields and submit.
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
      // Flush the in-flight setupAdmin/loginUser promises.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // PR #375 — we're now on `twofactor`. Skip TOTP enrollment to advance
    // to `internet` (the gate is exercised in TwoFactorStep.test.tsx).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    // We're now on `internet`. Skip to `discovery`. Need to flush again so
    // the InternetStep's fetchDuckDnsStatus effect resolves before the
    // "Skip for now" button is queried — the button is present regardless,
    // but the form's loading-disabled state can briefly mask the primary
    // CTA; the skip link is always rendered.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
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
    // AI step → skip → Done. fetchModels mocked empty so the picker
    // just shows "No models available yet"; the Skip link is always
    // rendered.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
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
