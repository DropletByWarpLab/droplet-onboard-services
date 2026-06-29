import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * PR #375 (login UI) — the dashboard login must complete the orchestrator's
 * two-factor gate. When a correct password comes back as TOTP_REQUIRED the page
 * reveals a code field and re-submits with the entered code; it must NOT
 * dead-end on the "check your username and password" copy (the bug: a 2FA-
 * enrolled owner was locked out with no way to enter their code).
 *
 * Mirrors login.errors.test.tsx: real LoginPage, useAuth + next/navigation
 * mocked. The page dispatches on the typed `code: "TOTP_REQUIRED"` (not
 * `instanceof`), so the gate is reproduced with a plain coded error.
 */

const { loginMock } = vi.hoisted(() => ({ loginMock: vi.fn() }));

/** The orchestrator's second-factor gate (PR #375): 401 with this code. */
function totpRequired(): Error {
  return Object.assign(new Error("Two-factor authentication required"), {
    code: "TOTP_REQUIRED",
    status: 401,
  });
}

const pushMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ login: loginMock, setUserFromPasskey: vi.fn() }),
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>(
    "next/navigation",
  );
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(""),
    usePathname: () => "/login",
  };
});

import LoginPage from "@/app/login/page";

function signInWith(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Work email"), {
    target: { value: email },
  });
  fireEvent.change(screen.getByPlaceholderText("Password"), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
}

describe("LoginPage — two-factor challenge (PR #375)", () => {
  beforeEach(() => {
    loginMock.mockReset();
    pushMock.mockReset();
  });

  it("reveals the code field on TOTP_REQUIRED, with no error shown", async () => {
    loginMock.mockRejectedValueOnce(totpRequired());
    render(<LoginPage />);

    signInWith("alice@acme.co", "hunter2-correct");

    // The 6-digit code field appears…
    await waitFor(() => {
      expect(screen.getByLabelText(/6-digit code/i)).toBeInTheDocument();
    });
    // …and we do NOT mislead the user — the password was correct.
    expect(
      screen.queryByText(/check your username and password/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^verify$/i })).toBeInTheDocument();
  });

  it("re-submits the same credentials plus the entered code, then navigates", async () => {
    loginMock
      .mockRejectedValueOnce(totpRequired()) // first: password only
      .mockResolvedValueOnce(undefined); // second: with code → success
    render(<LoginPage />);

    signInWith("alice@acme.co", "hunter2-correct");
    await screen.findByLabelText(/6-digit code/i);

    fireEvent.change(screen.getByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/");
    });
    // Password-only first call stays 2-arg; the challenge call carries the code.
    expect(loginMock).toHaveBeenNthCalledWith(1, "alice@acme.co", "hunter2-correct");
    expect(loginMock).toHaveBeenNthCalledWith(2, "alice@acme.co", "hunter2-correct", {
      totp: "123456",
    });
  });

  it("non-digits are stripped from the authenticator code", async () => {
    loginMock
      .mockRejectedValueOnce(totpRequired())
      .mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    signInWith("alice@acme.co", "pw");
    await screen.findByLabelText(/6-digit code/i);

    fireEvent.change(screen.getByLabelText(/6-digit code/i), {
      target: { value: "12ab34cd" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenNthCalledWith(2, "alice@acme.co", "pw", {
        totp: "1234",
      });
    });
  });

  it("a wrong code (second TOTP_REQUIRED) shows an actionable error, stays on the step", async () => {
    loginMock
      .mockRejectedValueOnce(totpRequired()) // reveal field
      .mockRejectedValueOnce(totpRequired()); // wrong code
    render(<LoginPage />);

    signInWith("alice@acme.co", "pw");
    await screen.findByLabelText(/6-digit code/i);

    fireEvent.change(screen.getByLabelText(/6-digit code/i), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      expect(screen.getByText(/that code didn't match/i)).toBeInTheDocument();
    });
    // Still on the challenge step (no navigation).
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^verify$/i })).toBeInTheDocument();
  });

  it("can switch to a recovery code and submits it under recoveryCode", async () => {
    loginMock
      .mockRejectedValueOnce(totpRequired())
      .mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    signInWith("alice@acme.co", "pw");
    await screen.findByLabelText(/6-digit code/i);

    fireEvent.click(
      screen.getByRole("button", { name: /use a recovery code instead/i }),
    );

    fireEvent.change(screen.getByLabelText(/recovery code/i), {
      target: { value: "abcde-fghij" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenNthCalledWith(2, "alice@acme.co", "pw", {
        recoveryCode: "abcde-fghij",
      });
    });
  });

  it("'Use a different account' abandons the challenge back to credentials", async () => {
    loginMock.mockRejectedValueOnce(totpRequired());
    render(<LoginPage />);

    signInWith("alice@acme.co", "pw");
    await screen.findByLabelText(/6-digit code/i);

    fireEvent.click(
      screen.getByRole("button", { name: /use a different account/i }),
    );

    // Back to the email/password step.
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/6-digit code/i)).not.toBeInTheDocument();
  });

  it("a genuinely wrong password still shows the translated credential error", async () => {
    loginMock.mockRejectedValueOnce(
      Object.assign(new Error("Invalid credentials"), { status: 401 }),
    );
    render(<LoginPage />);

    signInWith("alice@acme.co", "wrong");

    await waitFor(() => {
      expect(screen.getByText(/didn't match\.|try again/i)).toBeInTheDocument();
    });
    // No 2FA field for a bad password.
    expect(screen.queryByLabelText(/6-digit code/i)).not.toBeInTheDocument();
  });
});
