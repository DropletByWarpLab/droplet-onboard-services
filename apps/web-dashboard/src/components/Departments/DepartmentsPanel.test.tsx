/**
 * WARP-1270 (T18) — Departments & teams tab panel (design brief §3).
 *
 * Covers list + detail render, rights-select → API call, remove confirm,
 * create-department modal (slug preview + submit), archive/restore, the
 * Household system card, empty state, and admin-vs-manager affordance
 * gating (create/archive admin-only; member management manager-or-admin).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";
import type { Department, DepartmentDetail, RosterUser } from "@/lib/types";

const listDepartmentsMock = vi.fn();
const getDepartmentMock = vi.fn();
const createDepartmentMock = vi.fn();
const createTeamMock = vi.fn();
const archiveDepartmentMock = vi.fn();
const restoreDepartmentMock = vi.fn();
const addDepartmentMemberMock = vi.fn();
const updateDepartmentMemberRightMock = vi.fn();
const removeDepartmentMemberMock = vi.fn();
// WARP-1809 — toast LABELS are part of the panel's display-name contract
// (every unit name a toast interpolates routes through deptDisplayName),
// so the spy replaces the ToastContext default no-op.
const toastMock = vi.fn();

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/lib/api", () => ({
  listDepartments: (...a: any[]) => listDepartmentsMock(...a),
  getDepartment: (...a: any[]) => getDepartmentMock(...a),
  createDepartment: (...a: any[]) => createDepartmentMock(...a),
  createTeam: (...a: any[]) => createTeamMock(...a),
  archiveDepartment: (...a: any[]) => archiveDepartmentMock(...a),
  restoreDepartment: (...a: any[]) => restoreDepartmentMock(...a),
  addDepartmentMember: (...a: any[]) => addDepartmentMemberMock(...a),
  updateDepartmentMemberRight: (...a: any[]) => updateDepartmentMemberRightMock(...a),
  removeDepartmentMember: (...a: any[]) => removeDepartmentMemberMock(...a),
}));

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import { DepartmentsPanel } from "./DepartmentsPanel";

function dept(overrides: Partial<Department> = {}): Department {
  return {
    id: "d1",
    name: "Finance",
    slug: "finance",
    kind: "DEPARTMENT",
    parentId: null,
    description: null,
    state: "active",
    provisionError: null,
    quotaBytes: null,
    aclVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    memberCount: 1,
    teamCount: 0,
    myRight: "manager",
    usedBytes: null,
    ...overrides,
  };
}

function detail(department: Department, overrides: Partial<DepartmentDetail> = {}): DepartmentDetail {
  return {
    department,
    usedBytes: null,
    members: [
      { userId: "u1", displayName: "Priya Nair", right: "contributor", syncState: "synced", syncError: null },
    ],
    teams: [],
    ...overrides,
  };
}

const PEOPLE: RosterUser[] = [
  { id: "priya", userId: "u1", username: "priya", displayName: "Priya Nair" },
  { id: "tom", userId: "u2", username: "tom", displayName: "Tom Alvarez" },
];

beforeEach(() => {
  listDepartmentsMock.mockReset();
  getDepartmentMock.mockReset();
  createDepartmentMock.mockReset();
  createTeamMock.mockReset();
  archiveDepartmentMock.mockReset();
  restoreDepartmentMock.mockReset();
  addDepartmentMemberMock.mockReset();
  updateDepartmentMemberRightMock.mockReset();
  removeDepartmentMemberMock.mockReset();
  toastMock.mockReset();
});

describe("DepartmentsPanel — empty state", () => {
  it("shows the verbatim empty-state copy + create CTA for an admin", async () => {
    listDepartmentsMock.mockResolvedValue({ departments: [] });
    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);

    await waitFor(() => {
      expect(screen.getByText("No departments yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "No departments yet — create the first one to give a group of people their own file library.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new department/i })).toBeInTheDocument();
  });

  it("hides the create CTA for a non-admin", async () => {
    listDepartmentsMock.mockResolvedValue({ departments: [] });
    render(<DepartmentsPanel people={PEOPLE} isAdminTier={false} />);

    await waitFor(() => {
      expect(screen.getByText("No departments yet")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /new department/i })).not.toBeInTheDocument();
  });
});

describe("DepartmentsPanel — list + detail", () => {
  it("auto-selects the first department and loads its member roster", async () => {
    const finance = dept();
    listDepartmentsMock.mockResolvedValue({ departments: [finance] });
    getDepartmentMock.mockResolvedValue(detail(finance));

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);

    await waitFor(() => {
      expect(getDepartmentMock).toHaveBeenCalledWith("d1");
    });
    await waitFor(() => {
      expect(screen.getByText("Priya Nair")).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/rights for priya nair/i)).toHaveValue("contributor");
  });

  it("renders the Household card under a System divider", async () => {
    const finance = dept();
    const household = dept({ id: "hh", name: "Household", kind: "HOUSEHOLD", memberCount: 3, myRight: null });
    listDepartmentsMock.mockResolvedValue({ departments: [finance, household] });
    getDepartmentMock.mockResolvedValue(detail(finance));

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-card")).toBeInTheDocument();
    });
    // WARP-1808 — the server seeds the unit's name as "Household" (data
    // contract), but the rendered card always reads "Workspace".
    expect(within(screen.getByTestId("workspace-card")).getByText("Workspace")).toBeInTheDocument();
    expect(within(screen.getByTestId("workspace-card")).queryByText("Household")).not.toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    // WARP-1810 — the Workspace card's glyph is Building2, not the residential
    // Home/House glyph (lucide-react renders Home as the "house" icon).
    const card = screen.getByTestId("workspace-card");
    expect(card.querySelector("svg.lucide-building-2")).toBeInTheDocument();
    expect(card.querySelector("svg.lucide-house")).not.toBeInTheDocument();
  });

  // WARP-1808 — display mapping keys off `kind`, never the name string: a
  // HOUSEHOLD unit whose server name differs still renders "Workspace" on the
  // overview card AND in the detail header.
  it("renders 'Workspace' for a HOUSEHOLD unit whose server name differs", async () => {
    const household = dept({ id: "hh", name: "The Smiths", kind: "HOUSEHOLD", memberCount: 2, myRight: null });
    listDepartmentsMock.mockResolvedValue({ departments: [household] });
    getDepartmentMock.mockResolvedValue(detail(household));

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-card")).toBeInTheDocument();
    });
    expect(within(screen.getByTestId("workspace-card")).getByText("Workspace")).toBeInTheDocument();
    expect(screen.queryByText("The Smiths")).not.toBeInTheDocument();
    // Household is the only unit, so it auto-selects — the detail header maps
    // too. waitFor + a fresh query: the detail load re-renders the header
    // (detail, then loading-flag, land as separate renders), so a node held
    // across that boundary can be detached by the time it's asserted.
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Workspace" })).toBeInTheDocument();
    });
  });

  it("changing a member's rights calls updateDepartmentMemberRight and reloads", async () => {
    const finance = dept();
    listDepartmentsMock.mockResolvedValue({ departments: [finance] });
    getDepartmentMock.mockResolvedValue(detail(finance));
    updateDepartmentMemberRightMock.mockResolvedValue({
      membership: { id: "m1", departmentId: "d1", userId: "u1", right: "manager", syncState: "pending", ncPermissionMask: null },
    });

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    const rightsSelect = await screen.findByLabelText(/rights for priya nair/i);

    fireEvent.change(rightsSelect, { target: { value: "manager" } });

    await waitFor(() => {
      expect(updateDepartmentMemberRightMock).toHaveBeenCalledWith("d1", "u1", "manager");
    });
    // Reloaded detail after the write (called at least twice: initial + post-write).
    await waitFor(() => {
      expect(getDepartmentMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("remove member shows the verbatim confirm copy and calls removeDepartmentMember on confirm", async () => {
    const finance = dept();
    listDepartmentsMock.mockResolvedValue({ departments: [finance] });
    getDepartmentMock.mockResolvedValue(detail(finance));
    removeDepartmentMemberMock.mockResolvedValue(undefined);

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    const removeBtn = await screen.findByRole("button", { name: /remove priya nair from finance/i });

    fireEvent.click(removeBtn);

    const dialog = await screen.findByRole("dialog", { name: /remove member/i });
    expect(dialog.textContent).toMatch(
      /Remove Priya Nair from Finance\? They lose access to these files immediately\./,
    );
    const confirmBtn = dialog.querySelector("button.danger") as HTMLButtonElement;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(removeDepartmentMemberMock).toHaveBeenCalledWith("d1", "u1");
    });
    // WARP-1809 — the toast label routes through the display helper too
    // (identity for a DEPARTMENT; defense-in-depth for the seeded unit).
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("Priya Nair removed from Finance.", "success");
    });
  });

  // WARP-1809 — the display mapping is KIND-keyed, never word-keyed: a
  // user-created DEPARTMENT that happens to be NAMED "Household" keeps its
  // raw name everywhere the removal flow prints it (confirm copy + toast).
  it("a DEPARTMENT literally named 'Household' keeps its raw name in remove confirm + toast", async () => {
    const named = dept({ name: "Household", slug: "household" });
    listDepartmentsMock.mockResolvedValue({ departments: [named] });
    getDepartmentMock.mockResolvedValue(detail(named));
    removeDepartmentMemberMock.mockResolvedValue(undefined);

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    const removeBtn = await screen.findByRole("button", { name: /remove priya nair from household/i });
    fireEvent.click(removeBtn);

    const dialog = await screen.findByRole("dialog", { name: /remove member/i });
    expect(dialog.textContent).toMatch(/Remove Priya Nair from Household\?/);
    fireEvent.click(dialog.querySelector("button.danger") as HTMLButtonElement);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("Priya Nair removed from Household.", "success");
    });
  });

  it("a HOUSEHOLD unit's rights select is disabled with the honest tooltip copy", async () => {
    const household = dept({ id: "hh", name: "Household", kind: "HOUSEHOLD", myRight: "manager" });
    listDepartmentsMock.mockResolvedValue({ departments: [household] });
    getDepartmentMock.mockResolvedValue(detail(household));

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    expect(screen.getByText("Workspace-wide access follows each person's role for now.")).toBeInTheDocument();
    expect(screen.getByLabelText(/rights for priya nair/i)).toBeDisabled();
  });
});

describe("DepartmentsPanel — failure explanations (WARP-1507)", () => {
  it("a failed department explains the provisionError and that the box auto-retries", async () => {
    const failed = dept({
      state: "failed",
      provisionError: "Groupfolder create: CSRF check failed (412)",
    });
    listDepartmentsMock.mockResolvedValue({ departments: [failed] });
    getDepartmentMock.mockResolvedValue(detail(failed));

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    // WARP-1521: assert INSIDE waitFor so each retry re-queries the live DOM.
    // Waiting on "Priya Nair" raced the detail fetch (the name also renders
    // immediately from the `people`-prop picker), and holding a reference from
    // an early commit goes stale when the detail load re-renders the panel.
    await waitFor(() => {
      // The actual reason the schema stored is shown, not just "Needs attention".
      expect(
        screen.getByText("Groupfolder create: CSRF check failed (412)"),
      ).toBeInTheDocument();
      // ...and the reassurance that it self-heals once the cause is fixed.
      expect(screen.getByText(/retries automatically/i)).toBeInTheDocument();
    });
  });

  it("a member stuck retrying exposes its syncError", async () => {
    const finance = dept();
    listDepartmentsMock.mockResolvedValue({ departments: [finance] });
    getDepartmentMock.mockResolvedValue(
      detail(finance, {
        members: [
          {
            userId: "u1",
            displayName: "Priya Nair",
            right: "contributor",
            syncState: "failed",
            syncError: "gfAddGroup: CSRF check failed (412)",
          },
        ],
      }),
    );

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);

    // WARP-1521: the chip only exists after the detail fetch commits, and
    // waiting on the member name raced it ("Priya Nair" also renders
    // immediately from the `people`-prop picker) — so wait on the chip itself,
    // re-querying inside waitFor rather than holding an early reference.
    await waitFor(() => {
      // Mouse path: the reason is on the tooltip.
      expect(screen.getByText("Retrying")).toHaveAttribute(
        "title",
        "gfAddGroup: CSRF check failed (412)",
      );
    });
    // Keyboard/screen-reader path (WCAG 2.1.1): the reason is ALSO in the
    // accessible DOM as visually-hidden text, not tooltip-only.
    const srError = screen.getByText("gfAddGroup: CSRF check failed (412)");
    expect(srError).toBeInTheDocument();
    expect(srError).toHaveClass("sr-only");
  });

  it("does not render a failure notice for a healthy active department", async () => {
    const finance = dept();
    listDepartmentsMock.mockResolvedValue({ departments: [finance] });
    getDepartmentMock.mockResolvedValue(detail(finance));

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    expect(screen.queryByText(/retries automatically/i)).not.toBeInTheDocument();
  });
});

describe("DepartmentsPanel — select focus visibility (WCAG 2.4.7)", () => {
  // fieldStyle sets `border: 1px solid var(--border)` INLINE, which outranks any
  // stylesheet `focus:border-*` rule — so the visible focus treatment MUST be a
  // ring (box-shadow), which an inline border cannot defeat. Pin that on all
  // three converted selects. (WARP-1347)
  it("all three converted selects carry a focus ring, not the inline-border-defeated focus:border", async () => {
    const finance = dept();
    listDepartmentsMock.mockResolvedValue({ departments: [finance] });
    getDepartmentMock.mockResolvedValue(detail(finance));

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);

    const rightsSelect = await screen.findByLabelText(/rights for priya nair/i);
    const personSelect = await screen.findByLabelText(/^person to add$/i);
    const newMemberRightSelect = screen.getByLabelText(/^rights for new member$/i);

    for (const el of [rightsSelect, personSelect, newMemberRightSelect]) {
      expect(el.className).toContain("focus:ring-2");
      expect(el.className).toContain("focus:ring-[var(--brand)]");
      expect(el.className).not.toContain("focus:border-[var(--brand)]");
    }
  });

  // WARP-1353: the create-dialog fields carried a bare `outline-none` with NO
  // replacement affordance at all — keyboard users got zero focus indicator.
  // They wear the same inline-border `fieldStyle`, so the fix is the same ring,
  // and `focus:border-*` would be a silent no-op here for the same reason.
  it("every create-dialog field carries a focus ring instead of a bare outline-none", async () => {
    listDepartmentsMock.mockResolvedValue({ departments: [] });

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    await waitFor(() => expect(screen.getByText("No departments yet")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /new department/i }));
    const dialog = await screen.findByRole("dialog");

    const nameInput = within(dialog).getByPlaceholderText("Finance");
    const quotaAmount = within(dialog).getByLabelText(/^quota amount$/i);
    const quotaUnit = within(dialog).getByLabelText(/^quota unit$/i);
    // The description field has no placeholder and its <label> is not wired via
    // htmlFor, so reach it positionally: the second text input in the dialog.
    const textInputs = Array.from(
      dialog.querySelectorAll<HTMLInputElement>('input:not([type="number"])'),
    );
    expect(textInputs).toHaveLength(2);
    const descriptionInput = textInputs[1];
    expect(descriptionInput).not.toBe(nameInput);

    for (const el of [nameInput, descriptionInput, quotaAmount, quotaUnit]) {
      expect(el.className).toContain("outline-none");
      expect(el.className).toContain("focus:ring-2");
      expect(el.className).toContain("focus:ring-[var(--brand)]");
      // An inline `border` from fieldStyle would defeat a focus:border rule.
      expect(el.className).not.toContain("focus:border-[var(--brand)]");
      expect((el as HTMLElement).style.border).toBe("1px solid var(--border)");
    }
  });

  // WARP-1353: `dslug` was defined in no stylesheet anywhere in the repo.
  it("the slug preview carries no dead dslug class", async () => {
    listDepartmentsMock.mockResolvedValue({ departments: [] });

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    await waitFor(() => expect(screen.getByText("No departments yet")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /new department/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Finance"), {
      target: { value: "Legal Team" },
    });

    expect(within(dialog).getByText("legal-team")).toBeInTheDocument();
    expect(dialog.querySelector(".dslug")).toBeNull();
  });
});

describe("DepartmentsPanel — create department", () => {
  it("shows a live mono slug preview and submits the create payload", async () => {
    listDepartmentsMock.mockResolvedValue({ departments: [] });
    createDepartmentMock.mockResolvedValue({
      department: dept({ id: "d2", name: "Legal", slug: "legal" }),
      warning: null,
    });

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    await waitFor(() => expect(screen.getByText("No departments yet")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /new department/i }));
    const dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByPlaceholderText("Finance");
    fireEvent.change(nameInput, { target: { value: "Legal Team" } });

    expect(within(dialog).getByText("legal-team")).toBeInTheDocument();

    // After creating, the panel reloads the list — return the new dept.
    listDepartmentsMock.mockResolvedValueOnce({
      departments: [dept({ id: "d2", name: "Legal Team", slug: "legal-team" })],
    });
    getDepartmentMock.mockResolvedValue(
      detail(dept({ id: "d2", name: "Legal Team", slug: "legal-team" })),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: /create department/i }));

    await waitFor(() => {
      expect(createDepartmentMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Legal Team" }),
      );
    });
  });
});

describe("DepartmentsPanel — archive / restore", () => {
  it("archive confirm shows verbatim copy and calls archiveDepartment", async () => {
    const finance = dept();
    listDepartmentsMock.mockResolvedValue({ departments: [finance] });
    getDepartmentMock.mockResolvedValue(detail(finance));
    archiveDepartmentMock.mockResolvedValue({ department: { ...finance, state: "archiving" } });

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = await screen.findByRole("dialog", { name: /archive finance/i });
    expect(dialog.textContent).toMatch(
      /Files stay stored and admins can still retrieve them\. Members lose access now\./,
    );
    const confirmBtn = dialog.querySelector("button.danger") as HTMLButtonElement;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(archiveDepartmentMock).toHaveBeenCalledWith("d1");
    });
    // WARP-1809 — archive toast label routes through the display helper.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("Finance archived.", "success");
    });
  });

  it("an archived unit shows Restore instead of Archive; confirming calls restoreDepartment", async () => {
    const archived = dept({ state: "archived", archivedAt: "2026-06-01T00:00:00Z" });
    listDepartmentsMock.mockResolvedValue({ departments: [archived] });
    getDepartmentMock.mockResolvedValue(detail(archived));
    restoreDepartmentMock.mockResolvedValue({ department: { ...archived, state: "pending" } });

    render(<DepartmentsPanel people={PEOPLE} isAdminTier />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));

    const dialog = await screen.findByRole("dialog", { name: /restore finance/i });
    expect(dialog.textContent).toMatch(
      /Members regain access with the rights they had before it was archived\./,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /^restore$/i }));

    await waitFor(() => {
      expect(restoreDepartmentMock).toHaveBeenCalledWith("d1");
    });
    // WARP-1809 — restore toast label routes through the display helper.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("Finance is being restored…", "success");
    });
  });

  it("archive/restore controls are absent for a non-admin manager", async () => {
    const finance = dept({ myRight: "manager" });
    listDepartmentsMock.mockResolvedValue({ departments: [finance] });
    getDepartmentMock.mockResolvedValue(detail(finance));

    render(<DepartmentsPanel people={PEOPLE} isAdminTier={false} />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    // But member management (a manager-right unit) IS available. The rights
    // control lands after the detail fetch (getDepartmentMock) resolves — a
    // second async hop past the name — so on slow CI runners it must be
    // awaited rather than asserted on synchronously right after the name.
    expect(await screen.findByLabelText(/rights for priya nair/i)).not.toBeDisabled();
  });
});
