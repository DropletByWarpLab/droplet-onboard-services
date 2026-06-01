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
import { render, screen } from "@testing-library/react";

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

  it("starts at welcome when there is no persisted step", () => {
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: null,
    });
    render(<SetupPage />);
    expect(
      screen.getByRole("button", { name: /get started/i }),
    ).toBeInTheDocument();
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

  it("ignores an unknown persisted step and falls back to welcome", () => {
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      // org/team are still gated (PR #373 wires `claim` but not org/team) — a
      // value the wizard can't render must not strand the customer on a blank
      // screen.
      setupState: { appliance: "unclaimed", setupStep: "org", userTourCompleted: false },
    });
    render(<SetupPage />);
    expect(
      screen.getByRole("button", { name: /get started/i }),
    ).toBeInTheDocument();
  });
});
