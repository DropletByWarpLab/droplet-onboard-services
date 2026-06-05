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
vi.mock("@/lib/api", () => ({
  setupAdmin: (...a: unknown[]) => setupAdmin(...a),
  loginUser: (...a: unknown[]) => loginUser(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  setupAdmin.mockResolvedValue(undefined);
  loginUser.mockResolvedValue({
    user: { id: "1", username: "stefan", displayName: "Stefan" },
  });
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
