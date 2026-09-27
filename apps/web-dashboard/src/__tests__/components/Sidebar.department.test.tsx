/**
 * WARP-2976 (ADR-059 §2.3) — the Sidebar inside a department.
 *
 * Pins the WIRING, not just the pure filter: the Sidebar feeds its nav through
 * `departmentNavGroups` and only THEN through `visibleItems`, so
 *   · inside a department the aside shows that department's pages and nothing
 *     else (plus Settings and Help);
 *   · a gate still hides a profile page the person cannot reach (the cameras
 *     module off hides /cameras even though Security lists it);
 *   · Whole business (no active department) is the unchanged nav;
 *   · the switcher renders under the logo only when there is a choice.
 *
 * Mock setup mirrors Sidebar.module-gating.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { ActiveDepartmentValue } from "@/lib/departments/active-department";
import type { Department, DepartmentProfile } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada Lovelace", role: "owner" },
    isLoading: false,
    logout: vi.fn(async () => {}),
  }),
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("next/navigation", async () => {
  const actual: any = await vi.importActual("next/navigation");
  return {
    ...actual,
    usePathname: () => "/d/security",
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  };
});

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/hooks/useCapabilities", () => ({
  useCapabilities: () => ({ claudeActivity: false, ragEval: false }),
}));

const modulesRef = { current: {} as Record<string, boolean> };
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGate: () => (moduleId: string) => modulesRef.current[moduleId] !== false,
}));

const security: Department = {
  id: "sec",
  name: "Security",
  slug: "security",
  kind: "DEPARTMENT",
  parentId: null,
  description: null,
  state: "active",
  provisionError: null,
  quotaBytes: null,
  aclVersion: 1,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  archivedAt: null,
  memberCount: 3,
  teamCount: 0,
  myRight: null,
  usedBytes: null,
  profile: { template: "security", icon: "shield-check" },
};
const securityProfile: DepartmentProfile = {
  departmentId: "sec",
  template: "security",
  icon: "shield-check",
  navHrefs: ["/cameras", "/events", "/network", "/devices", "/integrations"],
  homeWidgets: [],
  updatedBy: "u1",
  updatedAt: "2026-09-22T00:00:00Z",
};

const ctx: { current: ActiveDepartmentValue } = { current: undefined as never };
vi.mock("@/lib/departments/active-department", () => ({
  useActiveDepartment: () => ctx.current,
}));

import { Sidebar } from "@/components/Sidebar";

function aside(): HTMLElement {
  return document.querySelector("aside[aria-label='Primary navigation']") as HTMLElement;
}
const asideHrefs = () =>
  within(aside())
    .getAllByRole("link")
    .map((a) => a.getAttribute("href"));

beforeEach(() => {
  modulesRef.current = {};
  ctx.current = {
    choices: [security],
    active: security,
    activeProfile: securityProfile,
    canSeeOverview: true,
    showSwitcher: true,
    setActive: vi.fn(),
    isLoaded: true,
  };
});

describe("<Sidebar> inside a department", () => {
  it("shows the department's home and pages, then Ask AI, Settings and Help — nothing else", () => {
    render(<Sidebar />);
    expect(asideHrefs()).toEqual([
      "/d/security", // the brand mark leads to the department's home
      "/d/security",
      "/cameras",
      "/network",
      "/devices",
      "/integrations",
      "/chat",
      "/settings",
      "/help",
    ]);
    expect(within(aside()).getByText("Security home")).toBeInTheDocument();
    expect(
      within(aside()).getByRole("link", { name: "Droplet — Security home" }),
    ).toHaveAttribute("href", "/d/security");
  });

  it("still hides a profile page whose module is off — the filter never replaces a gate", () => {
    modulesRef.current = { cameras: false };
    render(<Sidebar />);
    const hrefs = asideHrefs();
    expect(hrefs).not.toContain("/cameras");
    expect(hrefs).toContain("/network");
    expect(document.querySelector("a[href='/cameras']")).toBeNull();
  });

  it("gives the phone's bottom bar the department's own first destinations", () => {
    render(<Sidebar />);
    const bar = screen.getByRole("navigation", { name: "Bottom navigation" });
    expect(
      within(bar)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/d/security", "/cameras", "/network", "/devices"]);
  });

  it("renders the switcher under the logo", () => {
    render(<Sidebar />);
    expect(
      within(aside()).getByRole("button", { name: "Department: Security" }),
    ).toBeInTheDocument();
  });
});

describe("<Sidebar> for Whole business", () => {
  it("is today's nav, and a department that is not set up changes nothing either", () => {
    ctx.current = { ...ctx.current, active: null, activeProfile: null };
    const { unmount } = render(<Sidebar />);
    const whole = asideHrefs();
    expect(whole).toContain("/");
    expect(whole).toContain("/chat");
    expect(whole).not.toContain("/d/security");
    unmount();

    ctx.current = { ...ctx.current, active: { ...security, profile: null }, activeProfile: null };
    render(<Sidebar />);
    expect(asideHrefs()).toEqual(whole);
  });

  it("renders no switcher — and no wrapper — below two choices", () => {
    ctx.current = { ...ctx.current, active: null, activeProfile: null, showSwitcher: false };
    render(<Sidebar />);
    expect(within(aside()).queryByRole("button", { name: /^Department:/ })).toBeNull();
    expect(aside().querySelector(".dept-switcher")).toBeNull();
  });
});
