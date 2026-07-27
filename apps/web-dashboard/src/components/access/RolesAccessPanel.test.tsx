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
const restoreAccessRoleMock = vi.fn();
const assignAccessRoleMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listAccessRoles: (...a: any[]) => listAccessRolesMock(...a),
  createAccessRole: (...a: any[]) => createAccessRoleMock(...a),
  updateAccessRole: (...a: any[]) => updateAccessRoleMock(...a),
  deleteAccessRole: (...a: any[]) => deleteAccessRoleMock(...a),
  duplicateAccessRole: (...a: any[]) => duplicateAccessRoleMock(...a),
  archiveAccessRole: (...a: any[]) => archiveAccessRoleMock(...a),
  restoreAccessRole: (...a: any[]) => restoreAccessRoleMock(...a),
  assignAccessRole: (...a: any[]) => assignAccessRoleMock(...a),
}));

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import { RolesAccessPanel } from "./RolesAccessPanel";
import { ToastProvider } from "@/components/Toast";
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
    // §4.1 (UX-10): the pane's primary action is filled accent.
    expect(screen.getByRole("button", { name: /New role/ }).className).toContain("primary");
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

  it("delete-in-use is never a dead-end: Reassign people → focuses the holders list (QA send-back 3)", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Role actions" }));
    const reassign = screen.getByRole("menuitem", { name: ACCESS_COPY.reassignPeopleLink });
    fireEvent.click(reassign);
    // Menu closed, focus handed to the people-with-this-role block.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId("access-people-with-role"));
  });

  it("assign candidates fail closed on unknown tiers, with an honest empty caption (QA send-back 4)", async () => {
    // Degraded roster: no role data at all (pre-T3/T7 API) — the owner row
    // must NOT sneak into the candidate list; nothing is offered.
    renderPanel({
      people: PEOPLE.map(({ role: _role, ...p }) => ({ ...p, accessRoleId: null })),
    });
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Assign people" }));
    const dialog = await screen.findByRole("dialog", { name: /Assign people/ });
    expect(within(dialog).queryByText("Stefan C")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "No one can be offered yet — this Droplet hasn't reported everyone's current role.",
      ),
    ).toBeInTheDocument();
  });

  it("built-in detail carries the read-only catalog summary; service keeps notes only (QA send-back 5)", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Admin/ }));
    const detail = screen.getByTestId("access-role-detail");
    // Ceiling levels for the admin tier, catalog-derived.
    expect(within(detail).getByText("Network · configure")).toBeInTheDocument();
    expect(within(detail).getByText("Files · share & manage")).toBeInTheDocument();
    expect(within(detail).getByText("No limit storage")).toBeInTheDocument();
    expect(within(detail).getByText(ACCESS_COPY.builtinFixed)).toBeInTheDocument();
    // Guest ceilings clamp to view.
    fireEvent.click(screen.getByRole("button", { name: /Guest/ }));
    expect(within(screen.getByTestId("access-role-detail")).getByText("Network · view")).toBeInTheDocument();
    // Service is a system principal — notes only, no feature chips.
    fireEvent.click(screen.getByRole("button", { name: /Service/ }));
    const serviceDetail = screen.getByTestId("access-role-detail");
    expect(within(serviceDetail).queryByText(/Network ·/)).not.toBeInTheDocument();
    expect(within(serviceDetail).getByText(/Not assignable to a person/)).toBeInTheDocument();
  });

  it("prefers the server peopleCount and renders — (not the empty claim) when roster rows can't be linked", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role({ peopleCount: 2 })] });
    renderPanel({
      // Roster has no accessRoleId data — the join can't resolve holders.
      people: PEOPLE.map((p) => ({ ...p, accessRoleId: null })),
    });
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    const list = screen.getByTestId("access-people-with-role");
    expect(within(list).getByText("2")).toBeInTheDocument();
    expect(within(list).queryByText(ACCESS_COPY.emptyPeopleInRole)).not.toBeInTheDocument();
    expect(within(list).getByText(ACCESS_COPY.unknownValue)).toBeInTheDocument();
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

  it("a failed delete surfaces an error toast — never a silent failure (§10 / UX-3)", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role({ peopleCount: 0 })] });
    deleteAccessRoleMock.mockRejectedValue(new Error("Role delete blocked by the box"));
    render(
      <ToastProvider>
        <RolesAccessPanel
          people={PEOPLE.map((p) => ({ ...p, accessRoleId: null }))}
          actingTier="owner"
          connectors={[]}
          onOpenPerson={vi.fn()}
          onOpenDepartments={vi.fn()}
        />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Role actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
    await waitFor(() =>
      expect(screen.getByText("Role delete blocked by the box")).toBeInTheDocument(),
    );
  });

  it("archive runs a consequence confirm carrying the packet's restore promise (WARP-1560)", async () => {
    archiveAccessRoleMock.mockResolvedValue({ role: role({ state: "archived" }) });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Role actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
    // T8 cut the second sentence because nothing could deliver on it. The
    // Archived section + Restore below are what make it true again.
    expect(screen.getByText(ACCESS_COPY.archiveRole)).toBeInTheDocument();
    expect(screen.getByText(/restore them any time/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveAccessRoleMock).toHaveBeenCalledWith("r-finance"));
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
    // UX-8: the helper mirrors §12 sessionRevoke semantics — immediately,
    // not "when they sign back in".
    expect(
      within(dialog).getByText(
        "Assigning applies immediately — people are signed out and their new access takes effect immediately.",
      ),
    ).toBeInTheDocument();
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

// ── WARP-1528: the sync-chip contract fix ────────────────────────────
//
// The API returns `syncState` as a SIBLING of `role` — `{ role, syncState }`
// on the mutations, and `serializeAccessRole` never puts it INSIDE the role
// row (so `role.syncState` is `undefined` against a real box, and the
// "Applying…" chip the §10 states checklist requires could never appear).
// `lib/api.ts` has always typed the sibling correctly; the panel was reading
// the wrong place. These pin the sibling being read — and the pre-T4
// list-borne field still working, so an orchestrator that later starts
// emitting it on reads isn't a regression.
describe("WARP-1528 — sync chip reads the sibling syncState", () => {
  it("shows Applying… after a create whose response carries a pending sibling", async () => {
    // The role list, as a real box serves it: no syncState on the row.
    const listed = role({ id: "r-new", name: "Reception", slug: "reception" });
    delete (listed as { syncState?: unknown }).syncState;
    createAccessRoleMock.mockResolvedValue({ role: listed, syncState: "pending" });
    listAccessRolesMock.mockResolvedValue({ roles: [listed] });

    renderPanel();
    await waitFor(() => expect(screen.getByText("Reception")).toBeInTheDocument());
    // Nothing pending yet.
    expect(screen.queryByText(ACCESS_COPY.applying)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New role" }));
    const name = await screen.findByPlaceholderText("Name this role");
    fireEvent.change(name, { target: { value: "Reception" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));

    await waitFor(() => expect(screen.getAllByText(ACCESS_COPY.applying).length).toBeGreaterThan(0));
  });

  it("shows Applying… after an assign whose response carries a pending sibling", async () => {
    const listed = role();
    delete (listed as { syncState?: unknown }).syncState;
    listAccessRolesMock.mockResolvedValue({ roles: [listed] });
    assignAccessRoleMock.mockResolvedValue({ syncState: "pending" });

    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    expect(screen.queryByText(ACCESS_COPY.applying)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Assign people" }));
    const dialog = await screen.findByRole("dialog", { name: /Assign people/ });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Sam Ortega/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(screen.getAllByText(ACCESS_COPY.applying).length).toBeGreaterThan(0));
  });

  it("completes the §10 sequence: Applying… → Applied, then fades", async () => {
    // UX (WARP-1528): SyncChip's `applied` arm was unreachable because the only
    // terminal-success value mapped to null — so the chip DISAPPEARED on
    // success, which is indistinguishable from the chip never appearing (the
    // bug this panel just fixed). Nobody could tell convergence from
    // regression. The client legitimately knows its write returned 2xx and the
    // re-read succeeded; that is exactly what `Applied` claims.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listed = role();
      delete (listed as { syncState?: unknown }).syncState;
      listAccessRolesMock.mockResolvedValue({ roles: [listed] });
      assignAccessRoleMock.mockResolvedValue({ syncState: "pending" });

      renderPanel();
      await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
      fireEvent.click(screen.getByRole("button", { name: "Assign people" }));
      const dialog = await screen.findByRole("dialog", { name: /Assign people/ });
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /Sam Ortega/ }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));

      await waitFor(() =>
        expect(screen.getAllByText(ACCESS_COPY.applying).length).toBeGreaterThan(0),
      );

      // The delayed re-read lands → the terminal beat, NOT disappearance.
      await vi.advanceTimersByTimeAsync(1600);
      await waitFor(() =>
        expect(screen.getAllByText(ACCESS_COPY.applied).length).toBeGreaterThan(0),
      );
      expect(screen.queryByText(ACCESS_COPY.applying)).not.toBeInTheDocument();

      // …and then it retires itself rather than accumulating green ticks.
      await vi.advanceTimersByTimeAsync(4100);
      await waitFor(() =>
        expect(screen.queryByText(ACCESS_COPY.applied)).not.toBeInTheDocument(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a mutation that returns `synced` lands straight on Applied (no false pending)", async () => {
    const listed = role({ id: "r-new", name: "Reception", slug: "reception" });
    delete (listed as { syncState?: unknown }).syncState;
    // The T3 create path answers `synced` — nothing cascaded, nothing to wait
    // for. Showing "Applying…" first would claim a wait that never happened.
    createAccessRoleMock.mockResolvedValue({ role: listed, syncState: "synced" });
    listAccessRolesMock.mockResolvedValue({ roles: [listed] });

    renderPanel();
    await waitFor(() => expect(screen.getByText("Reception")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New role" }));
    const name = await screen.findByPlaceholderText("Name this role");
    fireEvent.change(name, { target: { value: "Reception" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));

    await waitFor(() => expect(screen.getAllByText(ACCESS_COPY.applied).length).toBeGreaterThan(0));
    expect(screen.queryByText(ACCESS_COPY.applying)).not.toBeInTheDocument();
  });

  it("a role merely AT REST in `synced` shows no chip (§12 — not a green tick per card)", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role({ syncState: "synced" })] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    expect(screen.queryByText(ACCESS_COPY.applied)).not.toBeInTheDocument();
    expect(screen.queryByText(ACCESS_COPY.applying)).not.toBeInTheDocument();
  });

  it("still honors a list-borne role.syncState (forward-compatible fallback)", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role({ syncState: "failed" })] });
    renderPanel();
    await waitFor(() =>
      expect(screen.getAllByText(ACCESS_COPY.needsAttention).length).toBeGreaterThan(0),
    );
  });
});

