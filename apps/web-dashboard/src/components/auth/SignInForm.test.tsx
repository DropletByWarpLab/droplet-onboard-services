/**
 * WARP-629 — Aurora login SSO is RUNTIME-DISCOVERED, local-first.
 *
 * SignInForm no longer reads a build-time flag for which IdPs to show. The
 * login page fetches GET /api/sso/oidc/providers and passes the live list down
 * as `ssoProviders`; SignInForm renders one live `SsoProviderButton` per
 * discovered provider — in the canonical order google → entra → okta — and
 * NOTHING for the rest. No "Soon" pill for SSO, no dead buttons, and no SSO
 * section / "OR USE YOUR DIRECTORY ACCOUNT" divider when the list is empty.
 *
 * These tests pin (a) the empty-list local-first shape, (b) the per-provider
 * form-POST wiring contract (action / method / provider / returnTo), and (c)
 * canonical ordering + unknown-id filtering — without standing up a real IdP.
 * (Superseded the ADR-013 static-flag suite, which asserted all three buttons
 * always rendered live regardless of what the box had configured.)
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
  ssoProviders: [],
};

function renderForm(over: Partial<SignInFormProps> = {}) {
  return render(<SignInForm {...noopProps} {...over} />);
}

describe("SignInForm — empty discovery is password-only (local-first)", () => {
  it("renders no SSO buttons and no directory divider when ssoProviders is empty", () => {
    renderForm({ ssoProviders: [] });
    expect(
      screen.queryByRole("button", { name: /continue with/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/or use your directory account/i),
    ).not.toBeInTheDocument();
  });

  it("still renders the work-email + password fields and the Sign in button", () => {
    renderForm({ ssoProviders: [] });
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
  });

  it("never renders a disabled SSO 'Soon' pill", () => {
    renderForm({ ssoProviders: [] });
    expect(screen.queryByText(/soon/i)).not.toBeInTheDocument();
  });
});

describe("SignInForm — discovered providers render as live form POSTs", () => {
  it("renders Google as a form POST to the authorize endpoint with provider=google", () => {
    renderForm({ ssoProviders: ["google"] });
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
    renderForm({ ssoProviders: ["entra"] });
    const button = screen.getByRole("button", { name: /continue with microsoft/i });
    expect(button).toBeEnabled();
    const form = button.closest("form")!;
    expect(form.getAttribute("action")).toBe("/api/sso/oidc/authorize");
    // The UI label is "Microsoft" but the orchestrator provider id is "entra".
    expect(within(form).getByDisplayValue("entra")).toHaveAttribute("name", "provider");
  });

  it("renders Okta as a form POST with provider=okta", () => {
    renderForm({ ssoProviders: ["okta"] });
    const button = screen.getByRole("button", { name: /continue with okta/i });
    expect(button).toBeEnabled();
    const form = button.closest("form")!;
    expect(form.getAttribute("action")).toBe("/api/sso/oidc/authorize");
    const provider = within(form).getByDisplayValue("okta");
    expect(provider).toHaveAttribute("name", "provider");
    expect(provider.getAttribute("type")).toBe("hidden");
    expect(button).not.toHaveTextContent(/soon/i);
  });

  it("forwards a same-origin returnTo so SSO lands on the originally-requested page", () => {
    renderForm({ ssoProviders: ["google"], returnTo: "/files" });
    const form = screen.getByRole("button", { name: /continue with google/i }).closest("form")!;
    const returnTo = within(form).getByDisplayValue("/files");
    expect(returnTo).toHaveAttribute("name", "returnTo");
    expect(returnTo.getAttribute("type")).toBe("hidden");
  });

  it("omits the returnTo input when no returnTo is provided (defaults to / server-side)", () => {
    renderForm({ ssoProviders: ["google"] });
    const form = screen.getByRole("button", { name: /continue with google/i }).closest("form")!;
    expect(within(form).queryByDisplayValue("/")).toBeNull();
  });

  it("shows the directory divider once at least one provider is present", () => {
    renderForm({ ssoProviders: ["google"] });
    expect(screen.getByText(/or use your directory account/i)).toBeInTheDocument();
  });
});

describe("SignInForm — canonical ordering + unknown-id filtering", () => {
  it("renders providers in google → entra → okta order regardless of input order", () => {
    renderForm({ ssoProviders: ["okta", "google", "entra"] });
    const labels = screen
      .getAllByRole("button", { name: /continue with/i })
      .map((b) => b.textContent ?? "");
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/google/i);
    expect(labels[1]).toMatch(/microsoft/i);
    expect(labels[2]).toMatch(/okta/i);
  });

  it("ignores an unrecognised provider id (renders only known providers)", () => {
    renderForm({ ssoProviders: ["google", "workday"] });
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /continue with/i }),
    ).toHaveLength(1);
  });

  it("renders every discovered provider as ENABLED (no dead buttons)", () => {
    renderForm({ ssoProviders: ["google", "entra"] });
    for (const b of screen.getAllByRole("button", { name: /continue with/i })) {
      expect(b).toBeEnabled();
    }
  });
});
