/**
 * PR #372 — AuthGate routes off the explicit `/setup/state` machine, not
 * the legacy boolean `setupRequired`.
 *
 * Behavioural test (renders AuthGate with a mocked `useAuth` + mocked
 * next/navigation) rather than a readFileSync source-scrape, which pins the
 * shape of the code instead of what it does. The Windows half of the old
 * reason was wrong (WARP-2654): `import.meta.url` does not yield `C:\C:\...`
 * — `new URL(import.meta.url).pathname` does, and this package anchors paths
 * on `__dirname` anyway. Brittleness is the reason that survives.
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

  it("renders /help during setup (unclaimed) instead of bouncing to /setup (WARP-930)", () => {
    pathnameValue = "/help";
    setAuth({
      user: null,
      isLoading: false,
      setupState: { appliance: "unclaimed", setupStep: "org", userTourCompleted: false },
    });
    const { container } = render(<AuthGate>help content</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("help content");
  });

  it("renders /help mid-wizard for the signed-in owner without bouncing (WARP-930)", () => {
    pathnameValue = "/help";
    setAuth({
      user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" },
      isLoading: false,
      setupState: { appliance: "unclaimed", setupStep: "org", userTourCompleted: false },
    });
    const { container } = render(<AuthGate>help content</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("help content");
  });

  it("does NOT early-render /help to an anonymous visitor on a CLAIMED box (redirects to login) (WARP-930)", () => {
    pathnameValue = "/help";
    setAuth({
      user: null,
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: true },
    });
    const { container } = render(<AuthGate>help content</AuthGate>);
    // The standalone help render is gated on applianceUnclaimed, so a claimed-box
    // logged-out visitor falls through to the login redirect, not an early paint.
    expect(container.textContent).not.toContain("help content");
    expect(replaceMock).toHaveBeenCalledWith("/login");
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

/**
 * Invite acceptance — an invite link (`/invite/<token>`) targets a brand-new
 * person who has NO session yet and lands on a CLAIMED box (appliance "ready").
 * `/invite` must be public, like /login and /setup: AuthGate must NOT bounce
 * the anonymous invitee to /login, and must render the password-set form.
 * Pre-fix the route was protected, so the link "just went to the sign-in page"
 * and the invitee could never set a password.
 */
describe("AuthGate — public /invite acceptance route", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    useAuthMock.mockReset();
    pathnameValue = "/";
  });

  it("renders the invite page for an anonymous visitor on a ready box — no /login bounce", () => {
    pathnameValue = "/invite/tok_abc123";
    setAuth({
      user: null,
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: true },
    });
    const { container } = render(<AuthGate>set your password</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("set your password");
  });

  it("renders the invite page even before auth has resolved (public, not gated on loading)", () => {
    pathnameValue = "/invite/tok_abc123";
    setAuth({ user: null, isLoading: true, setupState: null });
    const { container } = render(<AuthGate>set your password</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("set your password");
  });
});

/**
 * WARP-867 — an AUTHENTICATED user on an UNCLAIMED appliance must have one
 * stable home: the wizard. The account step auto-logs the owner in, so this
 * combination is the NORMAL state for the entire back half of first-run.
 * Pre-fix, `/setup` bounced to `/` (user && isPublicPage) while `/` bounced
 * back to `/setup` (applianceUnclaimed) — an infinite redirect loop on every
 * mid-wizard refresh. These cases pin the loop closed from each entry point.
 */
describe("AuthGate — authenticated user, unclaimed appliance (WARP-867)", () => {
  const authedUnclaimed = {
    user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" },
    isLoading: false,
    setupState: {
      appliance: "unclaimed",
      setupStep: "internet",
      userTourCompleted: false,
    },
  };

  beforeEach(() => {
    replaceMock.mockReset();
    useAuthMock.mockReset();
    pathnameValue = "/";
  });

  it("stays put on /setup — no redirect at all (the loop's first leg)", () => {
    pathnameValue = "/setup";
    setAuth(authedUnclaimed);
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("routes / back into the wizard, not the dashboard (the loop's second leg)", () => {
    pathnameValue = "/";
    setAuth(authedUnclaimed);
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/setup");
    expect(replaceMock).toHaveBeenCalledTimes(1);
  });

  it("routes /login into the wizard — setup still owns the session", () => {
    pathnameValue = "/login";
    setAuth(authedUnclaimed);
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/setup");
    expect(replaceMock).toHaveBeenCalledTimes(1);
  });

  it("still sends an authenticated user on a READY box off /login to the dashboard", () => {
    pathnameValue = "/login";
    setAuth({
      ...authedUnclaimed,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: true },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/");
  });
});

/**
 * Done-screen handoff — the wizard-finish PATCH flips the appliance "ready"
 * while the owner is still ON /setup watching the flourish + EMBEDDED tour
 * (DoneStep phase machine). The owner is authenticated by then (the account
 * step adopts its auto-login into the context), so AuthGate must leave that
 * screen alone until the tour completes; bouncing on appliance-state alone
 * yanked the owner to /login?from=setup mid-celebration and re-asked for the
 * password they chose a minute earlier.
 */
describe("AuthGate — wizard Done screen owns /setup while the tour is pending", () => {
  const owner = { id: "u1", username: "ada", displayName: "Ada", role: "owner" };

  beforeEach(() => {
    replaceMock.mockReset();
    useAuthMock.mockReset();
    pathnameValue = "/setup";
  });

  it("leaves an authenticated owner on /setup when ready + tour pending (flourish + embedded tour)", () => {
    setAuth({
      user: owner,
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: false },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("sends an authenticated user on /setup to the dashboard once the tour is complete", () => {
    setAuth({
      user: owner,
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: true },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/");
  });

  it("still bounces an ANONYMOUS visitor off /setup on a claimed box (tour pending or not)", () => {
    setAuth({
      user: null,
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: false },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/login?from=setup");
  });

  it("does NOT except /login: an authenticated user parked there with the tour pending still leaves", () => {
    pathnameValue = "/login";
    setAuth({
      user: owner,
      isLoading: false,
      setupState: { appliance: "ready", setupStep: "done", userTourCompleted: false },
    });
    render(<AuthGate>child</AuthGate>);
    expect(replaceMock).toHaveBeenCalledWith("/");
  });
});