describe("§10 offline", () => {
  it("renders the verbatim offline banner when the browser is offline", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    renderPanel();
    await waitFor(() => expect(screen.getByText(ACCESS_COPY.offlineBanner)).toBeInTheDocument());
  });
});

// ── WARP-1560: archived roles are FILED, not vanished ────────────────
//
// T8 filtered `state === "archived"` out of the list entirely, which made
// archive a one-way door with no surface to walk back through — and forced
// the archive copy to drop its restore sentence. `GET /api/access/roles`
// has always returned archived rows carrying their `state` precisely so the
// client can group by it (effective-access.service.ts's ARCHIVE ≠ REVOKE
// note); these pin the client finally doing so.
describe("WARP-1560 — archived roles + restore", () => {
  const archived = () =>
    role({ id: "r-old", name: "Locum", slug: "locum", state: "archived", peopleCount: 0 });

  it("files an archived role under its own section instead of dropping it", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role(), archived()] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    expect(screen.getByText(ACCESS_COPY.archivedRoles)).toBeInTheDocument();
    const section = screen.getByTestId("access-archived-roles");
    expect(within(section).getByText("Locum")).toBeInTheDocument();
    expect(within(section).getByText(ACCESS_COPY.archived)).toBeInTheDocument();
    // …and never mixed back into the assignable list.
    const active = screen.getByTestId("access-active-roles");
    expect(within(active).queryByText("Locum")).not.toBeInTheDocument();
  });

  it("shows no Archived section at all when nothing is archived", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role()] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    expect(screen.queryByText(ACCESS_COPY.archivedRoles)).not.toBeInTheDocument();
  });

  it("an active role still wins auto-selection over an archived one", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [archived(), role()] });
    renderPanel();
    const detail = await screen.findByTestId("access-role-detail");
    await waitFor(() => expect(within(detail).getByText("Finance")).toBeInTheDocument());
  });

  it("says so honestly when every custom role is archived", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [archived()] });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(ACCESS_COPY.emptyRolesAllArchived)).toBeInTheDocument(),
    );
    // "No custom roles yet" would be a lie — one exists, it is filed.
    expect(screen.queryByText(ACCESS_COPY.emptyRoles)).not.toBeInTheDocument();
  });

  it("offers Restore on an archived role and never Archive… twice", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [archived()] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Locum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Locum/ }));
    expect(screen.getByRole("button", { name: /Restore/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Role actions" }));
    expect(screen.queryByRole("menuitem", { name: /Archive/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toBeInTheDocument();
  });

  it("blocks assignment on an archived role DISABLED with the reason, never hidden", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [archived()] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Locum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Locum/ }));
    const assign = screen.getByRole("button", { name: /Assign people/ });
    expect(assign).toBeDisabled();
    // Shown, not hover-only: the reason is the payload.
    const note = screen.getByText(ACCESS_COPY.archivedNotAssignable);
    expect(note).toBeInTheDocument();
    // …and wired to the control it explains. A disabled button announces no
    // `title` anyone can rely on, so the association has to be explicit.
    const describedBy = assign.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toContainElement(note);
  });

  it("confirming Restore PATCHes state → active, refetches, and reports the sync", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [archived()] });
    restoreAccessRoleMock.mockResolvedValue({
      role: { ...archived(), state: "active" },
      syncState: "pending",
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Locum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Locum/ }));
    fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(ACCESS_COPY.restoreRole)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore role" }));
    await waitFor(() => expect(restoreAccessRoleMock).toHaveBeenCalledWith("r-old"));
    await waitFor(() => expect(listAccessRolesMock.mock.calls.length).toBeGreaterThan(1));
    // The restore's usage tail is real — pass 2 picks these members back up
    // — so the chip has something true to say.
    await waitFor(() =>
      expect(screen.getAllByText(ACCESS_COPY.applying).length).toBeGreaterThan(0),
    );
  });

  it("a failed restore surfaces an error toast — never a silent failure (§10)", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [archived()] });
    restoreAccessRoleMock.mockRejectedValue(new Error("Restore blocked by the box"));
    // Toasts need their provider mounted (the delete-failure sibling above
    // does the same) — `renderPanel` deliberately runs without one.
    render(
      <ToastProvider>
        <RolesAccessPanel
          people={PEOPLE}
          actingTier="owner"
          connectors={[]}
          onOpenPerson={vi.fn()}
          onOpenDepartments={vi.fn()}
        />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText("Locum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Locum/ }));
    fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore role" }));
    await waitFor(() =>
      expect(screen.getByText("Restore blocked by the box")).toBeInTheDocument(),
    );
  });
});


