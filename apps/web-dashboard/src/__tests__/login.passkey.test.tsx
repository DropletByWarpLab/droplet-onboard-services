/**
 * PR #377 (WARP-___) — login page "Sign in with a passkey" path.
 *
 *   - When passkeys are supported, the login page renders a secondary
 *     "Sign in with a passkey" action.
 *   - Clicking it runs signInWithPasskey, hydrates the auth context with the
 *     returned user, and routes home — no password required (passwordless).
 *   - A failed/cancelled ceremony surfaces a FRIENDLY translated message, never
 *     the raw error (consistent with the password path's WARP-294 posture).
 *   - When the browser can't do WebAuthn the affordance is hidden.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const loginMock = vi.fn();
const setUserMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ login: loginMock, setUserFromPasskey: setUserMock }),
}));

const signInWithPasskey = vi.fn();
const isPasskeySupported = vi.fn();
vi.mock("@/lib/webauthn", () => ({
  signInWithPasskey: (...a: unknown[]) => signInWithPasskey(...a),
  isPasskeySupported: (...a: unknown[]) => isPasskeySupported(...a),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(""),
    usePathname: () => "/login",
  };
});

import LoginPage from "@/app/login/page";

describe("LoginPage — passkey sign-in (PR #377)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPasskeySupported.mockReturnValue(true);
  });

  it("renders the passkey action when supported", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /passkey/i })).toBeInTheDocument();
  });

  it("hides the passkey action when the browser can't do WebAuthn", () => {
    isPasskeySupported.mockReturnValue(false);
    render(<LoginPage />);
    expect(screen.queryByRole("button", { name: /passkey/i })).not.toBeInTheDocument();
  });

  it("signs in passwordlessly and routes home on success", async () => {
    const user = { id: "u-1", username: "stefan", displayName: "Stefan", role: "owner" as const };
    signInWithPasskey.mockResolvedValueOnce(user);

    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /passkey/i }));

    await waitFor(() => expect(signInWithPasskey).toHaveBeenCalledTimes(1));
    expect(setUserMock).toHaveBeenCalledWith(user);
    expect(pushMock).toHaveBeenCalledWith("/");
    // Password login was NOT used.
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("shows a friendly error and never echoes the raw failure", async () => {
    const SECRET = "NotAllowedError: ceremony aborted ECONNREFUSED";
    signInWithPasskey.mockRejectedValueOnce(new Error(SECRET));

    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/passkey|try again|didn't work/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });
});
