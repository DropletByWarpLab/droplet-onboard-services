/**
 * /projects capability gating (WARP-1154/1155).
 *
 * The page is driven by the orchestrator's explicit module capability
 * (GET /api/capabilities → { projects }) — NOT by catching PM errors:
 *
 *   1. `projects: false` → the honest "Projects isn't enabled on this
 *      Droplet." state renders: no Retry affordance (the condition is
 *      permanent), no "server error" copy, and NO PM fetch ever fires.
 *   2. `projects: true` (and the fail-open default) → the normal workspace
 *      renders and the PM reads run.
 *
 * ShellPage is mocked to a passthrough (same rationale as the trust page
 * test); the usePm data layer is stubbed so we can assert which reads fire.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children, actions }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) =>
    React.createElement("a", { href, ...props }, children),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// WARP-3522 — the page's state is the URL, so it reads `useSearchParams` (and
// writes through the router). A bare /projects is an empty query string.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects",
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" },
    isLoading: false,
  }),
  authFetch: vi.fn(),
}));

const modulesRef = { current: { projects: true } as { projects: boolean } };
vi.mock("@/lib/hooks/useAppCapabilities", () => ({
  useAppCapabilities: () => modulesRef.current,
}));

const useProjectsMock = vi.fn(() => ({
  projects: [] as unknown[],
  error: undefined,
  isLoading: false,
  mutate: vi.fn(),
}));
vi.mock("@/components/projects/usePm", () => ({
  useProjects: (...args: unknown[]) => useProjectsMock(...(args as [])),
  useSummary: () => ({ summary: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
  useProjectStates: () => ({ states: undefined, error: undefined, isLoading: false }),
  useProjectLabels: () => ({ labels: undefined }),
  // WARP-3522 — the page reads through the query API and the saved-view list.
  useWorkItemQuery: () => ({
    items: undefined,
    total: undefined,
    counts: undefined,
    stale: undefined,
    effectiveFilter: undefined,
    loadingMore: false,
    truncated: false,
    error: undefined,
    isLoading: false,
    refresh: vi.fn(),
  }),
  useWorkItemByKey: () => ({ item: undefined, error: undefined, mutate: vi.fn() }),
  useSavedViews: () => ({ views: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
  viewActions: () => ({}),
  usePeople: () => ({ person: (id: string) => ({ id, name: "Tester", tone: 0 }), users: [] }),
  // WARP-2717 — the department filter reads this. Undefined is the honest
  // stub: the real hook returns `data?.departments`, so "not loaded yet" and
  // "this box has no departments" are the same shape, and the page has to
  // render the workspace either way. That is what this suite asserts.
  useDepartments: () => ({ departments: undefined }),
  // WARP-3521 — the page reads the project's cycles so a card can name its
  // cycle. Same honest stub: not loaded yet, which the page must survive.
  useProjectCycles: () => ({ cycles: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
  pmActions: () => ({}),
  PmRequestError: class extends Error {},
}));

import ProjectsPage from "./page";

describe("/projects module-capability gating", () => {
  beforeEach(() => {
    modulesRef.current = { projects: true };
    useProjectsMock.mockClear();
  });

  it("renders the honest 'not enabled' state — without retry — when the module is off", () => {
    modulesRef.current = { projects: false };
    render(<ProjectsPage />);
    expect(
      screen.getByText(/projects isn't enabled on this droplet/i),
    ).toBeInTheDocument();
    // WARP-1306: the mocked caller is an OWNER, so the state offers the real
    // enable path instead of the bystander copy (role split covered in
    // ProjectsDisabled.test.tsx).
    expect(
      screen.getByRole("button", { name: /turn on projects/i }),
    ).toBeInTheDocument();
    // No Retry affordance, no scary server-error copy.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByText(/server error/i)).toBeNull();
    expect(screen.queryByText(/try again/i)).toBeNull();
  });

  it("never fires a PM read while the module is off (no doomed request → no error toast)", () => {
    modulesRef.current = { projects: false };
    render(<ProjectsPage />);
    expect(useProjectsMock).not.toHaveBeenCalled();
  });

  it("renders the normal workspace (and runs the PM reads) when the module is on", () => {
    render(<ProjectsPage />);
    expect(useProjectsMock).toHaveBeenCalled();
    expect(
      screen.queryByText(/projects isn't enabled on this droplet/i),
    ).toBeNull();
    // The empty-state CTA proves the real IndexView rendered.
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });
});
