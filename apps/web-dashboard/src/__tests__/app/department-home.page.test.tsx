/**
 * WARP-2976 (ADR-059 §2.2, §2.4) — `/d/<slug>`, a department's home.
 *
 *   · no profile + canEdit  → the template picker, one card per template;
 *     picking one PUTs that template's defaults (never a guess from the name)
 *   · no profile, !canEdit  → says it isn't set up and who can set it up; no
 *     picker, no dead buttons
 *   · a profile             → its widgets, skipping an unknown widget id and
 *     a widget whose module is off for the viewer; quick links run the
 *     viewer's own gates
 *   · a slug the viewer has no row for → "couldn't find", not a blank page
 *
 * ShellPage is a passthrough (same rationale as the projects gating test).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";

import type { Department, DepartmentProfileResponse } from "@/lib/types";

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

const slugRef = { current: "security" };
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: slugRef.current }),
  usePathname: () => `/d/${slugRef.current}`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const listDepartmentsMock = vi.fn();
const getDepartmentProfileMock = vi.fn();
const putDepartmentProfileMock = vi.fn();
const getDepartmentMock = vi.fn();
vi.mock("@/lib/api", () => ({
  listDepartments: (...a: unknown[]) => listDepartmentsMock(...a),
  getDepartmentProfile: (...a: unknown[]) => getDepartmentProfileMock(...a),
  putDepartmentProfile: (...a: unknown[]) => putDepartmentProfileMock(...a),
  getDepartment: (...a: unknown[]) => getDepartmentMock(...a),
  fetchCameras: vi.fn(async () => []),
  fetchSystemHealth: vi.fn(),
}));

const modulesRef = { current: {} as Record<string, boolean> };
const roleRef = { current: "owner" as "owner" | "family" };
vi.mock("@/components/Departments/useNavGates", () => ({
  useNavGates: () => ({
    role: roleRef.current,
    capabilities: { claudeActivity: false, ragEval: false, medicalConnector: false },
    isModuleOn: (id: string) => modulesRef.current[id] !== false,
  }),
}));

import DepartmentHomePage from "@/app/d/[slug]/page";

function dept(over: Partial<Department>): Department {
  return {
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
    myRight: "manager",
    usedBytes: null,
    profile: null,
    ...over,
  };
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DepartmentHomePage />
    </SWRConfig>,
  );
}

function profileResponse(over: Partial<DepartmentProfileResponse>): DepartmentProfileResponse {
  return { profile: null, inheritedFrom: null, canEdit: false, ...over };
}

beforeEach(() => {
  slugRef.current = "security";
  modulesRef.current = {};
  roleRef.current = "owner";
  listDepartmentsMock.mockReset();
  getDepartmentProfileMock.mockReset();
  putDepartmentProfileMock.mockReset();
  getDepartmentMock.mockReset();
  listDepartmentsMock.mockResolvedValue({ departments: [dept({})] });
  getDepartmentMock.mockResolvedValue({
    department: dept({}),
    usedBytes: null,
    members: [
      { userId: "u1", displayName: "Jordan Lee", right: "manager", syncState: "synced", syncError: null },
    ],
    teams: [],
  });
});

describe("/d/<slug> — not set up", () => {
  it("canEdit: offers one card per template, and picking one PUTs its defaults", async () => {
    getDepartmentProfileMock.mockResolvedValue(profileResponse({ canEdit: true }));
    putDepartmentProfileMock.mockResolvedValue({
      profile: {
        departmentId: "sec",
        template: "security",
        icon: "shield-check",
        navHrefs: ["/cameras"],
        homeWidgets: [{ widget: "members", size: "s" }],
        updatedBy: "u1",
        updatedAt: "2026-09-22T00:00:00Z",
      },
    });
    renderPage();

    const templates = await screen.findByRole("list", { name: "Templates" });
    const cards = within(templates).getAllByRole("button");
    expect(cards).toHaveLength(7);
    expect(screen.getByRole("heading", { name: "Set up Security" })).toBeInTheDocument();

    fireEvent.click(within(templates).getByRole("button", { name: /^Sales/ }));
    await waitFor(() => expect(putDepartmentProfileMock).toHaveBeenCalledTimes(1));
    // The picked template's defaults — Sales, although the department is
    // NAMED Security. The name is never read to choose.
    expect(putDepartmentProfileMock).toHaveBeenCalledWith("sec", {
      template: "sales",
      icon: "briefcase",
      navHrefs: ["/customers", "/projects", "/email", "/calendar"],
      homeWidgets: [
        { widget: "quick-links", size: "m" },
        { widget: "work", size: "m" },
        { widget: "members", size: "s" },
        { widget: "files", size: "s" },
      ],
    });
    // The saved profile replaces the picker.
    await waitFor(() => expect(screen.queryByRole("list", { name: "Templates" })).toBeNull());
  });

  it("canEdit: says why a PUT was refused, in words", async () => {
    getDepartmentProfileMock.mockResolvedValue(profileResponse({ canEdit: true }));
    putDepartmentProfileMock.mockRejectedValue(
      Object.assign(new Error("nope"), { status: 409, code: "ARCHIVED" }),
    );
    renderPage();
    const templates = await screen.findByRole("list", { name: "Templates" });
    fireEvent.click(within(templates).getByRole("button", { name: /^Security/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/archived/i);
  });

  it("!canEdit: no picker — it says who can set it up", async () => {
    getDepartmentProfileMock.mockResolvedValue(profileResponse({ canEdit: false }));
    renderPage();
    expect(
      await screen.findByText("This department isn’t set up yet. Ask an owner or its manager."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Templates" })).toBeNull();
    expect(screen.queryByRole("button", { name: /customize/i })).toBeNull();
  });
});

describe("/d/<slug> — set up", () => {
  const profile = {
    departmentId: "sec",
    template: "security" as const,
    icon: "shield-check",
    navHrefs: ["/cameras", "/network", "/integrations", "/gone"],
    homeWidgets: [
      { widget: "quick-links", size: "m" as const },
      { widget: "mystery-widget", size: "m" as const },
      { widget: "cameras", size: "m" as const },
      { widget: "members", size: "s" as const },
    ],
    updatedBy: "u1",
    updatedAt: "2026-09-22T00:00:00Z",
  };

  it("renders known widgets, skipping an unknown id and a module that is off", async () => {
    modulesRef.current = { cameras: false };
    getDepartmentProfileMock.mockResolvedValue(profileResponse({ profile, canEdit: true }));
    renderPage();
    expect(await screen.findByRole("heading", { name: "Quick links" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cameras" })).toBeNull();
    expect(document.querySelector("[data-widget='mystery-widget']")).toBeNull();
    expect(await screen.findByText("Jordan Lee")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /customize/i })).toBeInTheDocument();
  });

  it("quick links are the profile's pages ∩ the viewer's gates", async () => {
    roleRef.current = "family";
    modulesRef.current = { cameras: false };
    getDepartmentProfileMock.mockResolvedValue(profileResponse({ profile, canEdit: false }));
    renderPage();
    const tile = (await screen.findByRole("heading", { name: "Quick links" })).closest("section")!;
    const hrefs = within(tile)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    // /cameras: module off. /integrations: owner/admin only. /gone: not a route.
    expect(hrefs).toEqual(["/network"]);
    expect(screen.queryByRole("button", { name: /customize/i })).toBeNull();
  });
});

describe("/d/<slug> — no such department", () => {
  it("says it couldn't find it rather than rendering a blank page", async () => {
    slugRef.current = "nowhere";
    renderPage();
    expect(await screen.findByText("We couldn’t find that department")).toBeInTheDocument();
    expect(getDepartmentProfileMock).not.toHaveBeenCalled();
  });

  it("a 403 on the profile says the viewer is not a member", async () => {
    getDepartmentProfileMock.mockRejectedValue(
      Object.assign(new Error("no"), { status: 403, code: "NOT_A_MEMBER" }),
    );
    renderPage();
    expect(await screen.findByText(/not a member of this department/i)).toBeInTheDocument();
  });
});
