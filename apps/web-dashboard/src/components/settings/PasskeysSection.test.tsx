/**
 * PR #377 (WARP-___) — Settings "Passkeys" section.
 *
 * The in-product home for enrolling a passkey (the AC allows Account-step OR
 * settings; settings is chosen because the wizard's AccountStep auto-advances
 * and enrolment is optional). Scope is REGISTER only — listing/revoking
 * passkeys is a follow-up (no GET/DELETE endpoint in this PR).
 *
 *   - Renders an "Add a passkey" action when WebAuthn is supported.
 *   - Clicking it runs registerPasskey and shows a success confirmation.
 *   - A failed enrolment shows a friendly error, never the raw ceremony error.
 *   - When WebAuthn is unsupported, the action is replaced by an explanatory
 *     unsupported note (no dead button).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const registerPasskey = vi.fn();
const isPasskeySupported = vi.fn();
vi.mock("@/lib/webauthn", () => ({
  registerPasskey: (...a: unknown[]) => registerPasskey(...a),
  isPasskeySupported: (...a: unknown[]) => isPasskeySupported(...a),
}));

import { PasskeysSection } from "./PasskeysSection";

describe("PasskeysSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPasskeySupported.mockReturnValue(true);
  });

  it("renders the add-a-passkey action when supported", () => {
    render(<PasskeysSection />);
    expect(screen.getByRole("button", { name: /add a passkey/i })).toBeInTheDocument();
  });

  it("enrols a passkey and shows a success confirmation", async () => {
    registerPasskey.mockResolvedValueOnce(undefined);
    render(<PasskeysSection />);

    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }));

    await waitFor(() => expect(registerPasskey).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByText(/passkey added|registered/i)).toBeInTheDocument();
    });
  });

  it("shows a friendly error and never echoes the raw ceremony failure", async () => {
    const SECRET = "NotAllowedError: user cancelled ECONNREFUSED";
    registerPasskey.mockRejectedValueOnce(new Error(SECRET));
    render(<PasskeysSection />);

    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/couldn't add|try again/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("shows an unsupported note instead of a dead button when WebAuthn is unavailable", () => {
    isPasskeySupported.mockReturnValue(false);
    render(<PasskeysSection />);
    expect(screen.queryByRole("button", { name: /add a passkey/i })).not.toBeInTheDocument();
    expect(screen.getByText(/doesn't support passkeys|not supported/i)).toBeInTheDocument();
  });
});
