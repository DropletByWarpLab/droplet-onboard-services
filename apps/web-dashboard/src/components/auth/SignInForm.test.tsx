/**
 * ADR-013 (PR #378) — Aurora login SSO wiring.
 *
 * Google + Microsoft (Entra) ship their OIDC backend in this PR, so their
 * buttons go LIVE: each is a full-page form POST to /api/sso/oidc/authorize
 * (a fetch can't follow the cross-origin redirect to the IdP). Okta's
 * backend lands separately, so its button stays the disabled "Soon" pill —
 * no dead button that 404s.
 *
 * These tests pin the wiring contract (action / method / provider /
 * returnTo) and the live-vs-disabled split, without standing up a real IdP.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SignInForm, type SignInFormProps } from "./SignInForm";

const noopProps: SignInFormProps = {
  email: "",
  password: "",
  showPassword: false,
  onEmailChange: () => {},
  onPasswordChange: () => {},
  onTogglePassword: () => {},
  onSubmit: () => {},
  error: null,
  submitting: false,
};

function renderForm(over: Partial<SignInFormProps> = {}) {
  return render(<SignInForm {...noopProps} {...over} />);
}

describe("SignInForm — live SSO providers (Google + Entra)", () => {
  it("renders Google as a form POST to the authorize endpoint with provider=google", () => {
    renderForm();
    const button = screen.getByRole("button", { name: /continue with google/i });
    expect(button).toBeEnabled();
    const form = button.closest("form");
    expect(form).not.toBeNull();
    expect(form!.getAttribute("action")).toBe("/api/sso/oidc/authorize");
    expect(form!.getAttribute("method")?.toLowerCase()).toBe("post");
    const provider = within(form!).getByDisplayValue("google");
    expect(provider).toHaveAttribute("name", "provider");
    expect(provider.getAttribute("type")).toBe("hidden");
  });

  it("renders Microsoft as a form POST with provider=entra (wire label → entra)", () => {
    renderForm();
    const button = screen.getByRole("button", { name: /continue with microsoft/i });
    expect(button).toBeEnabled();
    const form = button.closest("form")!;
    expect(form.getAttribute("action")).toBe("/api/sso/oidc/authorize");
    // The UI label is "Microsoft" but the orchestrator provider id is "entra".
    expect(within(form).getByDisplayValue("entra")).toHaveAttribute("name", "provider");
  });

  it("forwards a same-origin returnTo so SSO lands on the originally-requested page", () => {
    renderForm({ returnTo: "/files" });
    const button = screen.getByRole("button", { name: /continue with google/i });
    const form = button.closest("form")!;
    const returnTo = within(form).getByDisplayValue("/files");
    expect(returnTo).toHaveAttribute("name", "returnTo");
    expect(returnTo.getAttribute("type")).toBe("hidden");
  });

  it("omits the returnTo input when no returnTo is provided (defaults to / server-side)", () => {
    renderForm();
    const form = screen.getByRole("button", { name: /continue with google/i }).closest("form")!;
    expect(within(form).queryByDisplayValue("/")).toBeNull();
  });
});

describe("SignInForm — Okta is now LIVE (backend shipped in this PR)", () => {
  it("renders Okta as a form POST to the authorize endpoint with provider=okta (no dead button)", () => {
    renderForm();
    const button = screen.getByRole("button", { name: /continue with okta/i });
    expect(button).toBeEnabled();
    const form = button.closest("form");
    expect(form).not.toBeNull();
    expect(form!.getAttribute("action")).toBe("/api/sso/oidc/authorize");
    expect(form!.getAttribute("method")?.toLowerCase()).toBe("post");
    const provider = within(form!).getByDisplayValue("okta");
    expect(provider).toHaveAttribute("name", "provider");
    expect(provider.getAttribute("type")).toBe("hidden");
    // No longer the disabled "Soon" pill.
    expect(button).not.toHaveTextContent(/soon/i);
  });

  it("forwards returnTo on the Okta button too", () => {
    renderForm({ returnTo: "/files" });
    const form = screen.getByRole("button", { name: /continue with okta/i }).closest("form")!;
    expect(within(form).getByDisplayValue("/files")).toHaveAttribute("name", "returnTo");
  });
});

describe("SignInForm — directory password path unchanged", () => {
  it("still renders the work-email + password fields and the Sign in button", () => {
    renderForm();
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
  });
});
