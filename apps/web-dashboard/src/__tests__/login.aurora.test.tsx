import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Aurora sign-in — composition, gated methods, and submit wiring.
 * (Friendly-error translation is covered separately in login.errors.test.tsx.)
 */

const loginMock = vi.fn();
const pushMock = vi.fn();
let searchString = "";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ login: loginMock }),
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>(
    "next/navigation",
  );
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(searchString),
    usePathname: () => "/login",
  };
});

import LoginPage from "@/app/login/page";

describe("Aurora LoginPage", () => {
  beforeEach(() => {
    loginMock.mockReset();
    pushMock.mockReset();
    searchString = "";
  });

  it("renders the brand hero and the sign-in form", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("heading", { name: /on your premises/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /welcome back/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
  });

  it("renders SSO and passkey as disabled until their backends ship", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /continue with microsoft/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /continue with okta/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /security key or passkey/i }),
    ).toBeDisabled();
  });

  it("submits email + password to login() and routes home on success", async () => {
    loginMock.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "stefan@acme.co" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith("stefan@acme.co", "hunter2"),
    );
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("honours a safe ?next= redirect after login", async () => {
    searchString = "next=/files";
    loginMock.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "stefan@acme.co" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/files"));
  });

  it("ignores an off-origin ?next= (no open redirect)", async () => {
    searchString = "next=//evil.example.com";
    loginMock.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "stefan@acme.co" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
  });

  it("validates locally and does not call login when fields are empty", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(loginMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/enter your work email and password/i),
    ).toBeInTheDocument();
  });

  it("shows the post-setup confirmation chip when ?from=setup", () => {
    searchString = "from=setup";
    render(<LoginPage />);
    expect(
      screen.getByText(/setup already completed/i),
    ).toBeInTheDocument();
  });
});
