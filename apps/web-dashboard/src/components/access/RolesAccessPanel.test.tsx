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
const listRoleTemplatesMock = vi.fn();
const createRoleFromTemplateMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listAccessRoles: (...a: any[]) => listAccessRolesMock(...a),
  createAccessRole: (...a: any[]) => createAccessRoleMock(...a),
  updateAccessRole: (...a: any[]) => updateAccessRoleMock(...a),
  deleteAccessRole: (...a: any[]) => deleteAccessRoleMock(...a),
  duplicateAccessRole: (...a: any[]) => duplicateAccessRoleMock(...a),
  archiveAccessRole: (...a: any[]) => archiveAccessRoleMock(...a),
  restoreAccessRole: (...a: any[]) => restoreAccessRoleMock(...a),
  assignAccessRole: (...a: any[]) => assignAccessRoleMock(...a),
  // WARP-2738 — the gallery reads the catalogue and the panel instantiates
  // from it. A named export missing from this factory throws on first access,
  // so the mock moves with the component's imports.
  listRoleTemplates: (...a: any[]) => listRoleTemplatesMock(...a),
  createRoleFromTemplate: (...a: any[]) => createRoleFromTemplateMock(...a),
}));

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import { RolesAccessPanel, roleBuilderSheetKey } from "./RolesAccessPanel";
import { ToastProvider } from "@/components/Toast";
import { ACCESS_COPY } from "./copy";
import { blankRoleDraft, templateToDraft } from "@/lib/access";
import type { AccessRole, RoleTemplate, RosterUser } from "@/lib/types";

/** A small made-up catalogue. The SERVER owns the real one (and pins it in
 *  `access-role-templates.test.ts`); these fixtures exist only to drive the
 *  panel's two create paths. */
function tpl(overrides: Partial<RoleTemplate> = {}): RoleTemplate {
  return {
    id: "front-desk",
    name: "Front Desk",
    description: "Reception and front-of-house.",
    startingPoint: "family",
    featureGrants: [
      { moduleId: "files", level: "act" },
      { moduleId: "calendar", level: "manage" },
    ],
    toolGrants: [{ domain: "files", level: "view" }],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
    ...overrides,
  };
}

const TEMPLATES = {
  roleTemplates: [tpl(), tpl({ id: "bookkeeper", name: "Bookkeeper", startingPoint: "admin" })],
  enforcedModuleIds: ["files", "knowledge", "docs", "cameras", "network", "smart_home", "crm", "money"],
};

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
  listRoleTemplatesMock.mockResolvedValue(TEMPLATES);
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

