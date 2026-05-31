/**
 * PR #372 — AuthGate routes off the explicit `/setup/state` machine, not
 * the legacy boolean `setupRequired`.
 *
 * Behavioural test (renders AuthGate with a mocked `useAuth` + mocked
 * next/navigation) — deliberately NOT a readFileSync source-scrape, which
 * is both brittle and broken on Windows (import.meta.url → `C:\C:\...`).
 *
 * Contract (docs/ONBOARDING_STATE_MACHINE.md):
 *   appliance "unclaimed"          → wizard (/setup)
 *   appliance "ready" + user       → dashboard
 *   appliance "ready", on /setup   → bounce off the wizard (setup is done)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const replaceMock = vi.fn();
let pathnameValue = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
  usePathname: () => pathnameValue,
}));

// Sidebar pulls in a wide provider tree; stub it to a marker so AuthGate's
// authenticated branch renders in isolation.
vi.mock("@/components/Sidebar", () => ({
  Sidebar: () => null,
}));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
}));

import { AuthGate } from "@/components/AuthGate";

function setAuth(value: Record<string, unknown>) {
  useAuthMock.mockReturnValue(value);
}

describe("AuthGate — routes off /setup/state (PR #372)", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    useAuthMock.mockReset();
    pathnameValue = "/";
  });

  it("redirects to /setup when the appliance is unclaimed", () => {
    setAuth({
      user: null,
      isLoading: false,
      setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/setup");
  });

  it("does NOT redirect to /setup once the appliance is ready", () => {
    pathnameValue = "/";
    setAuth({
      user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" },
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: true },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalledWith("/setup");
  });

  it("bounces off /setup to login when the appliance is already ready", () => {
    pathnameValue = "/setup";
    setAuth({
      user: null,
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: false },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/login?from=setup");
  });

  it("waits while loading — no redirect decided yet", () => {
    setAuth({ user: null, isLoading: true, setupState: null });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("sends an unauthenticated user on a ready appliance to /login", () => {
    pathnameValue = "/devices";
    setAuth({
      user: null,
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: true },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });
});
