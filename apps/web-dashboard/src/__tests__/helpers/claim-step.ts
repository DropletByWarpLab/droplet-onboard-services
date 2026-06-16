/**
 * PR #373 — shared test helpers for the onboarding Claim step.
 *
 * Claim slots FIRST (welcome → claim → account), so every existing setup test
 * that walked welcome → account now has to pass THROUGH claim. These helpers
 * centralize:
 *   - `CLAIM_API_MOCKS` — the two `@/lib/api` members the Claim step calls,
 *     spread into each test's `vi.mock("@/lib/api", …)` factory so the step's
 *     contract-fetch + claim resolve without hitting the network. Defaults to
 *     the happy path (a reachable appliance + a successful bind).
 *   - `passClaimStep()` — click through the rendered Claim step to the account
 *     step, the way the customer would.
 *
 * Kept tiny and import-only (no React) so it can be referenced from any setup
 * test's navigation helper.
 */
import { fireEvent, screen, act } from "@testing-library/react";

export const FIXTURE_APPLIANCE_CONTRACT = {
  appliance_id: "droplet-appliance-test",
  compute: { label: "Compute", value: "Local AI compute", online: true },
  storage: { label: "Storage", value: "Encrypted at rest", online: true },
  network: { label: "Network", value: "On your local network", online: true },
  display: { label: "Display", value: "Front-panel display", online: true },
  supply_chain: {
    taa_compliant: true,
    ndaa_889_clear: true,
    summary: "Supply chain verified · TAA compliant · NDAA §889 clear",
  },
};

/**
 * The `@/lib/api` members the Claim step depends on, happy-path. Spread into a
 * test's api mock factory:
 *
 *   vi.mock("@/lib/api", () => ({ ...CLAIM_API_MOCKS(), …other mocks }));
 */
export function claimApiMocks() {
  return {
    fetchApplianceContract: async () => FIXTURE_APPLIANCE_CONTRACT,
    postClaim: async () => ({ claimed: true, next_step: "account" }),
  };
}

/**
 * Walk the rendered Claim step → account. Assumes the welcome "Get Started"
 * click already landed us on Claim. Lets the contract-fetch effect resolve,
 * enters a code, clicks "Claim this Droplet", and lets the bind resolve.
 */
export async function passClaimStep() {
  // Contract-fetch effect.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const input = screen.getByPlaceholderText(/DRPL/i);
  fireEvent.change(input, { target: { value: "DRPL-7K2Q-9F4M" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /claim this droplet/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
