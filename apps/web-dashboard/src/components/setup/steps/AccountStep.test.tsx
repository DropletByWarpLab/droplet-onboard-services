/**
 * Create-owner step — regression coverage for the field report where the
 * "Create Account" button did nothing and surfaced no error.
 *
 * Root cause: a 10-character password (e.g. "Warp123!@#") clears the
 * character-class rule but not the 12-char minimum, so `canSubmit` is false and
 * the CTA is disabled — with the unmet rule rendered nearly invisibly and no
 * explanation tying the dead button to the gate. These tests pin the new
 * behaviour: the gate is legible (checklist flags the unmet rule) AND a hint
 * spells out what's still blocking, while a fully valid form still submits.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AccountStep } from "./AccountStep";

const setupAdmin = vi.fn();
const loginUser = vi.fn();
const checkSetupRequired = vi.fn();
const checkClaimGateEnabled = vi.fn();
vi.mock("@/lib/api", () => ({
  setupAdmin: (...a: unknown[]) => setupAdmin(...a),
  loginUser: (...a: unknown[]) => loginUser(...a),
  checkSetupRequired: (...a: unknown[]) => checkSetupRequired(...a),
  checkClaimGateEnabled: (...a: unknown[]) => checkClaimGateEnabled(...a),
}));

// The step adopts the wizard auto-login into the auth context (so AuthGate
// knows the owner is signed in for the rest of the wizard — incl. the Done
// screen's embedded tour).
const setUserFromPasskey = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ setUserFromPasskey }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  setupAdmin.mockResolvedValue(undefined);
  loginUser.mockResolvedValue({
    user: { id: "1", username: "stefan", displayName: "Stefan" },
  });
  // Default: a genuinely fresh box — the create form is the normal mode.
  checkSetupRequired.mockResolvedValue("required");
  // WARP-165 — default OFF so the existing tests above run the un-gated form
  // (no claim-code field). Gate tests override this per-case.
  checkClaimGateEnabled.mockResolvedValue(false);
});

function fill(email: string, pw: string, confirm = pw) {
  fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
    target: { value: email },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: pw },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: confirm },
  });
}

const cta = () => screen.getByRole("button", { name: /create account/i });

describe("AccountStep", () => {
  it("keeps Create Account disabled for a too-short password and explains the gate", () => {
    render(<AccountStep onComplete={vi.fn()} />);
    // The exact field-report input: 10 chars — passes the class rule, fails the
    // 12-char minimum.
    fill("scruceru@warp-lab.ai", "Warp123!@#");

    expect(cta()).toBeDisabled();
    // The length requirement is shown as unmet, not silently hidden.
    // Anchored: WARP-668 also adds an up-front hint ("Use at least 12 characters
    // with a mix…"), so an unanchored match is now ambiguous — target the
    // checklist row's exact label.
    const lengthRow = screen.getByText(/^At least 12 characters$/i).closest("li");
    expect(lengthRow).toHaveTextContent(/not satisfied/i);
    // And the disabled button is no longer an unexplained dead end.
    expect(
      screen.getByText(/password doesn't meet all the requirements/i),
    ).toBeInTheDocument();
    expect(setupAdmin).not.toHaveBeenCalled();
  });

  it("explains a missing/invalid email even when the password is strong", () => {
    render(<AccountStep onComplete={vi.fn()} />);
    fill("not-an-email", "Warp123!@#xy"); // 12 chars, 4 classes → password OK
    expect(cta()).toBeDisabled();
    expect(screen.getByText(/email doesn't look right/i)).toBeInTheDocument();
  });

  it("shows no blocker hint before the user has started typing", () => {
    render(<AccountStep onComplete={vi.fn()} />);
    expect(
      screen.queryByText(/to continue|doesn't look right|doesn't meet/i),
    ).not.toBeInTheDocument();
  });

  it("enables and submits once email + a 12-char password are valid", async () => {
    const onComplete = vi.fn();
    render(<AccountStep onComplete={onComplete} />);
    fill("scruceru@warp-lab.ai", "Warp123!@#xy"); // 12 chars

    expect(cta()).toBeEnabled();
    fireEvent.click(cta());

    await waitFor(() =>
      expect(setupAdmin).toHaveBeenCalledWith(
        "scruceru@warp-lab.ai",
        "Warp123!@#xy",
        undefined,
      ),
    );
    await waitFor(() =>
      expect(loginUser).toHaveBeenCalledWith(
        "scruceru@warp-lab.ai",
        "Warp123!@#xy",
      ),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    // The session is adopted into the auth context — AuthGate must know the
    // owner is signed in for the rest of the wizard (Done screen included).
    expect(setUserFromPasskey).toHaveBeenCalledWith(
      expect.objectContaining({ username: "stefan" }),
    );
  });

  it("surfaces a friendly error (never the raw cause) if creation fails", async () => {
    setupAdmin.mockRejectedValueOnce(new Error("kaboom"));
    render(<AccountStep onComplete={vi.fn()} />);
    fill("scruceru@warp-lab.ai", "Warp123!@#xy");
    fireEvent.click(cta());

    expect(await screen.findByText(/couldn't sign you in/i)).toBeInTheDocument();
    // The raw error text is never shown to the user.
    expect(screen.queryByText(/kaboom/i)).not.toBeInTheDocument();
  });
});

/**
 * WARP-867 — the interrupted-run resume path. Once the owner row exists,
 * POST /auth/setup answers 409 OWNER_EXISTS forever (the PR #374 guard).
 * A wizard that re-presents this step (reboot mid-setup, claim re-entered)
 * used to dead-end on a form that could never succeed; it now switches to a
 * sign-in variant so the owner proves the password they already chose and
 * setup continues.
 */
