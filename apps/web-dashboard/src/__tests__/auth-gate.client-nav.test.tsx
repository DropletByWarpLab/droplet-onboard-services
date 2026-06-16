/**
 * fix/dashboard-shell-loading — AC #3/#5(c): client-side navigation renders
 * the target page's content without a manual refresh.
 *
 * The reported #2 symptom ("clicking a new page needs a refresh before content
 * shows") shares #1's root cause: AuthGate gated the WHOLE app — every route,
 * on every SPA boot — behind `isLoading`, which only cleared after init()'s two
 * serial, un-timed probes. Once `isLoading` is false, an authenticated user
 * navigating between protected routes must see the new page's children
 * immediately (the App Router swaps the page segment; AuthGate re-renders off
 * the new pathname). This test pins that: a pathname change from / to /devices
 * with a settled, authenticated session renders the new content and fires no
 * redirect.
 *
 * Mirrors auth-gate.routing.test.tsx (mocked useAuth + next/navigation,
 * Sidebar stubbed).
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

const READY_OWNER = {
  user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" as const },
  isLoading: false,
  setupState: { appliance: "ready" as const, setupStep: "done", userTourCompleted: true },
  setupProbeError: null,
  retrySetupProbe: vi.fn(),
};

beforeEach(() => {
  replaceMock.mockReset();
  useAuthMock.mockReset();
  pathnameValue = "/";
});

describe("AuthGate — protected page renders on client navigation", () => {
  it("renders the target protected page's content after a pathname change (no refresh)", () => {
    useAuthMock.mockReturnValue(READY_OWNER);

    const { rerender, getByText, queryByText } = render(
      <AuthGate>
        <div>HOME CONTENT</div>
      </AuthGate>,
    );
    expect(getByText("HOME CONTENT")).toBeInTheDocument();

    // Simulate a client-side nav: the App Router updates usePathname() and
    // swaps the page segment passed as children.
    pathnameValue = "/devices";
    rerender(
      <AuthGate>
        <div>DEVICES CONTENT</div>
      </AuthGate>,
    );

    expect(getByText("DEVICES CONTENT")).toBeInTheDocument();
    expect(queryByText("Loading...")).toBeNull();
    // No bounce — an authed user moving between protected routes stays put.
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
