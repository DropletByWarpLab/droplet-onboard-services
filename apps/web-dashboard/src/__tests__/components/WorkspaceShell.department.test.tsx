/**
 * WARP-2976 (ADR-059 §2.3) — the Workspace-tabs shell inside a department.
 *
 * The same switcher sits in the header before the tabs, and the chips are the
 * department's hrefs ∩ the existing gates (`resolveSpaces`' `restrictTo`).
 * With no active department the shell is unchanged. Mock setup mirrors
 * WorkspaceShell.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { ActiveDepartmentValue } from "@/lib/departments/active-department";
import type { Department, DepartmentProfile } from "@/lib/types";

const pathnameRef = { current: "/cameras" };
vi.mock("next/navigation", async () => {
  const actual: any = await vi.importActual("next/navigation");
  return {
    ...actual,
    usePathname: () => pathnameRef.current,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada Lovelace", role: "owner" },
    isLoading: false,
    logout: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/hooks/useCapabilities", () => ({
  useCapabilities: () => ({ claudeActivity: false, ragEval: false }),
}));
const modulesRef = { current: {} as Record<string, boolean> };
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGate: () => (id: string) => modulesRef.current[id] !== false,
}));
vi.mock("@/lib/hooks/useIntegrations", () => ({
  useIntegrations: () => ({ entries: [], connected: [], isLoading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/lib/hooks/useTeamChat", () => ({ useTeamChatUnread: () => 0 }));
vi.mock("@/lib/hooks/useBoxAddress", () => ({ useBoxAddress: () => "droplet.local" }));
vi.mock("swr", () => ({
  default: () => ({ data: { status: "ok" }, error: undefined, isLoading: false }),
}));

const security = {
  id: "sec",
  name: "Security",
  slug: "security",
  kind: "DEPARTMENT",
  state: "active",
  memberCount: 3,
  profile: { template: "security", icon: "shield-check" },
} as unknown as Department;
const profile: DepartmentProfile = {
  departmentId: "sec",
  template: "security",
  icon: "shield-check",
  navHrefs: ["/cameras", "/events", "/network"],
  homeWidgets: [],
  updatedBy: "u1",
  updatedAt: "2026-09-22T00:00:00Z",
};
const ctx: { current: ActiveDepartmentValue } = { current: undefined as never };
vi.mock("@/lib/departments/active-department", () => ({
  useActiveDepartment: () => ctx.current,
}));

import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

function renderShell() {
  return render(
    <WorkspaceShell>
      <div>page</div>
    </WorkspaceShell>,
  );
}

beforeEach(() => {
  pathnameRef.current = "/cameras";
  modulesRef.current = {};
  ctx.current = {
    choices: [security],
    active: security,
    activeProfile: profile,
    canSeeOverview: true,
    showSwitcher: true,
    setActive: vi.fn(),
    isLoaded: true,
  };
});

describe("WorkspaceShell inside a department", () => {
  it("shows only the spaces the department's pages live in", () => {
    renderShell();
    const tabs = within(screen.getByRole("tablist", { name: "Spaces" })).getAllByRole("tab");
    // Operations for the profile's pages; Intelligence for Ask AI; Admin for
    // Settings and Help.
    expect(tabs.map((t) => t.textContent)).toEqual(["Operations", "Intelligence", "Admin"]);
    const chips = within(screen.getByRole("navigation", { name: "Destinations" }))
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(chips).toEqual(["/cameras", "/events", "/network"]);
  });

  it("still gates inside the department: the cameras module off drops both chips", () => {
    modulesRef.current = { cameras: false };
    pathnameRef.current = "/network";
    renderShell();
    const chips = within(screen.getByRole("navigation", { name: "Destinations" }))
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(chips).toEqual(["/network"]);
  });

  it("puts the switcher in the header and points the mark at the department home", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "Department: Security" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Droplet — Security home" })).toHaveAttribute(
      "href",
      "/d/security",
    );
  });

  it("is unchanged for Whole business", () => {
    ctx.current = { ...ctx.current, active: null, activeProfile: null, showSwitcher: false };
    pathnameRef.current = "/";
    renderShell();
    const tabs = within(screen.getByRole("tablist", { name: "Spaces" })).getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    expect(screen.getByRole("link", { name: "Droplet — Overview" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button", { name: /^Department:/ })).toBeNull();
  });
});