describe("AccountStep — owner already exists (WARP-867)", () => {
  const ownerExistsErr = () => {
    const e = new Error("Setup has already been completed for this appliance.") as Error & {
      code?: string;
    };
    e.code = "OWNER_EXISTS";
    return e;
  };

  it("flips to the sign-in variant when create comes back OWNER_EXISTS, keeping the email", async () => {
    setupAdmin.mockRejectedValueOnce(ownerExistsErr());
    render(<AccountStep onComplete={vi.fn()} />);
    fill("scruceru@warp-lab.ai", "Warp123!@#xy");
    fireEvent.click(cta());

    // The step re-frames as a sign-in, not an error dead-end.
    expect(await screen.findByText(/welcome back/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in & continue/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/email and password you chose earlier/i),
    ).toBeInTheDocument();
    // The 409's scary message is NOT rendered as an error.
    expect(
      screen.queryByText(/already been completed/i),
    ).not.toBeInTheDocument();
    // The typed email survives the mode switch.
    expect(screen.getByPlaceholderText(/you@company\.com/i)).toHaveValue(
      "scruceru@warp-lab.ai",
    );
  });

  it("signs the existing owner in and continues the wizard with their display name", async () => {
    setupAdmin.mockRejectedValueOnce(ownerExistsErr());
    const onComplete = vi.fn();
    render(<AccountStep onComplete={onComplete} />);
    fill("scruceru@warp-lab.ai", "Warp123!@#xy");
    fireEvent.click(cta());
    await screen.findByText(/welcome back/i);

    fireEvent.change(screen.getByPlaceholderText(/your password/i), {
      target: { value: "Warp123!@#xy" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /sign in & continue/i }),
    );

    await waitFor(() =>
      expect(loginUser).toHaveBeenCalledWith(
        "scruceru@warp-lab.ai",
        "Warp123!@#xy",
      ),
    );
    // Continues with the SERVER's display name (local field was never filled).
    expect(onComplete).toHaveBeenCalledWith("Stefan");
    // The create-only API was called exactly once (the refused attempt).
    expect(setupAdmin).toHaveBeenCalledTimes(1);
    // Sign-in mode adopts the session into the auth context too.
    expect(setUserFromPasskey).toHaveBeenCalledWith(
      expect.objectContaining({ username: "stefan" }),
    );
  });

  it("renders the sign-in variant proactively when the probe says setup is complete", async () => {
    checkSetupRequired.mockResolvedValue("complete");
    render(<AccountStep onComplete={vi.fn()} />);
    expect(await screen.findByText(/welcome back/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create account/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the create form on an indeterminate probe (fail toward first-run)", async () => {
    checkSetupRequired.mockResolvedValue("unknown");
    render(<AccountStep onComplete={vi.fn()} />);
    // Give the probe's then() a tick to (not) flip the mode.
    await waitFor(() => expect(checkSetupRequired).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: /create account/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
  });

  it("shows a wrong-password error in sign-in mode without leaving the wizard", async () => {
    checkSetupRequired.mockResolvedValue("complete");
    loginUser.mockRejectedValueOnce(new Error("Invalid credentials"));
    render(<AccountStep onComplete={vi.fn()} />);
    await screen.findByText(/welcome back/i);

    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
      target: { value: "scruceru@warp-lab.ai" },
    });
    fireEvent.change(screen.getByPlaceholderText(/your password/i), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /sign in & continue/i }),
    );

    // The friendly INVALID_CREDENTIALS copy renders inline; the sign-in form
    // stays (no mode flip, no navigation away).
    expect(
      await screen.findByText(/username or password didn't match/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in & continue/i }),
    ).toBeInTheDocument();
  });
});