// ── WARP-1576: the cleared-storage-default disclosure ────────────────
//
// Clearing a role's storage default is the one usage edit that pushes
// NOTHING (a cleared default means "unmanaged", never "unlimited"), so the
// members who had no quota of their own silently stay on whatever Nextcloud
// already enforces. The API has always returned `retainedQuotaCount` to say
// how many; T8 shipped with no consumer, so the operator got silence.
describe("WARP-1576 — retainedQuotaCount is surfaced, not swallowed", () => {
  /** The role carries a limit BEFORE the edit and none after — a change
   *  event on an already-empty input never reaches React, so a role seeded
   *  as already-cleared could not be cleared. */
  function seedListClearedAfterFirstLoad() {
    listAccessRolesMock.mockResolvedValueOnce({ roles: [role()] });
    listAccessRolesMock.mockResolvedValue({ roles: [role({ storageQuotaBytes: null })] });
  }

  async function clearStorageAndSave() {
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
    const storage = await screen.findByLabelText("Storage limit");
    fireEvent.change(storage, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    await waitFor(() => expect(updateAccessRoleMock).toHaveBeenCalled());
    expect(updateAccessRoleMock.mock.calls[0][1].storageQuotaBytes).toBeNull();
  }

  it("states how many people were left on a retained quota", async () => {
    seedListClearedAfterFirstLoad();
    updateAccessRoleMock.mockResolvedValue({
      role: role({ storageQuotaBytes: null }),
      syncState: "synced",
      retainedQuotaCount: 3,
    });
    renderPanel();
    await clearStorageAndSave();

    await waitFor(() =>
      expect(screen.getByText(ACCESS_COPY.retainedQuota(3))).toBeInTheDocument(),
    );
  });

  it("uses the singular form for one person", async () => {
    seedListClearedAfterFirstLoad();
    updateAccessRoleMock.mockResolvedValue({
      role: role({ storageQuotaBytes: null }),
      syncState: "synced",
      retainedQuotaCount: 1,
    });
    renderPanel();
    await clearStorageAndSave();

    await waitFor(() =>
      expect(
        screen.getByText("1 person keeps their current storage limit until it's changed."),
      ).toBeInTheDocument(),
    );
  });

  it("says nothing when the clear left nobody on a retained quota", async () => {
    seedListClearedAfterFirstLoad();
    updateAccessRoleMock.mockResolvedValue({
      role: role({ storageQuotaBytes: null }),
      syncState: "synced",
      retainedQuotaCount: 0,
    });
    renderPanel();
    await clearStorageAndSave();

    expect(screen.queryByText(/keeps? their current storage limit/)).not.toBeInTheDocument();
  });

  it("says nothing on an ordinary save — the field only comes back on a CLEAR", async () => {
    updateAccessRoleMock.mockResolvedValue({ role: role(), syncState: "pending" });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
    // Edit mode labels the name field rather than placeholder-ing it.
    const name = await screen.findByLabelText("Role name");
    fireEvent.change(name, { target: { value: "Finance & billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));

    await waitFor(() => expect(updateAccessRoleMock).toHaveBeenCalled());
    expect(screen.queryByText(/keeps? their current storage limit/)).not.toBeInTheDocument();
  });

  it("a later save that no longer clears anything retires the line", async () => {
    seedListClearedAfterFirstLoad();
    updateAccessRoleMock.mockResolvedValueOnce({
      role: role({ storageQuotaBytes: null }),
      syncState: "synced",
      retainedQuotaCount: 2,
    });
    renderPanel();
    await clearStorageAndSave();
    await waitFor(() =>
      expect(screen.getByText(ACCESS_COPY.retainedQuota(2))).toBeInTheDocument(),
    );

    updateAccessRoleMock.mockResolvedValueOnce({ role: role(), syncState: "pending" });
    fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
    const name = await screen.findByLabelText("Role name");
    fireEvent.change(name, { target: { value: "Finance & billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));

    await waitFor(() =>
      expect(screen.queryByText(ACCESS_COPY.retainedQuota(2))).not.toBeInTheDocument(),
    );
  });
});
