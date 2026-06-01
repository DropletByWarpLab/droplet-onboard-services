/**
 * PR #380 — shared test helpers for the onboarding Org step.
 *
 * Org slots AFTER account (welcome → claim → account → org → twofactor →
 * internet → …; PR #375's client-only `twofactor` step follows org). So every
 * existing setup test that walked account → internet now has to pass THROUGH
 * org (and then skip twofactor). These helpers centralize:
 *   - `orgApiMocks()` — the one `@/lib/api` member the Org step calls
 *     (`postOrg`), spread into each test's `vi.mock("@/lib/api", …)` factory so
 *     a valid submit resolves without hitting the network. Defaults to the
 *     happy path (workspace persisted, advance to internet).
 *   - `passOrgStep()` — fill the required workspace name + URL slug and click
 *     "Continue" to advance to the internet step, the way the customer would.
 *
 * Kept tiny + import-only (no React) so it can be referenced from any setup
 * test's navigation helper, mirroring claim-step.ts.
 */
import { fireEvent, screen, act } from "@testing-library/react";

/** Happy-path `postOrg` for the Org step. Spread into a test's api mock:
 *
 *   vi.mock("@/lib/api", () => ({ ...orgApiMocks(), …other mocks }));
 */
export function orgApiMocks() {
  return {
    postOrg: async () => ({
      ok: true,
      slug: "acme",
      reserved_host: "droplet.local/acme",
      next_step: "internet",
    }),
  };
}

/**
 * Walk the rendered Org step → internet. Assumes the account step's "Create
 * Account" click already landed us on Org. Fills the required workspace name +
 * URL slug, clicks "Continue", and lets the persist resolve.
 */
export async function passOrgStep() {
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
}
