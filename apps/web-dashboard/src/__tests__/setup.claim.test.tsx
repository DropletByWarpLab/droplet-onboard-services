/**
 * PR #373 — Claim step (onboarding).
 *
 * Validates (per #371 handoff §2 + OnbWizard.jsx WizClaim):
 *   1. Renders the detected-appliance card from GET /api/setup/appliance —
 *      appliance_id (mono), "Detected on LAN" chip, the 2×2 spec grid, and the
 *      supply-chain TAA/NDAA §889 chip.
 *   2. Correct code → POST /api/setup/claim → advance to the account step.
 *   3. Wrong code → inline error, stays on claim, never reveals the real code.
 *   4. Appliance unreachable (contract fetch fails) → "We can't see your
 *      Droplet yet" + retry; continue is blocked.
 *   5. Claim is NOT skippable — no skip control.
 *   6. Claim slots FIRST: "Get Started" on welcome lands on claim, not account.
 *
 * Same Vitest + JSDOM + assert-on-DOM-strings pattern as the other setup tests;
 * the whole `@/lib/api` surface the wizard imports is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false } }),
}));

const fetchApplianceContractMock = vi.fn();
const postClaimMock = vi.fn();

// Re-export the real ClaimError so the step's `instanceof` / `.rateLimited`
// branch works against thrown errors from the mock.
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    setupAdmin: vi.fn(async () => undefined),
    patchSetupStep: vi.fn(async () => undefined),
    loginUser: vi.fn(async () => undefined),
    fetchApplianceContract: () => fetchApplianceContractMock(),
    postClaim: (code: string) => postClaimMock(code),
    fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
    setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
    fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
    fetchDiscoveredCameras: vi.fn(async () => []),
    fetchVpnStatus: vi.fn(async () => ({
      configured: false,
      endpointConfigured: false,
    })),
    fetchModels: vi.fn(async () => ({ models: [] })),
  };
});

import SetupPage from "@/app/setup/page";

const FIXTURE_CONTRACT = {
  appliance_id: "droplet-rack-1-9c4f12",
  compute: {
    label: "Compute",
    value: "Local AI compute + control plane",
    online: true,
  },
  storage: { label: "Storage", value: "Encrypted at rest", online: true },
  network: { label: "Network", value: "On your local network", online: true },
  display: { label: "Display", value: "PyPortal lid display", online: true },
  supply_chain: {
    taa_compliant: true,
    ndaa_889_clear: true,
    summary: "Supply chain verified · TAA compliant · NDAA §889 clear",
  },
};

/** Click "Get Started" on the welcome splash and let the Claim step's
 *  contract-fetch effect resolve. */
