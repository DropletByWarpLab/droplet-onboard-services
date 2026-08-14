/**
 * WARP-1532 (RBAC v2 T8) — Surface C: the person editor's access sections.
 *
 * Covers the Role select (custom roles + built-in Admin/Staff/Guest — never
 * Owner or Service, rank-capped per WARP-623), the three §8 guardrails with
 * their verbatim §12 copy (owner untouchable / self-lockout / last admin +
 * Manage roles →), the read-only effective-access drawer (fetches on expand,
 * unknown values render —), and the collapsed exceptions block.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const fetchEffectiveAccessMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchEffectiveAccess: (...a: any[]) => fetchEffectiveAccessMock(...a),
}));

import { PersonAccessSection, PersonExceptionsSection } from "./PersonAccessSection";
import { ACCESS_COPY } from "./copy";
import type { AccessRole, EffectiveAccess, RosterUser } from "@/lib/types";

const FINANCE: AccessRole = {
  id: "r-finance",
  name: "Finance",
  slug: "finance",
  description: null,
  startingPoint: "family",
  state: "active",
  storageQuotaBytes: "26843545600",
  maxUploadSizeMb: 200,
  llmDailyMessageCap: null,
  cloudModelsAllowed: false,
  mayOperateLocks: false,
  createdBy: "u0",
  createdAt: "2026-07-24T00:00:00Z",
  updatedAt: "2026-07-24T00:00:00Z",
  peopleCount: 1,
  featureGrants: [{ moduleId: "files", level: "act" }],
  toolGrants: [],
  connectorGrants: [],
};

const OWNER: RosterUser = { id: "stefan", username: "stefan", displayName: "Stefan C", userId: "u-owner", role: "owner", accessRoleId: null };
const ADMIN: RosterUser = { id: "alex", username: "alex", displayName: "Alex Rivera", userId: "u-alex", role: "admin", accessRoleId: null };
const PRIYA: RosterUser = { id: "priya", username: "priya", displayName: "Priya Nair", userId: "u-priya", role: "family", accessRoleId: "r-finance" };

const EVERYONE = [OWNER, ADMIN, PRIYA];

function effective(overrides: Partial<EffectiveAccess> = {}): EffectiveAccess {
  return {
    tier: "family",
    features: [
      { moduleId: "chat", level: "act" },
      { moduleId: "files", level: "act" },
      { moduleId: "cameras", level: "view" },
    ],
    toolDomains: ["files"],
    locks: false,
    cloud: false,
    connectors: {},
    usage: { storageQuotaBytes: "26843545600", maxUploadSizeMb: null, llmDailyMessageCap: null },
    deptRights: [{ id: "d1", name: "Finance", right: "contributor" }],
    exceptions: [],
    ...overrides,
  };
}

function renderSection(props: Partial<React.ComponentProps<typeof PersonAccessSection>> = {}) {
  const onChange = vi.fn();
  const onManageRoles = vi.fn();
  const utils = render(
    <PersonAccessSection
      person={PRIYA}
      people={EVERYONE}
      roles={[FINANCE]}
      actingTier="owner"
      actingUserId="u-owner"
      value="role:r-finance"
      onChange={onChange}
      syncText={null}
      onManageRoles={onManageRoles}
      {...props}
    />,
  );
  return { onChange, onManageRoles, ...utils };
}

function renderExceptions(
  props: Partial<React.ComponentProps<typeof PersonExceptionsSection>> = {},
) {
  const onExceptionsChange = vi.fn();
  const utils = render(
    <PersonExceptionsSection
      person={PRIYA}
      people={EVERYONE}
      actingUserId="u-owner"
      exceptions={[]}
      onExceptionsChange={onExceptionsChange}
      {...props}
    />,
  );
  return { onExceptionsChange, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchEffectiveAccessMock.mockResolvedValue(effective());
});

describe("role select (§6.2)", () => {
  it("groups Your roles above Built-in and never offers Owner or Service", () => {
    renderSection();
    const select = screen.getByLabelText("Assigned role") as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Your roles", "Built-in"]);
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Finance");
    expect(labels).toContain("Admin");
    expect(labels).toContain("Staff");
    expect(labels).toContain("Guest");
    expect(labels).not.toContain("Owner");
    expect(labels).not.toContain("Service");
  });

  it("disables options above the actor's tier with the §12 rank-cap reason", () => {
    renderSection({ actingTier: "guest" });
    const select = screen.getByLabelText("Assigned role") as HTMLSelectElement;
    const admin = Array.from(select.options).find((o) => o.textContent === "Admin")!;
    const staff = Array.from(select.options).find((o) => o.textContent === "Staff")!;
    const guest = Array.from(select.options).find((o) => o.textContent === "Guest")!;
    expect(admin.disabled).toBe(true);
    expect(admin.title).toBe(ACCESS_COPY.rankCap);
    expect(staff.disabled).toBe(true);
    expect(guest.disabled).toBe(false);
    // A Staff-based custom role is above a guest actor too.
    const finance = Array.from(select.options).find((o) => o.textContent === "Finance")!;
    expect(finance.disabled).toBe(true);
  });

  it("selecting a role reports the change upward", () => {
    const { onChange } = renderSection();
    fireEvent.change(screen.getByLabelText("Assigned role"), { target: { value: "tier:admin" } });
    expect(onChange).toHaveBeenCalledWith("tier:admin");
  });

  it("renders the identity tier chip with the §6.1 hint (Staff label)", () => {
    renderSection();
    expect(screen.getByText("Staff tier")).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.identityHint)).toBeInTheDocument();
  });
});

describe("guardrails (§8 — disabled with honest copy)", () => {
  it("owner is untouchable: select disabled + verbatim tooltip note", () => {
    renderSection({ person: OWNER, value: "tier:owner" });
    expect(screen.getByText(ACCESS_COPY.ownerTooltip)).toBeInTheDocument();
    expect(screen.getByLabelText("Assigned role")).toBeDisabled();
  });

  it("owner exceptions: the add affordance renders DISABLED with the honest reason (QA send-back 2)", () => {
    renderExceptions({ person: OWNER });
    const addException = screen.getByRole("button", { name: ACCESS_COPY.addException });
    expect(addException).toBeDisabled();
    expect(addException).toHaveAttribute("title", ACCESS_COPY.ownerTooltip);
  });

  it("self-lockout: acting on yourself disables the select with the verbatim reason", () => {
    renderSection({ person: ADMIN, actingUserId: "u-alex", value: "tier:admin" });
    expect(screen.getByText(ACCESS_COPY.selfLockout)).toBeInTheDocument();
    expect(screen.getByLabelText("Assigned role")).toBeDisabled();
  });

  it("last admin: blocked with the verbatim reason and a Manage roles → path", () => {
    const { onManageRoles } = renderSection({
      person: ADMIN,
      // Alex is the ONLY operator — no owner in this roster.
      people: [ADMIN, PRIYA],
      value: "tier:admin",
    });
    expect(screen.getByText(ACCESS_COPY.lastAdmin)).toBeInTheDocument();
    expect(screen.getByLabelText("Assigned role")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: ACCESS_COPY.manageRolesLink }));
    expect(onManageRoles).toHaveBeenCalled();
  });
});

describe("effective-access drawer (§6.3 — read-only, honest)", () => {
  it("is collapsed by default and fetches on expand", async () => {
    renderSection();
    expect(fetchEffectiveAccessMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Effective access/ }));
    await waitFor(() => expect(fetchEffectiveAccessMock).toHaveBeenCalledWith("u-priya"));
    const drawer = screen.getByTestId("access-effective-drawer");
    await waitFor(() => expect(within(drawer).getByText(/Files · edit/i)).toBeInTheDocument());
    expect(within(drawer).getByText(/Storage 25 GB/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Finance: contributor/)).toBeInTheDocument();
    expect(within(drawer).getByText(ACCESS_COPY.effectiveHint)).toBeInTheDocument();
    // §6.3 (UX-11): absence is part of the honest answer — muted "No {…}"
    // chips for every gateable feature the resolver did not grant; the
    // always-on trio never renders as absent.
    const noNetwork = within(drawer).getByText("No network");
    expect(noNetwork.closest(".acc-chip")!.className).toContain("muted");
    expect(within(drawer).getByText("No email")).toBeInTheDocument();
    expect(within(drawer).queryByText("No chat")).not.toBeInTheDocument();
    expect(within(drawer).queryByText("No home")).not.toBeInTheDocument();
    expect(within(drawer).queryByText("No settings")).not.toBeInTheDocument();
  });

  it("renders deptRights chips kind-keyed: HOUSEHOLD → Workspace, others verbatim (WARP-1809)", async () => {
    // Every user holds a boot-seeded HOUSEHOLD membership, so before this
    // mapping every drawer echoed the seeded server name. The raw name here
    // deliberately DIFFERS from "Household": the mapping keys off kind,
    // never the name string (orgUnitDisplayName — the WARP-1808 rule).
    fetchEffectiveAccessMock.mockResolvedValue(
      effective({
        deptRights: [
          { id: "hh", name: "The Smiths", kind: "HOUSEHOLD", right: "manager" },
          { id: "d1", name: "Finance", kind: "DEPARTMENT", right: "contributor" },
          { id: "t1", name: "Platform", kind: "TEAM", right: "reader" },
          // Absent kind (older orchestrator): fail-safe to the raw name.
          { id: "d2", name: "Reception", right: "reader" },
        ],
      }),
    );
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Effective access/ }));
    const drawer = screen.getByTestId("access-effective-drawer");
    await waitFor(() =>
      expect(within(drawer).getByText("Workspace: manager")).toBeInTheDocument(),
    );
    expect(within(drawer).getByText("Finance: contributor")).toBeInTheDocument();
    expect(within(drawer).getByText("Platform: reader")).toBeInTheDocument();
    expect(within(drawer).getByText("Reception: reader")).toBeInTheDocument();
    expect(within(drawer).queryByText(/The Smiths/)).not.toBeInTheDocument();
  });

  it("renders — for unknown usage and an error line when the resolver is unreachable", async () => {
    fetchEffectiveAccessMock.mockRejectedValue(new Error("boom"));
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Effective access/ }));
    await waitFor(() =>
      expect(screen.getByTestId("access-effective-drawer")).toHaveTextContent(
        ACCESS_COPY.rolesErrorTitle,
      ),
    );
  });
});

describe("exceptions (§6.5 — collapsed, secondary; its own §17-ordered section)", () => {
  it("stays collapsed behind + Add an exception and reports an added row", () => {
    const { onExceptionsChange } = renderExceptions();
    expect(screen.getByText(ACCESS_COPY.exceptionsHint)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ACCESS_COPY.addException }));
    fireEvent.change(screen.getByLabelText("Exception feature"), { target: { value: "cameras" } });
    fireEvent.change(screen.getByLabelText("Exception effect"), { target: { value: "allow" } });
    fireEvent.change(screen.getByLabelText("Exception level"), { target: { value: "act" } });
    fireEvent.click(screen.getByRole("button", { name: "Add exception" }));
    expect(onExceptionsChange).toHaveBeenCalledWith([
      { moduleId: "cameras", effect: "allow", level: "act" },
    ]);
  });

  it("renders existing exception chips NEUTRAL text-first (icon + word, no status color — §1/§15)", () => {
    renderExceptions({
      exceptions: [
        { moduleId: "cameras", effect: "allow", level: "act" },
        { moduleId: "email", effect: "deny" },
      ],
    });
    const allow = screen.getByText(/Allow: Cameras · Export clips/).closest(".acc-chip");
    const deny = screen.getByText(/Deny: Email/).closest(".acc-chip");
    expect(allow).not.toBeNull();
    expect(deny).not.toBeNull();
    expect(allow!.className).not.toMatch(/green|red/);
    expect(deny!.className).not.toMatch(/green|red/);
  });
});

describe("sync line", () => {
  it("renders the page-owned sync text as a polite status with a frozen-under-reduced-motion spinner", () => {
    renderSection({ syncText: ACCESS_COPY.sessionRevoke("Priya") });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(ACCESS_COPY.sessionRevoke("Priya"));
    const spinner = status.querySelector("svg");
    expect(spinner?.getAttribute("class") ?? "").toContain("motion-reduce:animate-none");
  });
});
