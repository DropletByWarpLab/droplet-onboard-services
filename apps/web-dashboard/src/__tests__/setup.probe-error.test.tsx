/**
 * M3 (PR #372 re-review) — the lifecycle probe (`GET /api/setup/state`)
 * must surface an EXPLICIT error + retry instead of failing open silently.
 *
 * Before the fix, a failed probe left `setupState === null`; AuthGate
 * treated that as "not unclaimed" and routed off a guess (bouncing a
 * first-run owner to /login on an unclaimed box) with no signal. This test
 * asserts AuthGate now renders an explicit "can't reach your appliance"
 * surface with a working Retry that re-runs the probe.
 *
 * Behavioural test mirroring auth-gate.routing.test.tsx (mocked `useAuth` +
 * mocked next/navigation) — no source-scrape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

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

describe("AuthGate — M3 probe-error surface", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pathnameValue = "/";
  });

  it("renders an explicit error + retry when the probe failed and state is unknown", () => {
    const retrySetupProbe = vi.fn();
    setAuth({
      user: null,
      isLoading: false,
      setupState: null,
      setupProbeError: "Couldn't reach the appliance to read setup state.",
      retrySetupProbe,
    });

    const { getByText, getByRole } = render(
      <AuthGate>
        <div>protected</div>
      </AuthGate>,
    );

    // Explicit error surface — not a silent route-off-a-guess.
    expect(getByText("Can't reach your appliance")).toBeInTheDocument();
    expect(
      getByText("Couldn't reach the appliance to read setup state."),
    ).toBeInTheDocument();

    // It does NOT silently bounce to /login on the failed probe.
    expect(replaceMock).not.toHaveBeenCalled();

    // Retry re-runs the probe.
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retrySetupProbe).toHaveBeenCalledTimes(1);
  });

  it("does NOT block a public page (/setup) on a transient probe failure", () => {
    pathnameValue = "/setup";
    setAuth({
      user: null,
      isLoading: false,
      setupState: null,
      setupProbeError: "network down",
      retrySetupProbe: vi.fn(),
    });

    const { queryByText, getByText } = render(
      <AuthGate>
        <div>wizard</div>
      </AuthGate>,
    );

    // The wizard deep-link still renders — the error gate only guards the
    // protected (non-public) surface.
    expect(getByText("wizard")).toBeInTheDocument();
    expect(queryByText("Can't reach your appliance")).toBeNull();
  });
});
