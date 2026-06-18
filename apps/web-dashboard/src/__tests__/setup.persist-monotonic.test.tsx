/**
 * PR #518 review (rjouffret) — the wizard's persisted resume pointer must be
 * MONOTONIC NON-DECREASING.
 *
 * The clickable step rail + Back button let the customer jump back to an
 * already-reached step. The page seeds the session-only `maxReachedIdx` (what
 * keeps earlier steps unlocked) on mount from the PERSISTED `setupStep` via
 * `resumeStepFrom(...)`. So if a backward jump overwrites the persisted pointer
 * with the earlier step, a refresh re-seeds `maxReachedIdx` from that earlier
 * step and RE-LOCKS every step past it — defeating the whole clickable-rail
 * feature.
 *
 * Fix under test: `setStep` only persists when advancing FORWARD past the
 * furthest-reached point, so the stored pointer never goes backwards.
 *
 * We drive the REAL navigation chrome (the StepShell Back button + the rail
 * rows), not internal state, and assert on the spied `patchSetupStep`:
 *   - backward nav (Back button, rail click) must NOT persist a lower step;
 *   - forward nav past the furthest point still persists.
 *
 * Proven RED first: with the unconditional `void patchSetupStep(next)` the
 * Back-button case fires `patchSetupStep("cameras")` (idx 9) after reaching
 * `vpn` (idx 10), lowering the pointer — the monotonicity assertion fails.
 *
 * (Onboarding-Flow redesign — the single `internet` step split into `wifi` +
 * `address`, so every step from `storage` on shifted +1: `vpn` is now idx 10,
 * `cameras` idx 9, `wifi` idx 5.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { STEPS, type Step } from "@/components/setup/wizard-steps";

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

// Spy the persist call; stub the rest of the API surface so any step we land
// on can mount quietly without reaching the network. The mock mirrors the real
// `patchSetupStep(setupStep: string)` signature.
const patchSetupStepMock = vi.fn(async (_setupStep: string) => undefined);
vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  // WARP-165 — AccountStep probes the claim gate on mount; false = un-gated.
  checkClaimGateEnabled: vi.fn(async () => false),
  setupAdmin: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  patchSetupStep: (setupStep: string) => patchSetupStepMock(setupStep),
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

/**
 * The lowest STEPS index `patchSetupStep` was ever called with, or `Infinity`
 * if it was never called (so a "never lower than N" assertion holds vacuously).
 */
function lowestPersistedIdx(): number {
  const indices = patchSetupStepMock.mock.calls.map((c) =>
    STEPS.indexOf(c[0] as Step),
  );
  return indices.length ? Math.min(...indices) : Infinity;
}

describe("setup wizard — persisted resume pointer is monotonic (PR #518)", () => {
  beforeEach(() => {
    useReducedMotionMock.mockReturnValue(true);
    // Resume already at vpn (idx 10): maxReachedIdx seeds to 10, so cameras
    // (idx 9) and every earlier step are reached → navigable via the rail.
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: { appliance: "unclaimed", setupStep: "vpn", userTourCompleted: false },
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT persist a lower step when the Back button navigates backward", () => {
    render(<SetupPage />);

    // Sanity: we resumed at vpn, past welcome.
    expect(
      screen.queryByRole("button", { name: /get started/i }),
    ).not.toBeInTheDocument();

    // Click Back: vpn (10) → ai is forward; Back goes to the PREVIOUS step
    // cameras (9). This is a backward move below the furthest-reached point.
    const back = screen.getByRole("button", { name: /^back$/i });
    back.click();

    // The pointer must never be lowered. With the unconditional persist this
    // fires patchSetupStep("cameras") (idx 9 < 10) and fails.
    expect(patchSetupStepMock).not.toHaveBeenCalledWith("cameras");
    expect(lowestPersistedIdx()).toBeGreaterThanOrEqual(10);
  });

  it("does NOT persist a lower step when a rail row jumps backward", () => {
    render(<SetupPage />);

    // Jump back to an earlier reached step via the rail. Onboarding-Flow
    // redesign — the old "Internet" rail row is now "Home Wi-Fi" (`wifi`,
    // idx 5). A backward jump must not persist anything; in particular it must
    // not write the `internet` SetupStep that `wifi`/`address` map to (which
    // would lower the stored pointer below the resumed `vpn`).
    const railJump = screen.getByRole("button", { name: "Go to Home Wi-Fi" });
    railJump.click();

    expect(patchSetupStepMock).not.toHaveBeenCalledWith("internet");
    expect(lowestPersistedIdx()).toBeGreaterThanOrEqual(10);
  });

  it("STILL persists forward progress past the furthest-reached step", () => {
    // Resume at welcome (idx 0) so the only move available is forward.
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false },
    });
    render(<SetupPage />);

    // "Get Started" advances welcome (0) → claim (1): a forward transition
    // past the furthest-reached point. This MUST persist so a mid-wizard
    // refresh resumes here rather than restarting at welcome.
    const getStarted = screen.getByRole("button", { name: /get started/i });
    getStarted.click();

    expect(patchSetupStepMock).toHaveBeenCalledWith("claim");
  });
});