/**
 * WARP-165 — physical-presence claim-code field. When the orchestrator's
 * claim gate is ON (checkClaimGateEnabled → true), the create-account form
 * shows a "Claim code" field and POST /auth/setup requires it. When OFF (the
 * default), the field is absent and setup is unchanged.
 */
describe("AccountStep — claim-code gate field (WARP-165)", () => {
  const claimInput = () => screen.getByPlaceholderText(/DRPL-/i);

  it("does NOT render the claim-code field when the gate is off (default)", async () => {
    render(<AccountStep onComplete={vi.fn()} />);
    await waitFor(() => expect(checkClaimGateEnabled).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText(/DRPL-/i)).not.toBeInTheDocument();
    // And setup is still called with no claim code (the un-gated 3-arg shape).
    fill("scruceru@warp-lab.ai", "Warp123!@#xy");
    fireEvent.click(cta());
    await waitFor(() =>
      expect(setupAdmin).toHaveBeenCalledWith(
        "scruceru@warp-lab.ai",
        "Warp123!@#xy",
        undefined,
      ),
    );
  });

  it("renders the claim-code field when the gate is on, with a front-panel hint", async () => {
    checkClaimGateEnabled.mockResolvedValue(true);
    render(<AccountStep onComplete={vi.fn()} />);
    expect(await screen.findByPlaceholderText(/DRPL-/i)).toBeInTheDocument();
    // The hint tells the user where the code comes from.
    expect(screen.getByText(/front panel/i)).toBeInTheDocument();
  });

  it("keeps the CTA disabled until a claim code is entered when the gate is on", async () => {
    checkClaimGateEnabled.mockResolvedValue(true);
    render(<AccountStep onComplete={vi.fn()} />);
    await screen.findByPlaceholderText(/DRPL-/i);

    // A fully valid email + password is NOT enough while the code is empty.
    fill("scruceru@warp-lab.ai", "Warp123!@#xy");
    expect(cta()).toBeDisabled();

    fireEvent.change(claimInput(), { target: { value: "DRPL-7K2Q-9F4M" } });
    expect(cta()).toBeEnabled();
  });

  it("sends the claim code to setupAdmin when the gate is on", async () => {
    checkClaimGateEnabled.mockResolvedValue(true);
    render(<AccountStep onComplete={vi.fn()} />);
    await screen.findByPlaceholderText(/DRPL-/i);

    fill("scruceru@warp-lab.ai", "Warp123!@#xy");
    fireEvent.change(claimInput(), { target: { value: "DRPL-7K2Q-9F4M" } });
    fireEvent.click(cta());

    await waitFor(() =>
      expect(setupAdmin).toHaveBeenCalledWith(
        "scruceru@warp-lab.ai",
        "Warp123!@#xy",
        undefined,
        "DRPL-7K2Q-9F4M",
      ),
    );
  });

  it("surfaces a friendly error if the claim code is rejected by the server", async () => {
    checkClaimGateEnabled.mockResolvedValue(true);
    const err = new Error("claim invalid") as Error & { code?: string };
    err.code = "CLAIM_CODE_INVALID";
    setupAdmin.mockRejectedValueOnce(err);
    render(<AccountStep onComplete={vi.fn()} />);
    await screen.findByPlaceholderText(/DRPL-/i);

    fill("scruceru@warp-lab.ai", "Warp123!@#xy");
    fireEvent.change(claimInput(), { target: { value: "DRPL-WRON-GGGG" } });
    fireEvent.click(cta());

    expect(await screen.findByText(/claim code/i)).toBeInTheDocument();
    // The raw cause is never shown.
    expect(screen.queryByText(/^claim invalid$/i)).not.toBeInTheDocument();
  });
});
