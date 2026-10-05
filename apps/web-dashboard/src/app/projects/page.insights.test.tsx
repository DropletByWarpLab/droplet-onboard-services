/**
 * /projects?view=insights (WARP-3524): the workspace-level Insights are a view of
 * the Projects page, not a nav row (the top-level row cap is why), so the deep
 * link, the way in from the index, and the way back all have to work, and the
 * URL has to tell the truth about which of them is showing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children, actions }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p data-testid="sub">{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => React.createElement("a", { href, ...props }, children),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" }, isLoading: false }),
  authFetch: vi.fn(),
}));
vi.mock("@/lib/hooks/useAppCapabilities", () => ({ useAppCapabilities: () => ({ projects: true }) }));

const paramsRef = { current: new URLSearchParams() as URLSearchParams | null };
const listeners = new Set<() => void>();
const navigate = (href: string, replace = false) => {
  window.history[replace ? "replaceState" : "pushState"](null, "", href);
  paramsRef.current = new URLSearchParams(window.location.search);
  for (const notify of listeners) notify();
};
vi.mock("next/navigation", () => ({
  useSearchParams: () => {
    const search = React.useSyncExternalStore(
      (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
      () => paramsRef.current?.toString() ?? null,
    );
    return React.useMemo(() => search === null ? null : new URLSearchParams(search), [search]);
  },
  useRouter: () => ({ replace: (href: string) => navigate(href, true), push: (href: string) => navigate(href), back: vi.fn() }),
}));

vi.mock("@/components/projects/insights/InsightsView", () => ({
  InsightsView: ({ projectId }: { projectId: string | null }) => (
    <div data-testid="insights" data-project={projectId ?? "workspace"} />
  ),
}));

const projectsRef = { current: [] as { id: string; identifier: string; name: string; archived: boolean; openCount: number; doneCount: number }[] };
const query = vi.fn((_args: unknown) => ({ items: [], error: undefined, isLoading: false, total: 0, counts: {}, refresh: vi.fn() }));
vi.mock("@/components/projects/usePm", () => ({
  useProjects: () => ({ projects: projectsRef.current, error: undefined, isLoading: false, mutate: vi.fn() }),
  useSummary: () => ({ summary: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
  useProjectStates: () => ({ states: undefined, error: undefined, isLoading: false }),
  useWorkItemQuery: (args: unknown) => query(args),
  useWorkItemByKey: () => ({ item: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
  useSavedViews: () => ({ views: [], error: undefined, isLoading: false, mutate: vi.fn() }),
  useProjectLabels: () => ({ labels: [] }),
  usePeople: () => ({ person: (id: string) => ({ id, name: "Tester", tone: 0 }), users: [] }),
  useDepartments: () => ({ departments: undefined }),
  useProjectCycles: () => ({ cycles: [], mutate: vi.fn() }),
  pmActions: () => ({}),
  viewActions: () => ({}),
  PmRequestError: class extends Error {},
}));

import ProjectsPage from "./page";

beforeEach(() => {
  paramsRef.current = new URLSearchParams();
  projectsRef.current = [];
  query.mockClear();
  window.history.replaceState(null, "", "/projects");
});

describe("/projects?view=insights", () => {
  it("restores project Insights and follows a URL change back to the table", () => {
    projectsRef.current = [{ id: "p1", identifier: "INBOX", name: "Inbox", archived: false, openCount: 0, doneCount: 0 }];
    paramsRef.current = new URLSearchParams("p=INBOX&view=insights");
    const { rerender } = render(<ProjectsPage />);
    expect(screen.getByTestId("insights")).toHaveAttribute("data-project", "p1");
    expect(screen.getByRole("tab", { name: "Insights" })).toHaveAttribute("aria-selected", "true");
    expect(query.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false, projectId: "p1" });
    paramsRef.current = new URLSearchParams("p=INBOX&view=table");
    rerender(<ProjectsPage />);
    expect(screen.queryByTestId("insights")).toBeNull();
    expect(screen.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
    expect(query.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true, projectId: "p1" });
  });

  it("opens the workspace-level Insights straight from the deep link", () => {
    paramsRef.current = new URLSearchParams("view=insights");
    window.history.replaceState(null, "", "/projects?view=insights");
    render(<ProjectsPage />);

    expect(screen.getByTestId("insights")).toHaveAttribute("data-project", "workspace");
    expect(screen.getByTestId("sub")).toHaveTextContent("Insights across all projects");
    expect(screen.getByRole("button", { name: /all projects/i })).toBeInTheDocument();
    // The index is not also on screen.
    expect(screen.queryByText(/no projects yet/i)).toBeNull();
    // The URL already says so; nothing rewrites it.
    expect(window.location.search).toBe("?view=insights");
  });

  it("opens from the index header and writes the deep link, then clears it on the way back", () => {
    render(<ProjectsPage />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("insights")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /insights/i }));
    expect(screen.getByTestId("insights")).toHaveAttribute("data-project", "workspace");
    expect(window.location.search).toBe("?view=insights");

    fireEvent.click(screen.getByRole("button", { name: /all projects/i }));
    expect(screen.queryByTestId("insights")).toBeNull();
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("leaves every other query parameter alone", () => {
    window.history.replaceState(null, "", "/projects?keep=1");
    paramsRef.current = new URLSearchParams("keep=1");
    render(<ProjectsPage />);

    fireEvent.click(screen.getByRole("button", { name: /insights/i }));
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("1");
    expect(new URLSearchParams(window.location.search).get("view")).toBe("insights");

    fireEvent.click(screen.getByRole("button", { name: /all projects/i }));
    expect(window.location.search).toBe("?keep=1");
  });

  it("opens project-scoped Insights from its URL without running the saved-filter query", () => {
    projectsRef.current = [{ id: "p1", identifier: "INBOX", name: "Inbox", archived: false, openCount: 2, doneCount: 1 }];
    paramsRef.current = new URLSearchParams("p=INBOX&view=insights&v=mine&f=priority.is%3Ahigh");
    window.history.replaceState(null, "", `/projects?${paramsRef.current}`);
    render(<ProjectsPage />);

    expect(screen.getByTestId("insights")).toHaveAttribute("data-project", "p1");
    expect(screen.getByRole("tab", { name: "Insights" })).toHaveAttribute("aria-selected", "true");
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, projectId: "p1" }));
    expect(screen.queryByLabelText("Filter work items")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(screen.queryByTestId("insights")).toBeNull();
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, projectId: "p1" }));
    expect(paramsRef.current?.get("view")).toBeNull();
    expect(paramsRef.current?.get("v")).toBe("mine");
    expect(paramsRef.current?.get("f")).toBe("priority.is:high");
  });

  it("does not claim `?view=insights` for a different view value", () => {
    paramsRef.current = new URLSearchParams("view=board");
    render(<ProjectsPage />);
    expect(screen.queryByTestId("insights")).toBeNull();
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("renders outside the app router, where there are no search params at all", () => {
    paramsRef.current = null;
    render(<ProjectsPage />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });
});
