/**
 * WARP-668 — the password requirements must be STATED UP FRONT at account
 * creation, not discovered by failing the disabled CTA. AccountStep now shows
 * an always-visible hint at the Password field (derived from PASSWORD_MIN so it
 * can't drift), tied to the input via aria-describedby. The live checklist
 * below still tracks progress; this pins the proactive field hint.
 *
 * (Separate file name from steps/AccountStep.test.tsx so it can't collide with
 * the in-review WARP-666 / PR #502 work on the same component.)
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AccountStep } from "@/components/setup/steps/AccountStep";

vi.mock("@/lib/api", () => ({
  setupAdmin: vi.fn(),
  loginUser: vi.fn(),
  // WARP-867 — the step probes setup status on mount to pick its mode;
  // "required" keeps these tests on the create form they assert.
  checkSetupRequired: vi.fn(async () => "required"),
}));

describe("AccountStep — password requirement stated up front (WARP-668)", () => {
  it("states the 12-char minimum at the password field before the user types", () => {
    render(<AccountStep onComplete={vi.fn()} />);

    // Always-visible on first render — no typing, no failed submit needed.
    const hint = screen.getByText(/use at least 12 characters/i);
    expect(hint).toBeInTheDocument();

    // And it's wired to the password input for assistive tech.
    expect(hint).toHaveAttribute("id", "account-password-hint");
    expect(screen.getByPlaceholderText("Create a password")).toHaveAttribute(
      "aria-describedby",
      "account-password-hint",
    );
  });

  it("derives the number from the policy (12), keeping it in sync with the rule", () => {
    render(<AccountStep onComplete={vi.fn()} />);
    // The same minimum the live checklist rule now states ("At least 12 characters").
    expect(screen.getByText(/use at least 12 characters/i)).toBeInTheDocument();
    expect(screen.getByText(/^At least 12 characters$/)).toBeInTheDocument();
  });
});
