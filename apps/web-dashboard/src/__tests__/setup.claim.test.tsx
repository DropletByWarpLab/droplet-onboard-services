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
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ setupState: undefined }),
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
    // 2×2 spec grid — every subsystem label present.
    for (const label of ["Compute", "Storage", "Network", "Display"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
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
