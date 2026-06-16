/**
 * WARP-667 — AuthGate's probe-blocked screen has two phases driven by the
 * provider's `setupAutoRetrying` flag:
 *   - retrying  → a calm, polite-live "Reconnecting to your Droplet…" status
 *                 with NO manual Retry (the box is just warming up);
 *   - exhausted → the explicit "Can't reach your appliance" + Retry fallback.
 *
 * Behavioural test (mocked `useAuth` + next/navigation), mirroring
 * setup.probe-error.test.tsx — the provider-side state machine is covered by
 * auth.setup-autoretry.test.tsx; this pins the render branch + its a11y.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const replaceMock = vi.fn();
const pathnameValue = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
  usePathname: () => pathnameValue,
}));

vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

import { AuthGate } from "@/components/AuthGate";

beforeEach(() => {
  replaceMock.mockReset();
  useAuthMock.mockReset();
});

describe("AuthGate — cold-boot reconnect surface (WARP-667)", () => {
  it("shows a polite 'Reconnecting…' status with NO manual Retry while auto-retrying", () => {
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: false,
      setupState: null,
      setupProbeError: "Couldn't reach the appliance to read setup state.",
      setupAutoRetrying: true,
      retrySetupProbe: vi.fn(),
    });

    const { getByText, queryByRole, getByRole } = render(
      <AuthGate>
        <div>protected</div>
      </AuthGate>,
    );

    expect(getByText(/reconnecting to your droplet/i)).toBeInTheDocument();
    // While auto-retrying, the manual Retry is intentionally absent.
    expect(queryByRole("button", { name: "Retry" })).toBeNull();
    // The status is announced politely (role="status" container).
    expect(getByRole("status")).toBeInTheDocument();
    // Never bounces off a guess.
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("falls back to the explicit error + working Retry once retries are exhausted", () => {
    const retrySetupProbe = vi.fn();
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: false,
      setupState: null,
      setupProbeError: "Couldn't reach the appliance to read setup state.",
      setupAutoRetrying: false,
      retrySetupProbe,
    });

    const { getByText, getByRole } = render(
      <AuthGate>
        <div>protected</div>
      </AuthGate>,
    );

    expect(getByText("Can't reach your appliance")).toBeInTheDocument();
    expect(
      getByText("Couldn't reach the appliance to read setup state."),
    ).toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retrySetupProbe).toHaveBeenCalledTimes(1);
  });
});
