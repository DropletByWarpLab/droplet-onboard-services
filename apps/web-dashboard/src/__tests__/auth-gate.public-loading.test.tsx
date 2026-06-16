/**
 * fix/dashboard-shell-loading — public pages (/login, /setup) must render
 * WITHOUT being blocked by the session/setup-state probes.
 *
 * Before the fix, AuthGate's `if (isLoading) return <Loading/>` ran BEFORE the
 * `isPublicPage` check, so /login could not paint until init()'s two serial
 * probes resolved — the "login takes ~5 refreshes" report. This test pins the
 * contract that a public page renders its children even while `isLoading` is
 * true, while a PROTECTED page still shows the spinner (we must not flash
 * protected content before auth resolves — AC #4).
 *
 * Mirrors auth-gate.routing.test.tsx: mocked useAuth + mocked next/navigation,
 * Sidebar stubbed. No source-scrape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const replaceMock = vi.fn();
let pathnameValue = "/login";

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

describe("AuthGate — public pages render under a slow/hung probe", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    useAuthMock.mockReset();
    pathnameValue = "/login";
  });

  it("renders /login children while the probes are still in flight (isLoading=true)", () => {
    pathnameValue = "/login";
    setAuth({
      user: null,
      isLoading: true,
      setupState: null,
      setupProbeError: null,
      retrySetupProbe: vi.fn(),
    });

    const { getByText, queryByText } = render(
      <AuthGate>
        <div>LOGIN FORM</div>
      </AuthGate>,
    );

    // The login form is reachable on first paint — not trapped behind the
    // full-screen spinner.
    expect(getByText("LOGIN FORM")).toBeInTheDocument();
    expect(queryByText("Loading...")).toBeNull();
  });

  it("renders /setup children while isLoading=true", () => {
    pathnameValue = "/setup";
    setAuth({
      user: null,
      isLoading: true,
      setupState: null,
      setupProbeError: null,
      retrySetupProbe: vi.fn(),
    });

    const { getByText } = render(
      <AuthGate>
        <div>WIZARD</div>
      </AuthGate>,
    );
    expect(getByText("WIZARD")).toBeInTheDocument();
  });

  it("STILL shows the spinner on a protected page while isLoading=true (no protected-content flash)", () => {
    pathnameValue = "/devices";
    setAuth({
      user: null,
      isLoading: true,
      setupState: null,
      setupProbeError: null,
      retrySetupProbe: vi.fn(),
    });

    const { getByText, queryByText } = render(
      <AuthGate>
        <div>PROTECTED CONTENT</div>
      </AuthGate>,
    );
    expect(getByText("Loading...")).toBeInTheDocument();
    expect(queryByText("PROTECTED CONTENT")).toBeNull();
  });

  it("does not decide any redirect while isLoading=true on a public page", () => {
    pathnameValue = "/login";
    setAuth({
      user: null,
      isLoading: true,
      setupState: null,
      setupProbeError: null,
      retrySetupProbe: vi.fn(),
    });
    render(
      <AuthGate>
        <div>LOGIN FORM</div>
      </AuthGate>,
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
