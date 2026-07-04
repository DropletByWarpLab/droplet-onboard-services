/**
 * TeamStep — the "Connect SSO" affordance must be HONEST, not a dead control.
 *
 * The onboarding connectivity audit found the SSO button was inert (no onClick,
 * no api call) while a real discovery endpoint exists. This step now drives the
 * directory-sync card off `getEnabledSsoProviders()` (the same WARP-629 endpoint
 * the login page uses):
 *   - no provider configured → an informational card, NO no-op button;
 *   - provider(s) configured → a truthful "Synced · <provider>" indicator.
 *
 * Proven RED first: with the old inert `<button>Connect SSO</button>` a
 * "Connect SSO" button is present and no synced indicator ever renders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const getEnabledSsoProviders = vi.fn();
// WARP-1049: TeamStep now reads the caller's role via useAuth to cap the role
// picker. This suite renders TeamStep bare (no AuthProvider), so mock useAuth
// with a default owner — the full role set — leaving this suite's behaviour
// unchanged (the picker-cap itself is covered in TeamStep.local-account.test).
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" },
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    postTeamInvite: vi.fn(async (input: { email: string; role: string }) => ({
      email: input.email.toLowerCase(),
      role: input.role,
    })),
    getEnabledSsoProviders: (...a: unknown[]) => getEnabledSsoProviders(...a),
  };
});

import { TeamStep } from "./TeamStep";

describe("TeamStep SSO control is honest (connectivity audit D1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders no no-op 'Connect SSO' button when no directory is configured", async () => {
    getEnabledSsoProviders.mockResolvedValue([]);
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    // Informational card still present (the SSO option is explained)…
    expect(await screen.findByText(/Sync your directory/i)).toBeInTheDocument();
    // …but the inert no-op button is gone.
    expect(
      screen.queryByRole("button", { name: /connect sso/i }),
    ).not.toBeInTheDocument();
    expect(getEnabledSsoProviders).toHaveBeenCalled();
  });

  it("shows a truthful synced indicator when a directory IS connected", async () => {
    getEnabledSsoProviders.mockResolvedValue(["google", "okta"]);
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    expect(await screen.findByText(/Synced/i)).toBeInTheDocument();
    expect(screen.getByText(/Google Workspace/)).toBeInTheDocument();
    expect(screen.getByText(/Okta/)).toBeInTheDocument();
    // Still no dead button.
    expect(
      screen.queryByRole("button", { name: /connect sso/i }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the informational card if discovery fails (best-effort)", async () => {
    getEnabledSsoProviders.mockRejectedValue(new Error("offline"));
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    expect(await screen.findByText(/Sync your directory/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /connect sso/i }),
    ).not.toBeInTheDocument();
  });

  it("resolves the azuread/microsoft aliases to Microsoft Entra (shared catalog)", async () => {
    getEnabledSsoProviders.mockResolvedValue(["azuread"]);
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    expect(await screen.findByText(/Synced/i)).toBeInTheDocument();
    expect(screen.getByText(/Microsoft Entra/)).toBeInTheDocument();
  });
});
