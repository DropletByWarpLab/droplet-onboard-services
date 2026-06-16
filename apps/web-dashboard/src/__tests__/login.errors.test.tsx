import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * WARP-294 — Login page must translate auth errors through
 * friendly-errors, never render `err.message` verbatim.
 */

const loginMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ login: loginMock }),
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>(
    "next/navigation",
  );
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(""),
    usePathname: () => "/login",
  };
});

import LoginPage from "@/app/login/page";

describe("LoginPage — typed error → friendly copy (WARP-294)", () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  it("renders a friendly translated string and never echoes err.message", async () => {
    const SECRET = "OCS 401 connect ECONNREFUSED";
    loginMock.mockRejectedValueOnce(
      Object.assign(new Error(SECRET), { status: 401 }),
    );

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "alice@acme.co" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/didn't match\.|try again/i),
      ).toBeInTheDocument();
    });

    // Defense in depth: raw err.message must NOT be in the rendered DOM.
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByText(/OCS/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });
});