// ── WARP-2738: the role-template gallery, wired into both entry points ──
//
// ADR-032 shipped the engine and nothing to start from. Two things had to be
// fixed for a template to be usable, and both fail SILENTLY when they break:
//
//   1. the empty state holds the ONLY create CTA on a fresh box (the header's
//      New-role button is conditioned on there already being roles), so the
//      gallery has to live there, without displacing the blank path;
//   2. the builder computes `dirty` as a JSON diff against `base`, so a sheet
//      pre-filled FROM base is born non-dirty and Save is disabled — a
//      complete-looking role with a greyed button and no reason given.
describe("WARP-2738 — the template gallery", () => {
  it("renders in the §4.1 empty state, WITHOUT orphaning the blank New role path", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText(ACCESS_COPY.emptyRoles)).toBeInTheDocument());
    // The gallery is present…
    expect(await screen.findByTestId("access-template-gallery")).toBeInTheDocument();
    expect(screen.getByText("Front Desk")).toBeInTheDocument();
    // …and starting from nothing is still reachable, in the same card.
    expect(screen.getByRole("button", { name: /New role/ })).toBeInTheDocument();
  });

  it("keeps the all-archived empty copy honest with the gallery beside it", async () => {
    // "No custom roles yet" would be a lie when one exists and is filed away.
    listAccessRolesMock.mockResolvedValue({
      roles: [role({ id: "r-old", name: "Locum", slug: "locum", state: "archived", peopleCount: 0 })],
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(ACCESS_COPY.emptyRolesAllArchived)).toBeInTheDocument(),
    );
    expect(screen.queryByText(ACCESS_COPY.emptyRoles)).not.toBeInTheDocument();
    expect(await screen.findByTestId("access-template-gallery")).toBeInTheDocument();
  });

  it("offers 'Start from a template' beside New role once roles exist, and opens the dialog", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    // Not fetched until asked for — the catalogue read follows the click.
    expect(listRoleTemplatesMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("access-template-gallery")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ACCESS_COPY.templatesOpen }));
    expect(await screen.findByTestId("access-template-gallery")).toBeInTheDocument();
    await waitFor(() => expect(listRoleTemplatesMock).toHaveBeenCalled());
    // The blank path keeps the filled accent; the template path is the ghost.
    expect(screen.getByRole("button", { name: /New role/ }).className).toContain("primary");
  });

  it("one-click: confirms the consequence, POSTs { templateId }, refreshes BOTH role lists", async () => {
    const onRolesChanged = vi.fn();
    createRoleFromTemplateMock.mockResolvedValue({
      role: role({ id: "r-fd", name: "Front Desk", slug: "front-desk", peopleCount: 0 }),
      syncState: "synced",
    });
    listAccessRolesMock.mockResolvedValue({ roles: [] });
    renderPanel({ onRolesChanged });
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: ACCESS_COPY.templatesUse })[0]!);

    const dialog = await screen.findByRole("dialog", { name: ACCESS_COPY.templateCreateHeading });
    // Never a silent write: the narrowing and the deliberately-unset extras
    // are both stated before anything is created.
    expect(within(dialog).getByText(ACCESS_COPY.templatesNarrowing)).toBeInTheDocument();
    expect(within(dialog).getByText(ACCESS_COPY.templatesNoExtras)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.templateCreateSubmit }));

    // No rename typed → `{ templateId }` alone, and never a slug.
    await waitFor(() =>
      expect(createRoleFromTemplateMock).toHaveBeenCalledWith("front-desk", undefined),
    );
    // The panel's own list AND the page's copy (roster chips, role pickers).
    await waitFor(() => expect(listAccessRolesMock.mock.calls.length).toBeGreaterThan(1));
    expect(onRolesChanged).toHaveBeenCalled();
  });

  it("sends the optional rename when the operator changes the name", async () => {
    createRoleFromTemplateMock.mockResolvedValue({
      role: role({ id: "r-fd", name: "Reception" }),
      syncState: "synced",
    });
    listAccessRolesMock.mockResolvedValue({ roles: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: ACCESS_COPY.templatesUse })[0]!);
    const dialog = await screen.findByRole("dialog", { name: ACCESS_COPY.templateCreateHeading });
    fireEvent.change(within(dialog).getByLabelText(ACCESS_COPY.templateCreateNameLabel), {
      target: { value: "Reception" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.templateCreateSubmit }));
    await waitFor(() =>
      expect(createRoleFromTemplateMock).toHaveBeenCalledWith("front-desk", "Reception"),
    );
  });

  it("a 409 CONCURRENT_MUTATION re-issues the IDENTICAL call instead of reporting a failure", async () => {
    // Nothing was applied: the write lost a SERIALIZABLE race on the derived
    // slug. Rendering that as an error teaches the operator to fear a
    // duplicate that does not exist.
    const raced = Object.assign(new Error("Another change landed first — try again."), {
      status: 409,
      code: "CONCURRENT_MUTATION",
    });
    createRoleFromTemplateMock
      .mockRejectedValueOnce(raced)
      .mockResolvedValueOnce({ role: role({ id: "r-fd", name: "Front Desk" }), syncState: "synced" });
    listAccessRolesMock.mockResolvedValue({ roles: [] });
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
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: ACCESS_COPY.templatesUse })[0]!);
    const dialog = await screen.findByRole("dialog", { name: ACCESS_COPY.templateCreateHeading });
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.templateCreateSubmit }));

    await waitFor(() => expect(createRoleFromTemplateMock).toHaveBeenCalledTimes(2));
    // Identical arguments — a retry, not a different request.
    expect(createRoleFromTemplateMock.mock.calls[0]).toEqual(
      createRoleFromTemplateMock.mock.calls[1],
    );
    await waitFor(() =>
      expect(screen.getByText(ACCESS_COPY.templateCreated("Front Desk"))).toBeInTheDocument(),
    );
    expect(screen.queryByText(ACCESS_COPY.templateRaceRetry)).not.toBeInTheDocument();
  });

  it("a race that loses TWICE says so, and says nothing was created", async () => {
    const raced = Object.assign(new Error("Another change landed first — try again."), {
      status: 409,
      code: "CONCURRENT_MUTATION",
    });
    createRoleFromTemplateMock.mockRejectedValue(raced);
    listAccessRolesMock.mockResolvedValue({ roles: [] });
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
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: ACCESS_COPY.templatesUse })[0]!);
    const dialog = await screen.findByRole("dialog", { name: ACCESS_COPY.templateCreateHeading });
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.templateCreateSubmit }));
    await waitFor(() =>
      expect(screen.getByText(ACCESS_COPY.templateRaceRetry)).toBeInTheDocument(),
    );
    // Retried once, not looped: a second race is a signal, not noise.
    expect(createRoleFromTemplateMock).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION: 'Customize first' opens a PRE-FILLED sheet whose Save is live", async () => {
    // The whole reason `initialDirty` exists. Without it the sheet renders a
    // complete role and a disabled Save, and the only way out is to nudge a
    // field the operator did not want to change.
    createAccessRoleMock.mockResolvedValue({ role: role({ id: "r-fd" }), syncState: "synced" });
    listAccessRolesMock.mockResolvedValue({ roles: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: ACCESS_COPY.templatesCustomize })[0]!);

    // Pre-filled: create mode, with the template's name already in the field.
    const name = await screen.findByPlaceholderText("Name this role");
    expect((name as HTMLInputElement).value).toBe("Front Desk");
    const save = screen.getByRole("button", { name: "Save role" });
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(createAccessRoleMock).toHaveBeenCalled());
    const payload = createAccessRoleMock.mock.calls[0][0];
    expect(payload.name).toBe("Front Desk");
    expect(payload.startingPoint).toBe("family");
    // The template's grants survive the round trip — not a blank draft with a
    // name poured in (`templateToDraft` carries the tool rows verbatim).
    expect(payload.featureGrants).toEqual(
      expect.arrayContaining([{ moduleId: "files", level: "act" }]),
    );
    expect(payload.toolGrants).toEqual([{ domain: "files", level: "view" }]);
  });

  it("a blank New role is still NOT saveable until it is named", async () => {
    // `initialDirty` must not have leaked into the ordinary create path.
    listAccessRolesMock.mockResolvedValue({ roles: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText(ACCESS_COPY.emptyRoles)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /New role/ }));
    await screen.findByPlaceholderText("Name this role");
    expect(screen.getByRole("button", { name: "Save role" })).toBeDisabled();
  });

  it("customizing a SECOND template shows that template, not the first", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: ACCESS_COPY.templatesCustomize })[0]!);
    expect(((await screen.findByPlaceholderText("Name this role")) as HTMLInputElement).value).toBe(
      "Front Desk",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close role builder" }));
    fireEvent.click(screen.getAllByRole("button", { name: ACCESS_COPY.templatesCustomize })[1]!);
    await waitFor(() =>
      expect((screen.getByPlaceholderText("Name this role") as HTMLInputElement).value).toBe(
        "Bookkeeper",
      ),
    );
  });

  it("the sheet's remount key separates two templates that share mode and (absent) id", () => {
    // Source-level on purpose. The shipped key was `${mode}-${id ?? "new"}` —
    // the CONSTANT "create-new" for every create — so two templates shared a
    // key and React would keep the first sheet's `useState` draft while the
    // panel handed it a second `base` it never re-reads. Nothing in the UI can
    // reach that today (the sheet is modal, and opening it closes the gallery
    // dialog), so a DOM test would only pretend; this pins the contract that
    // keeps it safe when a future affordance makes the switch reachable.
    const a = roleBuilderSheetKey({
      mode: "create",
      base: templateToDraft(tpl()),
      templateId: "front-desk",
    });
    const b = roleBuilderSheetKey({
      mode: "create",
      base: templateToDraft(tpl({ id: "bookkeeper", name: "Bookkeeper" })),
      templateId: "bookkeeper",
    });
    expect(a).not.toBe(b);
    // …and a blank create keeps its own identity, distinct from both.
    const blank = roleBuilderSheetKey({ mode: "create", base: blankRoleDraft("family") });
    expect(blank).not.toBe(a);
    expect(blank).not.toBe(b);
  });
});

