/**
 * WARP-929 — the navigation floor must hold at the FUNCTION level, not only in
 * the StepShell UI.
 *
 * The wizard fences welcome/claim/account behind the Workspace (`org`) floor so
 * a created owner / claimed appliance can never be un-done from the wizard. The
 * StepShell chrome enforces this in the UI (it hides Back and makes the rail
 * rows static at/under the floor) — that path is covered by
 * `StepShell.nav.test.tsx`.
 *
 * But the page exposes `navigate` / `back` on the `SetupNav` context, and ANY
 * caller of `useSetupNav().navigate("account")` or `.back()` would otherwise
 * sail straight past the floor: the UI guard is not the invariant. These tests
 * call those functions DIRECTLY (bypassing the chrome) and assert the rendered
 * step never drops below the floor.
 *
 * We capture the live `SetupNav` value by spying the `SetupNavProvider`, drive
 * the real `SetupPage`, then invoke `navigate`/`back` and assert on the
 * rendered step title.
 *
 * Proven RED first: without the function-level clamp, `navigate("account")`
 * renders the "Create your account" step and `back()` from `org` (the floor)
 * walks down into account/claim — both below the floor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { SetupNav } from "@/components/setup/setup-nav";

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

// Capture the live SetupNav the page hands the provider, while still rendering
// the real children so the wizard step actually mounts.
let capturedNav: SetupNav | null = null;
vi.mock("@/components/setup/setup-nav", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/setup/setup-nav")
  >("@/components/setup/setup-nav");
  return {
    ...actual,
    SetupNavProvider: ({
      value,
      children,
    }: {
      value: SetupNav;
      children: React.ReactNode;
    }) => {
      capturedNav = value;
      return actual.SetupNavProvider({ value, children });
    },
  };
});

// Stub the API surface so any step we land on mounts quietly.
vi.mock("@/lib/api", () => ({
  checkSetupRequired: vi.fn(async () => "required"),
  checkClaimGateEnabled: vi.fn(async () => false),
  setupAdmin: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "Front-panel display", online: true },
    supply_chain: { taa_compliant: true, ndaa_889_clear: true, summary: "Verified" },
  })),
  postClaim: vi.fn(async () => ({ claimed: true, next_step: "account" })),
  postOrg: vi.fn(async () => ({
    ok: true, slug: "acme", reserved_host: "droplet.local/acme", next_step: "internet",
  })),
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

describe("setup wizard — navigation floor holds at the function level (WARP-929)", () => {
  beforeEach(() => {
    useReducedMotionMock.mockReturnValue(true);
    capturedNav = null;
    // Resume at twofactor (idx 4), well past the org floor (idx 3).
    useAuthMock.mockReturnValue({
      completeSetup: vi.fn(),
      setupState: { appliance: "unclaimed", setupStep: "twofactor", userTourCompleted: false },
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("navigate() to a below-floor step is a no-op (can't jump to account/claim/welcome)", () => {
    render(<SetupPage />);
    expect(capturedNav).not.toBeNull();
    const nav = capturedNav as SetupNav;

    // Sanity: we resumed on twofactor.
    expect(screen.getByText(/add two-factor authentication/i)).toBeInTheDocument();

    // Directly invoke navigate to a below-floor step, bypassing the UI guard.
    act(() => {
      nav.navigate("account" as never);
    });
    expect(screen.queryByText(/create your account/i)).not.toBeInTheDocument();

    act(() => {
      nav.navigate("claim" as never);
    });
    expect(screen.queryByText(/looking for your droplet/i)).not.toBeInTheDocument();

    act(() => {
      nav.navigate("welcome" as never);
    });
    expect(screen.queryByText(/welcome to droplet/i)).not.toBeInTheDocument();

    // Still on twofactor — the floor held.
    expect(screen.getByText(/add two-factor authentication/i)).toBeInTheDocument();
  });

  it("navigate() to an at-or-above-floor step still works", () => {
    render(<SetupPage />);
    const nav = capturedNav as SetupNav;

    // org is exactly the floor — navigable.
    act(() => {
      nav.navigate("org" as never);
    });
    expect(screen.getByText(/create your workspace/i)).toBeInTheDocument();
  });

  it("back() never steps below the floor", () => {
    render(<SetupPage />);
    const nav = capturedNav as SetupNav;

    // From twofactor (idx 4) the first Back lands on the org floor (idx 3).
    act(() => {
      nav.back?.();
    });
    expect(screen.getByText(/create your workspace/i)).toBeInTheDocument();

    // Repeated Back from the floor must NOT descend into account/claim/welcome.
    act(() => {
      nav.back?.();
    });
    expect(screen.queryByText(/create your account/i)).not.toBeInTheDocument();
    expect(screen.getByText(/create your workspace/i)).toBeInTheDocument();
  });
});
