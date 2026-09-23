/**
 * WARP-2976 (ADR-059 §2.3) — who gets which department choices, and what is
 * active.
 *
 *   · owner/admin: Whole business + every department; a stale slug falls back
 *     to Whole business.
 *   · everyone else: their member departments only — no Whole business — so a
 *     member of ONE department sees no switcher and simply has that
 *     department as their shell.
 *   · only DEPARTMENT rows that are not archived are choices.
 *   · visiting /d/<slug> makes that department active and remembers it.
 *   · the remembered choice is per user and forgotten on sign-out.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

import type { Department } from "@/lib/types";

const listDepartmentsMock = vi.fn();
const getDepartmentProfileMock = vi.fn();
vi.mock("@/lib/api", () => ({
  listDepartments: (...a: unknown[]) => listDepartmentsMock(...a),
  getDepartmentProfile: (...a: unknown[]) => getDepartmentProfileMock(...a),
}));

const authRef: { current: { role: string; id?: string } | null } = { current: { role: "owner" } };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: authRef.current ? { id: "u1", username: "ada", ...authRef.current } : null }),
}));
// The signed-in user in these tests is "u1" unless a test overrides `id`.
const U1_KEY = "droplet-active-department:u1";

const pathRef = { current: "/" };
vi.mock("next/navigation", () => ({
  usePathname: () => pathRef.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import {
  ActiveDepartmentProvider,
  activeDepartmentStorageKey,
  departmentChoices,
  resolveActive,
  switcherChoiceCount,
  useActiveDepartment,
} from "./active-department";

function dept(over: Partial<Department>): Department {
  return {
    id: over.slug ?? "d",
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
    profile: null,
    ...over,
  };
}

const security = dept({ id: "sec", name: "Security", slug: "security" });
const sales = dept({ id: "sal", name: "Sales", slug: "sales" });

describe("departmentChoices", () => {
  it("keeps only live DEPARTMENT rows, sorted by name", () => {
    const rows = [
      sales,
      dept({ id: "h", name: "Household", slug: "household", kind: "HOUSEHOLD" }),
      dept({ id: "t", name: "Night shift", slug: "night", kind: "TEAM", parentId: "sec" }),
      dept({ id: "a", name: "Archive", slug: "archive", state: "archived" }),
      dept({ id: "b", name: "Leaving", slug: "leaving", state: "archiving" }),
      security,
    ];
    expect(departmentChoices(rows).map((d) => d.slug)).toEqual(["sales", "security"]);
    expect(departmentChoices(undefined)).toEqual([]);
  });
});

describe("resolveActive", () => {
  const choices = [sales, security];

  it("honours a stored slug the viewer can still see", () => {
    expect(resolveActive(choices, "security")).toBe(security);
  });

  it("a stale or absent slug is Whole business — for every role, never a first department", () => {
    expect(resolveActive(choices, "gone")).toBeNull();
    expect(resolveActive(choices, null)).toBeNull();
  });

  it("with no departments at all it is Whole business — today's nav", () => {
    expect(resolveActive([], "security")).toBeNull();
  });
});

describe("switcherChoiceCount", () => {
  it("always counts Whole business", () => {
    expect(switcherChoiceCount([security])).toBe(2);
    expect(switcherChoiceCount([])).toBe(1);
  });
});

function Probe() {
  const v = useActiveDepartment();
  return (
    <div>
      <span data-testid="active">{v.active?.slug ?? "whole"}</span>
      <span data-testid="switcher">{String(v.showSwitcher)}</span>
      <span data-testid="count">{v.choices.length}</span>
      <button type="button" onClick={() => v.setActive(null)}>
        whole
      </button>
    </div>
  );
}

const tree = (ui: ReactNode) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    <ActiveDepartmentProvider>{ui}</ActiveDepartmentProvider>
  </SWRConfig>
);
const wrap = (ui: ReactNode) => render(tree(ui));

describe("<ActiveDepartmentProvider>", () => {
  beforeEach(() => {
    localStorage.clear();
    listDepartmentsMock.mockReset();
    getDepartmentProfileMock.mockReset();
    getDepartmentProfileMock.mockResolvedValue({ profile: null, inheritedFrom: null, canEdit: false });
    authRef.current = { role: "owner" };
    pathRef.current = "/";
  });

  it("outside a provider: Whole business, no switcher", () => {
    render(<Probe />);
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
    expect(screen.getByTestId("switcher")).toHaveTextContent("false");
  });

  it("an owner with one department gets a switcher (Whole business + it)", async () => {
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("switcher")).toHaveTextContent("true");
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("a member of one department gets the switcher but stays on Whole business until they choose", async () => {
    authRef.current = { role: "family" };
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("switcher")).toHaveTextContent("true");
    // An owner setting up Security must not narrow this person's nav by itself.
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("a person in no department gets no switcher and today's nav", async () => {
    authRef.current = { role: "family" };
    listDepartmentsMock.mockResolvedValue({ departments: [] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
    expect(screen.getByTestId("switcher")).toHaveTextContent("false");
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("visiting /d/<slug> makes it active and remembers it", async () => {
    pathRef.current = "/d/security";
    listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
    expect(localStorage.getItem(U1_KEY)).toBe("security");
  });

  it("picking Whole business while still on /d/<slug> sticks (the URL is not re-applied)", async () => {
    pathRef.current = "/d/security";
    listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
    // The switcher sets the choice, then navigates; until the router moves,
    // the pathname still reads /d/security.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "whole" }));
    });
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
    expect(localStorage.getItem(U1_KEY)).toBeNull();
  });

  it("a remembered slug the viewer can no longer see falls back to Whole business", async () => {
    localStorage.setItem(U1_KEY, "gone");
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("does not persist a /d/<slug> the viewer cannot choose", async () => {
    pathRef.current = "/d/someone-elses";
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(localStorage.getItem(U1_KEY)).toBeNull();
  });

  it("keys the choice per user", () => {
    expect(activeDepartmentStorageKey("u1")).toBe(U1_KEY);
  });

  it("another user with the same slug stored lands on Whole business (shared browser)", async () => {
    // The owner (u1) picked Security on this browser; a family member (u2),
    // also in Security, signs in next.
    localStorage.setItem(U1_KEY, "security");
    authRef.current = { role: "family", id: "u2" };
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("the owner's own stored choice is still honoured", async () => {
    localStorage.setItem(U1_KEY, "security");
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
  });

  it("switching accounts without a reload does not carry the choice over", async () => {
    localStorage.setItem(U1_KEY, "security");
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    const { rerender } = wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));

    authRef.current = { role: "family", id: "u2" };
    rerender(tree(<Probe />));
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("whole"));
    // u1's choice is untouched by u2 signing in.
    expect(localStorage.getItem(U1_KEY)).toBe("security");
  });

  it("signing out clears the signed-out user's choice", async () => {
    localStorage.setItem(U1_KEY, "security");
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    const { rerender } = wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));

    authRef.current = null;
    rerender(tree(<Probe />));
    await waitFor(() => expect(localStorage.getItem(U1_KEY)).toBeNull());
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("storage that throws means Whole business, not a crash", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      listDepartmentsMock.mockResolvedValue({ departments: [security] });
      wrap(<Probe />);
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
      expect(screen.getByTestId("active")).toHaveTextContent("whole");
    } finally {
      spy.mockRestore();
    }
  });
});
