/**
 * WARP-2976 (ADR-059 §2.3) — the department switcher.
 *
 *   · renders NOTHING below two choices (a dead control is worse than none);
 *   · a department with no profile is labelled "Not set up" — an absent
 *     profile key (older orchestrator) is not;
 *   · the WAI-ARIA menu-button contract: aria-haspopup, aria-expanded, arrow
 *     keys, Enter to pick, Escape to close with focus returned;
 *   · picking a department opens /d/<slug>; Whole business opens /.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { ActiveDepartmentValue } from "@/lib/departments/active-department";
import type { Department } from "@/lib/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
}));

const setActive = vi.fn();
const ctx: { current: ActiveDepartmentValue } = {
  current: {
    choices: [],
    active: null,
    activeProfile: null,
    canSeeOverview: true,
    showSwitcher: false,
    setActive,
    isLoaded: true,
  },
};
vi.mock("@/lib/departments/active-department", () => ({
  useActiveDepartment: () => ctx.current,
}));

import { DepartmentSwitcher } from "./DepartmentSwitcher";

function dept(over: Partial<Department>): Department {
  return {
    id: "d",
    name: "Dept",
    slug: "dept",
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
    memberCount: 2,
    teamCount: 0,
    myRight: null,
    usedBytes: null,
    ...over,
  };
}

const security = dept({
  id: "sec",
  name: "Security",
  slug: "security",
  profile: { template: "security", icon: "shield-check" },
});
const sales = dept({ id: "sal", name: "Sales", slug: "sales", profile: null });
const legacy = dept({ id: "leg", name: "Legacy", slug: "legacy" }); // no `profile` key

function setCtx(over: Partial<ActiveDepartmentValue>) {
  ctx.current = { ...ctx.current, ...over };
}

beforeEach(() => {
  push.mockReset();
  setActive.mockReset();
  ctx.current = {
    choices: [security, sales, legacy],
    active: null,
    activeProfile: null,
    canSeeOverview: true,
    showSwitcher: true,
    setActive,
    isLoaded: true,
  };
});

describe("<DepartmentSwitcher> — only when there is a choice", () => {
  it("renders nothing when showSwitcher is false", () => {
    setCtx({ choices: [security], canSeeOverview: false, showSwitcher: false });
    const { container } = render(<DepartmentSwitcher className="px-3" />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: /department/i })).toBeNull();
  });
});

describe("<DepartmentSwitcher> — the menu button", () => {
  it("labels the trigger with the active department, or Whole business", () => {
    const { rerender } = render(<DepartmentSwitcher />);
    const btn = screen.getByRole("button", { name: "Department: Whole business" });
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    setCtx({ active: security });
    rerender(<DepartmentSwitcher />);
    expect(screen.getByRole("button", { name: "Department: Security" })).toBeInTheDocument();
  });

  it("lists Whole business, every choice, and the overview; 'Not set up' only on a null profile", () => {
    render(<DepartmentSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /department/i }));
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((r) => r.textContent)).toEqual([
      "Whole business",
      "Security",
      "SalesNot set up",
      "Legacy",
    ]);
    expect(screen.getByRole("menuitem", { name: "Business overview" })).toBeInTheDocument();
    expect(screen.getAllByText("Not set up")).toHaveLength(1);
  });

  it("marks exactly the active choice as checked", () => {
    setCtx({ active: security });
    render(<DepartmentSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /department/i }));
    const checked = screen
      .getAllByRole("menuitemradio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["Security"]);
  });

  it("offers a non-admin Whole business but not the Business overview", () => {
    setCtx({ canSeeOverview: false, choices: [security, sales], active: security });
    render(<DepartmentSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /department/i }));
    expect(screen.getByRole("menuitemradio", { name: /whole business/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Business overview" })).toBeNull();
  });
});

describe("<DepartmentSwitcher> — keyboard", () => {
  it("ArrowDown opens on the checked item; arrows move; Enter picks and navigates", () => {
    render(<DepartmentSwitcher />);
    const btn = screen.getByRole("button", { name: /department/i });
    btn.focus();
    fireEvent.keyDown(btn, { key: "ArrowDown" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toHaveTextContent("Whole business");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("Security");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toHaveTextContent("Business overview");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("Whole business");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toHaveTextContent("Business overview");
    fireEvent.keyDown(menu, { key: "Home" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });

    // Enter on a button activates it (the browser's own behaviour).
    fireEvent.click(document.activeElement as HTMLElement);
    expect(setActive).toHaveBeenCalledWith("security");
    expect(push).toHaveBeenCalledWith("/d/security");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape closes and returns focus to the trigger", () => {
    render(<DepartmentSwitcher />);
    const btn = screen.getByRole("button", { name: /department/i });
    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(btn);
  });

  it("Whole business restores today's nav and opens Overview", () => {
    setCtx({ active: security });
    render(<DepartmentSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /department/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /whole business/i }));
    expect(setActive).toHaveBeenCalledWith(null);
    expect(push).toHaveBeenCalledWith("/");
  });

  it("the overview link opens /d without changing the active department", () => {
    const onNavigate = vi.fn();
    render(<DepartmentSwitcher variant="drawer" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: /department/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Business overview" }));
    expect(push).toHaveBeenCalledWith("/d");
    expect(setActive).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalled();
  });
});

describe("<DepartmentSwitcher> — the 64px rail", () => {
  it("is glyph-only, with the name as its title and accessible name", () => {
    setCtx({ active: security });
    render(<DepartmentSwitcher variant="rail" />);
    const btn = screen.getByRole("button", { name: "Department: Security" });
    expect(btn).toHaveAttribute("title", "Security");
    expect(btn).not.toHaveTextContent("Security");
  });
});