// ── WARP-2738: the tool axis on the detail pane ──────────────────────
//
// T8's detail pane summarised Features, Usage and "Off the box" and left the
// TOOL axis off entirely — the one axis that is genuinely fail-closed (a
// domain absent is a domain the assistant cannot call, with no nav-only half
// measure), and the entire value of a read-only profile.
describe("WARP-2738 — the detail pane names the tool grants", () => {
  it("lists the granted domains with their levels", async () => {
    listAccessRolesMock.mockResolvedValue({
      roles: [
        role({
          startingPoint: "admin",
          toolGrants: [
            { domain: "money", level: "use" },
            { domain: "files", level: "view" },
          ],
        }),
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    const detail = screen.getByTestId("access-role-detail");
    expect(within(detail).getByText(ACCESS_COPY.toolsAxis)).toBeInTheDocument();
    expect(within(detail).getByText(/money · use/)).toBeInTheDocument();
    expect(within(detail).getByText(/files · view/)).toBeInTheDocument();
    // Admin keeps its write tools, so the read-only caveat stays off.
    expect(within(detail).queryByText(ACCESS_COPY.toolsReadOnlyBelowAdmin)).not.toBeInTheDocument();
  });

  it("says a Staff-based role's tools are read-only whatever the level claims", async () => {
    // `tierKeepsWriteTools` admits owner and admin only — below that, a `use`
    // grant IS a `view` grant, and the chip alone would imply otherwise.
    listAccessRolesMock.mockResolvedValue({
      roles: [role({ startingPoint: "family", toolGrants: [{ domain: "files", level: "use" }] })],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    const detail = screen.getByTestId("access-role-detail");
    expect(within(detail).getByText(ACCESS_COPY.toolsReadOnlyBelowAdmin)).toBeInTheDocument();
  });

  it("renders the absence honestly when a role grants no tools at all", async () => {
    listAccessRolesMock.mockResolvedValue({ roles: [role({ toolGrants: [] })] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Finance/ }));
    const detail = screen.getByTestId("access-role-detail");
    expect(within(detail).getByText(ACCESS_COPY.noToolsGranted)).toBeInTheDocument();
  });
});
