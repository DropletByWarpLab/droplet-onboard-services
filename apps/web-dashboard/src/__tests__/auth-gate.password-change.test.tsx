/**
 * WARP-824 — AuthGate routes a forced-change user to /change-password and
 * keeps them there until the flag clears.
 *
 * Behavioural test (mirrors auth-gate.routing.test.tsx): renders AuthGate with
 * a mocked useAuth + mocked next/navigation. The forced-change screen is a
 * full-screen authenticated takeover, like /tour — gated on `user` and routed
 * by `user.mustChangePassword`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const replaceMock = vi.fn();
let pathnameValue = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
  usePathname: () => pathnameValue,
}));

vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

import { AuthGate } from "@/components/AuthGate";

function setAuth(value: Record<string, unknown>) {
  useAuthMock.mockReturnValue(value);
}

const readyState = { appliance: "ready", setupStep: "done", userTourCompleted: true };

beforeEach(() => {
  replaceMock.mockReset();
  useAuthMock.mockReset();
  pathnameValue = "/";
});

describe("AuthGate — forced password change (WARP-824)", () => {
  it("redirects a must-change user from a protected page to /change-password", () => {
    pathnameValue = "/devices";
    setAuth({
      user: { id: "u1", username: "kid", displayName: "Kid", role: "family", mustChangePassword: true },
      isLoading: false,
      setupState: readyState,
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/change-password");
  });

  it("keeps the must-change user on /change-password (no bounce to dashboard)", () => {
    pathnameValue = "/change-password";
    setAuth({
      user: { id: "u1", username: "kid", displayName: "Kid", role: "family", mustChangePassword: true },
      isLoading: false,
      setupState: readyState,
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalledWith("/");
    expect(replaceMock).not.toHaveBeenCalledWith("/change-password");
  });

  it("does NOT route a normal user to /change-password", () => {
    pathnameValue = "/";
    setAuth({
      user: { id: "u1", username: "ada", displayName: "Ada", role: "owner", mustChangePassword: false },
      isLoading: false,
      setupState: readyState,
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalledWith("/change-password");
  });

  it("bounces a user OFF /change-password once the flag is cleared", () => {
    pathnameValue = "/change-password";
    setAuth({
      user: { id: "u1", username: "kid", displayName: "Kid", role: "family", mustChangePassword: false },
      isLoading: false,
      setupState: readyState,
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/");
  });

  it("forced change takes precedence over the post-setup tour", () => {
    // A must-change user who also hasn't seen the tour goes to the password
    // change FIRST — they can't do anything else until the temp password is
    // replaced.
    pathnameValue = "/";
    setAuth({
      user: { id: "u1", username: "kid", displayName: "Kid", role: "family", mustChangePassword: true },
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: false },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/change-password");
    expect(replaceMock).not.toHaveBeenCalledWith("/tour");
  });

  it("an unauthenticated user is still sent to /login, not /change-password", () => {
    pathnameValue = "/devices";
    setAuth({ user: null, isLoading: false, setupState: readyState });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/login");
    expect(replaceMock).not.toHaveBeenCalledWith("/change-password");
  });
});
