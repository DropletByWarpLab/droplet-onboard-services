/**
 * WARP-1532 (RBAC v2 T8) — Surface A: the "Roles & access" tab panel.
 *
 * Covers the §10 state trios (loading skeletons / §4.1 empty / error+Retry),
 * the Your-roles + Built-in sections, the read-only built-in details (owner
 * untouchable note, service not-assignable), the custom-role detail (axis
 * summaries, people-with-this-role, assign multi-select), the overflow menu
 * (duplicate / archive / delete-with-in-use-guard), sync chips (Applying… /
 * Needs attention), and the offline banner. All against mocked api — the
 * backend (T3) builds in parallel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const listAccessRolesMock = vi.fn();
const createAccessRoleMock = vi.fn();
const updateAccessRoleMock = vi.fn();
const deleteAccessRoleMock = vi.fn();
const duplicateAccessRoleMock = vi.fn();
const archiveAccessRoleMock = vi.fn();
const assignAccessRoleMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listAccessRoles: (...a: any[]) => listAccessRolesMock(...a),
  createAccessRole: (...a: any[]) => createAccessRoleMock(...a),
  updateAccessRole: (...a: any[]) => updateAccessRoleMock(...a),
  deleteAccessRole: (...a: any[]) => deleteAccessRoleMock(...a),
  duplicateAccessRole: (...a: any[]) => duplicateAccessRoleMock(...a),
  archiveAccessRole: (...a: any[]) => archiveAccessRoleMock(...a),
  assignAccessRole: (...a: any[]) => assignAccessRoleMock(...a),
}));

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import { RolesAccessPanel } from "./RolesAccessPanel";
import { ACCESS_COPY } from "./copy";
import type { AccessRole, RosterUser } from "@/lib/types";

function role(overrides: Partial<AccessRole> = {}): AccessRole {
  return {
    id: "r-finance",
    name: "Finance",
    slug: "finance",
    description: "Bookkeeping and billing staff",
    startingPoint: "family",
    state: "active",
    storageQuotaBytes: "26843545600",
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    createdBy: "u0",
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
    peopleCount: 1,
    syncState: "synced",
    featureGrants: [
      { moduleId: "files", level: "act" },
      { moduleId: "cameras", level: "view" },
    ],
    toolGrants: [{ domain: "files", level: "use" }],
    connectorGrants: [{ provider: "eaglesoft", level: "read" }],
    ...overrides,
  };
}

const PEOPLE: RosterUser[] = [
  { id: "stefan", username: "stefan", displayName: "Stefan C", userId: "u-owner", role: "owner", accessRoleId: null },
  { id: "priya", username: "priya", displayName: "Priya Nair", userId: "u-priya", role: "family", accessRoleId: "r-finance" },
  { id: "sam", username: "sam", displayName: "Sam Ortega", userId: "u-sam", role: "family", accessRoleId: null },
];

function renderPanel(props: Partial<React.ComponentProps<typeof RolesAccessPanel>> = {}) {
  const onOpenPerson = vi.fn();
  const onOpenDepartments = vi.fn();
  const utils = render(
    <RolesAccessPanel
      people={PEOPLE}
      actingTier="owner"
      connectors={[{ provider: "eaglesoft", label: "Eaglesoft" }]}
      onOpenPerson={onOpenPerson}
      onOpenDepartments={onOpenDepartments}
      {...props}
    />,
  );
  return { onOpenPerson, onOpenDepartments, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  listAccessRolesMock.mockResolvedValue({ roles: [role()] });
});

afterEach(() => {
  // Restore onLine if a test flipped it.
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
});

describe("§10 state trio — roles list", () => {
  it("loading renders skeleton cards", () => {
    listAccessRolesMock.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getAllByTestId("access-roles-skeleton").length).toBeGreaterThan(0);
  });

  it("error renders the §12 error card with a working Retry", async () => {
    listAccessRolesMock.mockRejectedValueOnce(new Error("boom"));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(ACCESS_COPY.rolesErrorTitle)).toBeInTheDocument();
    });
    listAccessRolesMock.mockResolvedValueOnce({ roles: [role()] });
    fireEvent.click(screen.getByRole("button", { name: ACCESS_COPY.retry }));
    await waitFor(() => {
      expect(screen.getByText("Finance")).toBeInTheDocument();
    });
  });

  it("empty renders the verbatim §4.1 copy with built-ins still listed", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [] });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(ACCESS_COPY.emptyRoles)).toBeInTheDocument();
    });
    // Built-in five remain listed beneath (Staff display label, never Family).
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Staff")).toBeInTheDocument();
    expect(screen.getByText("Service")).toBeInTheDocument();
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
  });
});

describe("§4.1 roles list", () => {
  it("renders a role card with slug + people + starting-point meta", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    // Slug renders on the card and again in the auto-selected detail head.
    expect(screen.getAllByText("finance").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 person · based on Staff/)).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.yourRoles)).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.builtinRoles)).toBeInTheDocument();
  });

  it("shows the Applying… chip on a pending role and Needs attention on a failed one", async () => {
    listAccessRolesMock.mockResolvedValue({
      roles: [role({ syncState: "pending" }), role({ id: "r2", name: "Ops", slug: "ops", syncState: "failed" })],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(ACCESS_COPY.applying)).toBeInTheDocument());
    expect(screen.getByText(ACCESS_COPY.needsAttention)).toBeInTheDocument();
  });

  it("owner built-in row carries the §12 meta; selecting it shows the untouchable note", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    expect(screen.getByText(ACCESS_COPY.ownerRowMeta)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Owner/ }));
    expect(screen.getByText(ACCESS_COPY.builtinFixed)).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.ownerDetailNote)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit role" })).not.toBeInTheDocument();
  });
});

describe("§4.2 role detail", () => {
  it("summarises the four axes and lists people with this role", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    const detail = screen.getByTestId("access-role-detail");
    expect(within(detail).getByText(/Based on Staff/)).toBeInTheDocument();
    expect(within(detail).getByText(/Files · edit/i)).toBeInTheDocument();
    expect(within(detail).getByText(/25 GB storage/)).toBeInTheDocument();
    expect(within(detail).getByText(/Cloud models off/)).toBeInTheDocument();
    expect(within(detail).getByText(/eaglesoft · read/i)).toBeInTheDocument();
    expect(within(detail).getByText(ACCESS_COPY.peopleWithRole)).toBeInTheDocument();
    expect(within(detail).getByText("Priya Nair")).toBeInTheDocument();
  });

  it("shows the verbatim empty copy when no one holds the role", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role({ peopleCount: 0 })] });
    renderPanel({
      people: PEOPLE.map((p) => ({ ...p, accessRoleId: null })),
    });
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    expect(screen.getByText(ACCESS_COPY.emptyPeopleInRole)).toBeInTheDocument();
  });

  it("Change role → hands the person to the page-level editor", async () => {
    const { onOpenPerson } = renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: /Change role/ }));
    expect(onOpenPerson).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-priya" }));
  });

  it("delete is disabled with the §12 in-use reason while people hold the role", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Role actions" }));
    const del = screen.getByRole("menuitem", { name: /Delete/ });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("title", ACCESS_COPY.deleteRoleInUse(1));
  });

  it("deleting an unused role runs the §8 consequence confirm then the DELETE", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role({ peopleCount: 0 })] });
    deleteAccessRoleMock.mockResolvedValue(undefined);
    renderPanel({ people: PEOPLE.map((p) => ({ ...p, accessRoleId: null })) });
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Role actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(screen.getByText(ACCESS_COPY.deleteRoleUnused("Finance"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
    await waitFor(() => expect(deleteAccessRoleMock).toHaveBeenCalledWith("r-finance"));
  });

  it("duplicate POSTs sourceRoleId and refreshes the list", async () => {
    duplicateAccessRoleMock.mockResolvedValue({ role: role({ id: "r2", name: "Finance copy", slug: "finance-copy" }) });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Role actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Duplicate/ }));
    await waitFor(() => expect(duplicateAccessRoleMock).toHaveBeenCalledWith("r-finance"));
    expect(listAccessRolesMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("assign people opens a multi-select (owner + service never offered) and POSTs userIds", async () => {
    assignAccessRoleMock.mockResolvedValue({ syncState: "pending" });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Assign people" }));
    const dialog = await screen.findByRole("dialog", { name: /Assign people/ });
    // Owner rows are untouchable — never offered for assignment.
    expect(within(dialog).queryByText("Stefan C")).not.toBeInTheDocument();
    // Priya already holds the role — only Sam is offered.
    expect(within(dialog).queryByText("Priya Nair")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Sam Ortega/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));
    await waitFor(() =>
      expect(assignAccessRoleMock).toHaveBeenCalledWith("r-finance", ["u-sam"]),
    );
  });

  it("New role opens the builder in create mode; saving POSTs and refetches", async () => {
    createAccessRoleMock.mockResolvedValue({ role: role({ id: "r-new" }), syncState: "pending" });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New role" }));
    const name = await screen.findByPlaceholderText("Name this role");
    fireEvent.change(name, { target: { value: "Reception" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    await waitFor(() => expect(createAccessRoleMock).toHaveBeenCalled());
    expect(createAccessRoleMock.mock.calls[0][0].name).toBe("Reception");
    await waitFor(() => expect(listAccessRolesMock.mock.calls.length).toBeGreaterThan(1));
  });
});

describe("§10 offline", () => {
  it("renders the verbatim offline banner when the browser is offline", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    renderPanel();
    await waitFor(() => expect(screen.getByText(ACCESS_COPY.offlineBanner)).toBeInTheDocument());
  });
});
