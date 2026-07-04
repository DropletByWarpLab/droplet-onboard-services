/**
 * WARP-1054 — the login page's "Sign in with a passkey" button.
 *
 * As of WARP-1054 the button no longer runs the WebAuthn ceremony inline (which
 * stranded the user on the unchanged login form). It NAVIGATES to the dedicated
 * `/login/passkey` approval page, carrying `?next=` through. The ceremony /
 * state-machine behaviour is covered by login-passkey-page.test.tsx.
 *
 *   - When passkeys are supported, the login page renders the secondary
 *     "Sign in with a passkey" action.
 *   - Clicking it pushes `/login/passkey` (with `?next=` when present).
 *   - When the browser can't do WebAuthn the affordance is hidden.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const loginMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ login: loginMock }),
}));

const isPasskeySupported = vi.fn();
vi.mock("@/lib/webauthn", () => ({
  isPasskeySupported: (...a: unknown[]) => isPasskeySupported(...a),
}));

// Local-first, password-only: no SSO configured (discovery covered elsewhere).
vi.mock("@/lib/api", () => ({
  getEnabledSsoProviders: () => Promise.resolve([]),
}));

const pushMock = vi.fn();
let searchString = "";
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(searchString),
    usePathname: () => "/login",
  };
});

import LoginPage from "@/app/login/page";

describe("LoginPage — passkey button (WARP-1054)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPasskeySupported.mockReturnValue(true);
    searchString = "";
  });

  it("renders the passkey action when supported", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /passkey/i })).toBeInTheDocument();
  });

  it("hides the passkey action when the browser can't do WebAuthn", () => {
    isPasskeySupported.mockReturnValue(false);
    render(<LoginPage />);
    expect(
      screen.queryByRole("button", { name: /passkey/i }),
    ).not.toBeInTheDocument();
  });

  it("navigates to the dedicated approval page (no inline ceremony)", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /passkey/i }));

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/login/passkey");
    // Password login was NOT used.
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("carries a present ?next= through to the approval page (encoded)", () => {
    searchString = "next=/files";
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /passkey/i }));

    expect(pushMock).toHaveBeenCalledWith("/login/passkey?next=%2Ffiles");
  });

  it("does not append a next param when none is present", () => {
    searchString = "";
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /passkey/i }));

    expect(pushMock).toHaveBeenCalledWith("/login/passkey");
  });
});