async function advanceToClaim() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup Claim step (PR #373)", () => {
  beforeEach(() => {
    fetchApplianceContractMock.mockReset();
    postClaimMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lands on Claim (not account) after the welcome splash", async () => {
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    render(<SetupPage />);
    await advanceToClaim();
    expect(screen.getByText(/we found your droplet/i)).toBeInTheDocument();
    // Account step's create-account control must NOT be present yet.
    expect(
      screen.queryByRole("button", { name: /create account/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the detected-appliance card from the contract", async () => {
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    render(<SetupPage />);
    await advanceToClaim();

    // appliance_id rendered (mono).
    expect(screen.getByText("droplet-rack-1-9c4f12")).toBeInTheDocument();
    // "Detected on LAN" status chip.
    expect(screen.getByText(/detected on lan/i)).toBeInTheDocument();
    // 2×2 spec grid — every subsystem label present. Scoped to the appliance
    // card: PR #384's aurora rail also renders a "Storage" wizard-step label,
    // so a global getByText would be ambiguous. The grid is the assertion's
    // intent, so scope to it.
    const card = within(screen.getByTestId("claim-appliance-card"));
    for (const label of ["Compute", "Storage", "Network", "Display"]) {
      expect(card.getByText(label)).toBeInTheDocument();
    }
    // Supply-chain reassurance chip.
    expect(
      screen.getByText(/TAA compliant.*NDAA §889 clear|NDAA §889 clear/i),
    ).toBeInTheDocument();
  });

  it("is NOT skippable — no skip control", async () => {
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    render(<SetupPage />);
    await advanceToClaim();
    expect(
      screen.queryByRole("button", { name: /skip/i }),
    ).not.toBeInTheDocument();
  });

  it("binds on the correct code and advances to the account step", async () => {
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    postClaimMock.mockResolvedValue({ claimed: true, next_step: "account" });
    render(<SetupPage />);
    await advanceToClaim();

    fireEvent.change(screen.getByPlaceholderText(/DRPL/i), {
      target: { value: "DRPL · 7K2Q · 9F4M" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /claim this droplet/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(postClaimMock).toHaveBeenCalledWith("DRPL · 7K2Q · 9F4M");
    // Advanced to account.
    expect(
      screen.getByRole("button", { name: /create account/i }),
    ).toBeInTheDocument();
  });

  it("shows an inline error on a wrong code and stays on claim, revealing nothing", async () => {
    const { ClaimError } = await vi.importActual<typeof import("@/lib/api")>(
      "@/lib/api",
    );
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    postClaimMock.mockRejectedValue(
      new ClaimError(
        "That claim code didn't match. Check the PyPortal display and try again.",
        "CLAIM_CODE_INVALID",
        false,
      ),
    );
    render(<SetupPage />);
    await advanceToClaim();

    fireEvent.change(screen.getByPlaceholderText(/DRPL/i), {
      target: { value: "WRON-GGGG-GGGG" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /claim this droplet/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/didn't match/i)).toBeInTheDocument();
    // Still on the claim step.
    expect(screen.getByText(/we found your droplet/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create account/i }),
    ).not.toBeInTheDocument();
  });

  it("blocks continue and offers retry when the appliance is unreachable", async () => {
    fetchApplianceContractMock.mockRejectedValue(new Error("503"));
    render(<SetupPage />);
    await advanceToClaim();

    expect(screen.getByText(/can't see your droplet yet/i)).toBeInTheDocument();
    // No claim CTA while unreachable — the customer can't proceed.
    expect(
      screen.queryByRole("button", { name: /claim this droplet/i }),
    ).not.toBeInTheDocument();
    // A retry control is offered.
    const retry = screen.getByRole("button", { name: /retry|try again/i });
    expect(retry).toBeInTheDocument();

    // Retry succeeds → the card renders.
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("droplet-rack-1-9c4f12")).toBeInTheDocument();
  });

  it("surfaces the rate-limit message distinctly when the budget is exhausted", async () => {
    const { ClaimError } = await vi.importActual<typeof import("@/lib/api")>(
      "@/lib/api",
    );
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    postClaimMock.mockRejectedValue(
      new ClaimError(
        "Too many claim attempts. Wait a few minutes and try again.",
        "CLAIM_RATE_LIMITED",
        true,
      ),
    );
    render(<SetupPage />);
    await advanceToClaim();

    fireEvent.change(screen.getByPlaceholderText(/DRPL/i), {
      target: { value: "DRPL-0000-0000" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /claim this droplet/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/too many claim attempts/i)).toBeInTheDocument();
  });
});

// ── WARP-631 — live countdown on a rate-limited claim ───────────────
describe("setup Claim step — rate-limit countdown (WARP-631)", () => {
  beforeEach(() => {
    fetchApplianceContractMock.mockReset();
    postClaimMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Drain any pending timers the component scheduled, then restore real time.
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Welcome → Claim, but under fake timers (so we pump promises manually). */
  async function advanceToClaimFake() {
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function rejectWithRateLimit(retryAfterSeconds: number) {
    const { ClaimError } = await vi.importActual<typeof import("@/lib/api")>(
      "@/lib/api",
    );
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    postClaimMock.mockRejectedValue(
      new ClaimError(
        "Too many claim attempts. Try again shortly.",
        "CLAIM_RATE_LIMITED",
        true,
        retryAfterSeconds,
      ),
    );
    render(<SetupPage />);
    await advanceToClaimFake();
    fireEvent.change(screen.getByPlaceholderText(/DRPL/i), {
      target: { value: "DRPL-0000-0000" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /claim this droplet/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("shows an m:ss countdown and disables the input + claim button (AC#5)", async () => {
    await rejectWithRateLimit(15);

    // Countdown message formatted m:ss — 15s → "0:15".
    expect(screen.getByText(/try again in 0:15/i)).toBeInTheDocument();
    // Input disabled while locked.
    expect(screen.getByPlaceholderText(/DRPL/i)).toBeDisabled();
    // The "Claim this Droplet" primary disabled while locked.
    expect(
      screen.getByRole("button", { name: /claim this droplet/i }),
    ).toBeDisabled();
  });

  it("decrements the countdown each second (AC#5)", async () => {
    await rejectWithRateLimit(15);
    expect(screen.getByText(/try again in 0:15/i)).toBeInTheDocument();

    // 3 seconds later → 0:12.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/try again in 0:12/i)).toBeInTheDocument();
  });

  it("formats minutes correctly (e.g. 90s → 1:30) (AC#5)", async () => {
    await rejectWithRateLimit(90);
    expect(screen.getByText(/try again in 1:30/i)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(31000);
    });
    // 90 - 31 = 59s → 0:59.
    expect(screen.getByText(/try again in 0:59/i)).toBeInTheDocument();
  });

  it("clears the timer and re-enables the controls when it elapses (AC#5)", async () => {
    await rejectWithRateLimit(2);
    expect(screen.getByText(/try again in 0:0?2/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/DRPL/i)).toBeDisabled();

    // Run out the clock.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Countdown message gone, controls usable again.
    expect(screen.queryByText(/try again in/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/DRPL/i)).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /claim this droplet/i }),
    ).not.toBeDisabled();
  });

  it("announces the lockout ONCE: sr-only live region is set once while the visible m:ss ticks (a11y)", async () => {
    await rejectWithRateLimit(15);

    // The visually-hidden polite live region is announced a single time when
    // the lockout starts — phrased in whole seconds so it never rewrites.
    const live = screen.getByTestId("claim-lockout-announcement");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveClass("sr-only");
    const announcedAtStart = live.textContent;
    expect(announcedAtStart).toMatch(/too many attempts/i);
    expect(announcedAtStart).toMatch(/about 15 seconds/i);

    // The visible countdown shows the ticking m:ss (a separate, non-live node).
    expect(screen.getByText(/try again in 0:15/i)).toBeInTheDocument();

    // Advance a few seconds: the VISIBLE countdown must change…
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/try again in 0:12/i)).toBeInTheDocument();
    // …but the live-region text must NOT (announced once, not per tick).
    expect(screen.getByTestId("claim-lockout-announcement").textContent).toBe(
      announcedAtStart,
    );

    // One more tick to be sure the live region stays frozen.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/try again in 0:11/i)).toBeInTheDocument();
    expect(screen.getByTestId("claim-lockout-announcement").textContent).toBe(
      announcedAtStart,
    );
  });

  it("the visible countdown container is NOT role=alert (only the sr-only region is live) (a11y)", async () => {
    await rejectWithRateLimit(15);

    // The ticking m:ss line is purely visual — it must not carry an alert role
    // (which, paired with per-tick text changes, would re-announce every second).
    const visibleCountdown = screen.getByText(/try again in 0:15/i);
    expect(visibleCountdown.closest('[role="alert"]')).toBeNull();
  });

  it("clears the sr-only announcement when the lockout elapses (a11y)", async () => {
    await rejectWithRateLimit(2);
    expect(
      screen.getByTestId("claim-lockout-announcement").textContent,
    ).toMatch(/too many attempts/i);

    // Run out the clock — the announcement is cleared so it isn't left in the
    // live region after the lockout ends.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText(/try again in/i)).not.toBeInTheDocument();
    expect(
      screen.getByTestId("claim-lockout-announcement").textContent,
    ).toBe("");
  });

  it("does NOT start a countdown for an ordinary wrong-code 400 (no retryAfter)", async () => {
    const { ClaimError } = await vi.importActual<typeof import("@/lib/api")>(
      "@/lib/api",
    );
    fetchApplianceContractMock.mockResolvedValue(FIXTURE_CONTRACT);
    postClaimMock.mockRejectedValue(
      new ClaimError(
        "That claim code didn't match. Check the PyPortal display and try again.",
        "CLAIM_CODE_INVALID",
        false,
      ),
    );
    render(<SetupPage />);
    await advanceToClaimFake();
    fireEvent.change(screen.getByPlaceholderText(/DRPL/i), {
      target: { value: "WRON-GGGG-GGGG" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /claim this droplet/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Inline error shown, but NO countdown and the input stays usable.
    expect(screen.getByText(/didn't match/i)).toBeInTheDocument();
    expect(screen.queryByText(/try again in/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/DRPL/i)).not.toBeDisabled();
  });
});
