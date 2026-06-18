/**
 * PR #372 — the setup wizard is RESUMABLE: it hydrates its starting step
 * from `useAuth().setupState.setupStep` so a mid-wizard refresh returns to
 * the same step (the headline AC), instead of always restarting at welcome.
 *
 * We assert behaviourally on the rendered step rather than internal state:
 *   - null/"welcome" setupState  → Welcome step (its "Get Started" CTA).
 *   - a later persisted step      → NOT the Welcome step (resumed past it).
 *
 * The step components fetch their own data; we stub `@/lib/api` so the
 * resumed step can mount without reaching the network. We only care WHICH
 * step the wizard lands on, not that step's own behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const useReducedMotionMock = vi.fn(() => true);
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>(
    "framer-motion",
  );
  return { ...actual, useReducedMotion: () => useReducedMotionMock() };
});

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
}));

// Stub the API surface the steps call so a resumed step can mount quietly.
vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  // WARP-165 — AccountStep probes the claim gate on mount; false = un-gated.
  checkClaimGateEnabled: vi.fn(async () => false),
  setupAdmin: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchVpnStatus: vi.fn(async () => ({ configured: false, endpointConfigured: false })),
  createVpnPeer: vi.fn(),
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  postTeamInvite: vi.fn(async () => ({
    ok: true, token: "tok", email: "x@acme.co", role: "family",
    expires_at: "2026-06-04T00:00:00.000Z",
  })),
  fetchMatterDevices: vi.fn(async () => ({
    lights: [], switches: [], climate: [], sensors: [],
    media: [], covers: [], locks: [], other: [],
  })),
}));

import SetupPage from "@/app/setup/page";

describe("setup wizard — resumable from setupState (PR #372)", () => {
  beforeEach(() => {
    useReducedMotionMock.mockReturnValue(true);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("holds the wizard on a connecting surface while setupState is unresolved (WARP-867)", () => {
    // Pre-fix this rendered the Welcome step: the step machine hydrated from
    // a still-null setupState in a run-once useState initializer, so EVERY
    // cold load of /setup "resumed" at welcome and the persisted step was
    // ignored — the field report's reboot walked itself back into the
    // unsatisfiable account step that way. A null state now renders the
    // calm connecting surface instead of guessing welcome.
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: null,
      setupProbeError: null,
      setupAutoRetrying: false,
      retrySetupProbe: vi.fn(),
    });
    render(<SetupPage />);
    expect(screen.getByText(/connecting to your droplet/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /get started/i }),
    ).not.toBeInTheDocument();
  });

  it("mounts the wizard at the persisted step once setupState resolves late (WARP-867)", () => {
    // The cold-load order AuthGate guarantees: public pages render BEFORE the
    // boot probes settle. So the page first sees null (connecting surface),
    // then the resolved state — and must resume at the persisted step, never
    // welcome.
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: null,
      setupProbeError: null,
      setupAutoRetrying: false,
      retrySetupProbe: vi.fn(),
    });
    const view = render(<SetupPage />);
    expect(screen.getByText(/connecting to your droplet/i)).toBeInTheDocument();

    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: { appliance: "unclaimed", setupStep: "internet", userTourCompleted: false },
    });
    view.rerender(<SetupPage />);
    expect(
      screen.queryByRole("button", { name: /get started/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/set up your home wi-fi/i).length,
    ).toBeGreaterThan(0);
  });

  it("surfaces the probe error + retry when the lifecycle probe failed (WARP-867)", () => {
    const retrySetupProbe = vi.fn();
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: null,
      setupProbeError: "Couldn't reach the appliance to read setup state.",
      setupAutoRetrying: false,
      retrySetupProbe,
    });
    render(<SetupPage />);
    expect(screen.getByText(/can't reach your appliance/i)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retry);
    expect(retrySetupProbe).toHaveBeenCalledTimes(1);
  });

  it("starts at welcome when the persisted step IS welcome", () => {
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false },
    });
    render(<SetupPage />);
    expect(
      screen.getByRole("button", { name: /get started/i }),
    ).toBeInTheDocument();
  });

  it("resumes PAST welcome when a later step is persisted", () => {
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: { appliance: "unclaimed", setupStep: "vpn", userTourCompleted: false },
    });
    render(<SetupPage />);
    // Resumed at the VPN step → the Welcome step's CTA must be gone.
    expect(
      screen.queryByRole("button", { name: /get started/i }),
    ).not.toBeInTheDocument();
  });

  it("resumes on the team step (PR #381 wired it)", () => {
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: { appliance: "unclaimed", setupStep: "team", userTourCompleted: false },
    });
    render(<SetupPage />);
    // Resumed at the Team step → the Welcome CTA is gone, the Team heading shows.
    expect(
      screen.queryByRole("button", { name: /get started/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/bring in your team/i)).toBeInTheDocument();
  });

  it("resumes a persisted 'internet' on the wifi step (network-split mapping), not welcome", () => {
    // The server's SetupStep enum still has the single `internet` value; the
    // wizard split it into wifi -> address (persisted as `internet`). Without
    // resumeStepFrom's internet->wifi mapping a persisted `internet` fails the
    // STEPS.includes check (STEPS dropped "internet") and falls back to
    // welcome — losing the customer's place (PR #548 review).
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: { appliance: "unclaimed", setupStep: "internet", userTourCompleted: false },
    });
    render(<SetupPage />);
    expect(
      screen.queryByRole("button", { name: /get started/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/set up your home wi-fi/i).length,
    ).toBeGreaterThan(0);
  });

  it("ignores an unknown persisted step and falls back to welcome", () => {
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      // A value the wizard can't render (not in SETUP_STEPS) must not strand
      // the customer on a blank screen — it falls back to welcome.
      setupState: { appliance: "unclaimed", setupStep: "nonexistent-step", userTourCompleted: false },
    });
    render(<SetupPage />);
    expect(
      screen.getByRole("button", { name: /get started/i }),
    ).toBeInTheDocument();
  });
});
