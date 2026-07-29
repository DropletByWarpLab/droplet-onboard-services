/**
 * WARP-1532 (RBAC v2 T8) — Surface B: the role builder sheet.
 *
 * Covers the §5 axes end to end against the fixed contract: identity +
 * starting point (rank-capped, re-floor notice never silent), features with
 * per-feature levels + floor-blocked-disabled-with-reason rows + the Files
 * deep-link, usage defaults, on-box tool domains with feature auto-off, the
 * off-box caution block (cloud confirm + connector tiers + empty state), and
 * the dirty-gated Save that emits the ADR-032 payload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import { RoleBuilderSheet } from "./RoleBuilderSheet";
import { blankRoleDraft, roleToDraft } from "@/lib/access";
import { ACCESS_COPY } from "./copy";
import type { AccessRole } from "@/lib/types";

const EAGLESOFT = [{ provider: "eaglesoft", label: "Eaglesoft", note: "Practice management · includes PHI" }];

function makeRole(overrides: Partial<AccessRole> = {}): AccessRole {
  return {
    id: "r1",
    name: "Finance",
    slug: "finance",
    description: null,
    startingPoint: "admin",
    state: "active",
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    createdBy: "u0",
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
    peopleCount: 0,
    featureGrants: [
      { moduleId: "files", level: "view" },
      { moduleId: "network", level: "manage" },
      { moduleId: "cameras", level: "view" },
      { moduleId: "smart_home", level: "view" },
    ],
    toolGrants: [],
    connectorGrants: [],
    ...overrides,
  };
}

function renderSheet(props: Partial<React.ComponentProps<typeof RoleBuilderSheet>> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onOpenDepartments = vi.fn();
  const utils = render(
    <RoleBuilderSheet
      open
      mode="create"
      base={blankRoleDraft("family")}
      actingTier="owner"
      connectors={EAGLESOFT}
      onSave={onSave}
      onClose={onClose}
      onOpenDepartments={onOpenDepartments}
      {...props}
    />,
  );
  return { onSave, onClose, onOpenDepartments, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("identity & starting point (axis 1)", () => {
  it("create mode: subline verbatim, Save disabled until named (dirty gate)", () => {
    renderSheet();
    expect(screen.getByText(ACCESS_COPY.builderSubline)).toBeInTheDocument();
    // UX-9 / QA-2: the sheet opts into the packet's ~520px width without
    // shifting other right panels (Dialog sideWidth="sheet").
    expect(screen.getByRole("dialog", { name: "New role" }).className).toContain("max-w-[520px]");
    const save = screen.getByRole("button", { name: "Save role" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Name this role"), {
      target: { value: "Front desk" },
    });
    expect(screen.getByRole("button", { name: "Save role" })).toBeEnabled();
    // Slug preview derives live.
    expect(screen.getByDisplayValue("front-desk")).toBeInTheDocument();
  });

  it("renders the three starting points with §12 captions (Staff label)", () => {
    renderSheet();
    expect(screen.getByText(ACCESS_COPY.startAdmin)).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.startStaff)).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.startGuest)).toBeInTheDocument();
  });

  it("rank-caps starting points above the actor (WARP-623) with the §12 reason", () => {
    // Plain aria-pressed buttons (UX-4): the segment is a button group, not
    // a fake radio contract.
    renderSheet({ actingTier: "family" });
    const admin = screen.getByRole("button", { name: "Admin" });
    expect(admin).toBeDisabled();
    expect(admin).toHaveAttribute("title", ACCESS_COPY.rankCap);
    expect(admin).toHaveAttribute("aria-pressed", "false");
    // An admin actor may pick Admin — at-level is allowed (last-admin recovery).
    renderSheet({ actingTier: "admin" });
    expect(screen.getAllByRole("button", { name: "Admin" })[1]).toBeEnabled();
  });

  it("re-floors on a starting-point drop and names the dropped grant (never silent)", () => {
    const base = roleToDraft(makeRole()); // admin SP with network=manage
    renderSheet({ mode: "edit", base });
    fireEvent.click(screen.getByRole("button", { name: "Guest" }));
    expect(
      screen.getByText(
        "Switching to Guest turns off Configure network — guests can't change the network.",
      ),
    ).toBeInTheDocument();
    // The over-floor level fell back to View inside the network row.
    const network = screen.getByTestId("access-feature-network");
    expect(within(network).getByRole("button", { name: /View/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("features & what they can do (axis 2)", () => {
  it("pins the always-on rows: disabled toggles with verbatim tooltips", () => {
    renderSheet();
    const chat = screen.getByTestId("access-feature-chat");
    const chatToggle = within(chat).getByRole("switch");
    expect(chatToggle).toBeDisabled();
    expect(chatToggle).toHaveAttribute("title", ACCESS_COPY.chatAlwaysOn);
    const settings = screen.getByTestId("access-feature-settings");
    const settingsToggle = within(settings).getByRole("switch");
    expect(settingsToggle).toBeDisabled();
    expect(settingsToggle).toHaveAttribute("title", ACCESS_COPY.settingsAlwaysOn);
  });

  it("Files is a deep-link reference, not a level editor (ADR-029 owns it)", () => {
    const { onOpenDepartments } = renderSheet();
    const files = screen.getByTestId("access-feature-files");
    const link = within(files).getByRole("button", { name: ACCESS_COPY.filesRow });
    expect(within(files).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    fireEvent.click(link);
    expect(onOpenDepartments).toHaveBeenCalled();
  });

  it("shows floor-blocked levels disabled with the §12 reason on a Staff-based role", () => {
    const base = blankRoleDraft("family");
    base.features.network = { on: true, level: "view" };
    renderSheet({ base });
    const network = screen.getByTestId("access-feature-network");
    const configure = within(network).getByRole("button", { name: /Configure/ });
    expect(configure).toBeDisabled();
    expect(within(network).getByText(ACCESS_COPY.floorBlockedNetwork)).toBeInTheDocument();
    // Clicking a blocked pill never changes the selection.
    fireEvent.click(configure);
    expect(within(network).getByRole("button", { name: /View/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("selecting a level updates the grants caption for that level", () => {
    renderSheet();
    const cameras = screen.getByTestId("access-feature-cameras");
    fireEvent.click(within(cameras).getByRole("button", { name: /Export clips/ }));
    expect(
      within(cameras).getByText("Everything in View, plus export clips."),
    ).toBeInTheDocument();
  });

  it("carries the May-operate-locks sub-toggle on the Devices row (§5.2)", () => {
    renderSheet();
    const devices = screen.getByTestId("access-feature-smart_home");
    const locks = within(devices).getByRole("switch", { name: ACCESS_COPY.locksToggle });
    expect(locks).toHaveAttribute("aria-checked", "false");
    fireEvent.click(locks);
    expect(locks).toHaveAttribute("aria-checked", "true");
  });
});

// ── WARP-1585 — three toggles, three stories ──
//
// Files, Knowledge and Documents were three switches wired to one enforcement
// (the orchestrator's `/api/files` gate prefix-matched both siblings). The
// backend now enforces three; this panel has to stop implying that all three
// are equally independent, because one of them is NOT: Documents has no
// surface of its own — it opens files that live in Files — so a Documents
// grant with no Files grant grants nothing reachable.
//
// The honest shape, per the packet: blocked WITH the reason, shown, never
// hidden — and never a padlock (§13 reserves Lock for floor-blocked, which
// this is not; the operator can clear this one themselves).
describe("declared feature dependencies (WARP-1585)", () => {
  it("blocks Documents WITH the reason when Files is off, and never with a padlock", () => {
    const base = blankRoleDraft("family");
    base.features.files = { on: false, level: "view" };
    base.features.docs = { on: true, level: "act" };
    renderSheet({ base });
    const docs = screen.getByTestId("access-feature-docs");
    const toggle = within(docs).getByRole("switch");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(within(docs).getByText(ACCESS_COPY.docsNeedsFiles)).toBeInTheDocument();
    // The levels are not editable while the parent is off — offering "Edit" on
    // a feature the person cannot open is the promise this ticket removes.
    expect(within(docs).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("Documents becomes editable the moment Files is on", () => {
    const base = blankRoleDraft("family");
    base.features.files = { on: true, level: "view" };
    base.features.docs = { on: true, level: "act" };
    renderSheet({ base });
    const docs = screen.getByTestId("access-feature-docs");
    expect(within(docs).getByRole("switch")).not.toBeDisabled();
    expect(within(docs).getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(within(docs).queryByText(ACCESS_COPY.docsNeedsFiles)).not.toBeInTheDocument();
    expect(within(docs).getByRole("button", { name: /Edit/ })).toBeInTheDocument();
  });

  it("Knowledge is independent of Files — the toggle means what it says", () => {
    // The half of the bug that looked like the FEATURE working: turning Files
    // off used to take the knowledge base with it. Knowledge reads the box's
    // own chunk store behind the file indexer, so it stands alone.
    const base = blankRoleDraft("family");
    base.features.files = { on: false, level: "view" };
    base.features.knowledge = { on: true, level: "view" };
    renderSheet({ base });
    const knowledge = screen.getByTestId("access-feature-knowledge");
    const toggle = within(knowledge).getByRole("switch");
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(within(knowledge).queryByText(ACCESS_COPY.docsNeedsFiles)).not.toBeInTheDocument();
    expect(within(knowledge).getByRole("button", { name: /Contribute/ })).toBeInTheDocument();
  });

  it("turning Files off does NOT rewrite the stored Documents grant (T8 convention)", async () => {
    // The T8 rule the tool-grant fan-out bug taught: a draft never re-emits a
    // DERIVED value for an axis the operator did not touch. Blocking Documents
    // is a rendering decision, not an edit — so the operator's Documents
    // intent survives, and restoring Files restores Documents exactly as they
    // left it. Clearing it here would silently revoke a third thing, which is
    // the failure mode this whole ticket is about.
    const role = makeRole({
      startingPoint: "admin",
      featureGrants: [
        { moduleId: "files", level: "view" },
        { moduleId: "docs", level: "manage" },
      ],
    });
    const { onSave } = renderSheet({ mode: "edit", base: roleToDraft(role) });
    const files = screen.getByTestId("access-feature-files");
    fireEvent.click(within(files).getByRole("switch"));
    // Documents now reads blocked…
    const docs = screen.getByTestId("access-feature-docs");
    expect(within(docs).getByRole("switch")).toBeDisabled();
    expect(within(docs).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    // …but the payload still carries the operator's Documents grant verbatim.
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0]![0];
    expect(payload.featureGrants).toEqual(
      expect.arrayContaining([{ moduleId: "docs", level: "manage" }]),
    );
    expect(payload.featureGrants).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ moduleId: "files" })]),
    );
  });

  it("restoring Files restores the Documents row untouched", () => {
    const base = blankRoleDraft("family");
    base.features.files = { on: true, level: "view" };
    base.features.docs = { on: true, level: "manage" };
    renderSheet({ base });
    const files = screen.getByTestId("access-feature-files");
    fireEvent.click(within(files).getByRole("switch")); // off
    fireEvent.click(within(files).getByRole("switch")); // back on
    const docs = screen.getByTestId("access-feature-docs");
    expect(within(docs).getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(within(docs).getByRole("button", { name: /Manage/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("usage limits (axis 3)", () => {
  it("renders the §12 defaults note and the three fields with honest placeholders", () => {
    renderSheet();
    expect(screen.getByText(ACCESS_COPY.usageDefaults)).toBeInTheDocument();
    expect(screen.getByLabelText("Storage limit")).toHaveAttribute("placeholder", "No limit");
    expect(screen.getByLabelText("Largest upload")).toHaveAttribute("placeholder", "Box default");
    expect(screen.getByLabelText(/Daily AI messages/)).toHaveAttribute("placeholder", "No limit");
  });
});

describe("AI tools & connectors (axis 4)", () => {
  it("auto-offs a tool domain whose feature is off, with the verbatim reason", () => {
    const base = blankRoleDraft("family");
    base.features.cameras = { on: false, level: "view" };
    renderSheet({ base });
    const row = screen.getByTestId("access-tools-cameras");
    expect(within(row).getByText(ACCESS_COPY.toolAutoOff("Cameras"))).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Use" })).toBeDisabled();
  });

  it("Escape closes only the topmost dialog — the draft survives a nested-confirm ESC (review F1)", async () => {
    const { onClose } = renderSheet();
    fireEvent.change(screen.getByPlaceholderText("Name this role"), {
      target: { value: "Front desk" },
    });
    fireEvent.click(screen.getByRole("switch", { name: ACCESS_COPY.cloudModelsToggle }));
    expect(screen.getByText(ACCESS_COPY.cloudConfirm("Front desk"))).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    // The confirm (topmost) closed — AnimatePresence unmounts it a beat later.
    await waitFor(() =>
      expect(screen.queryByText(ACCESS_COPY.cloudConfirm("Front desk"))).not.toBeInTheDocument(),
    );
    // …but the sheet below it never saw the Escape: no onClose, draft intact.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Front desk")).toBeInTheDocument();
    // A second Escape now reaches the sheet (it is topmost again).
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("downgrading the starting point clamps a Read & write connector and says so (review F3)", () => {
    const base = blankRoleDraft("admin");
    base.connectors.eaglesoft = "read_write";
    renderSheet({ mode: "edit", base });
    const select = screen.getByLabelText("Eaglesoft access") as HTMLSelectElement;
    expect(select.value).toBe("read_write");
    fireEvent.click(screen.getByRole("button", { name: "Staff" }));
    // The select keeps a real value (never silently blank)…
    expect((screen.getByLabelText("Eaglesoft access") as HTMLSelectElement).value).toBe("read");
    // …and the §5.1 notice names the downgrade.
    expect(
      screen.getByText(/caps Eaglesoft at Read — Read & write is available on Admin-based roles\./),
    ).toBeInTheDocument();
  });

  it("cloud toggle opens the §8 confirm and only enables on explicit confirm", () => {
    renderSheet();
    expect(screen.getByText(ACCESS_COPY.cloudConsequence)).toBeInTheDocument();
    const cloud = screen.getByRole("switch", { name: ACCESS_COPY.cloudModelsToggle });
    fireEvent.click(cloud);
    // Confirm body uses the role name fallback.
    expect(screen.getByText(ACCESS_COPY.cloudConfirm("this role"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep off" }));
    expect(screen.getByRole("switch", { name: ACCESS_COPY.cloudModelsToggle })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    fireEvent.click(screen.getByRole("switch", { name: ACCESS_COPY.cloudModelsToggle }));
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(screen.getByRole("switch", { name: ACCESS_COPY.cloudModelsToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  // WARP-1578 — §5.2's rule for the connectors axis, which it had never been
  // given: a floor-blocked option is DISABLED WITH THE REASON, never hidden.
  // Dropping the option silently taught an operator nothing about the ceiling
  // and made the two floors invisible.
  it("caps connector levels at Read on Family-based roles — Read & write shown, disabled, explained", () => {
    renderSheet(); // family base
    const select = screen.getByLabelText("Eaglesoft access") as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(options.map((o) => o.textContent)).toEqual(["None", "Read", "Read & write"]);
    expect(options.map((o) => o.disabled)).toEqual([false, false, true]);
    expect(select.disabled).toBe(false);
    expect(screen.getByText("Read & write is for admins.")).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.connectorsPHI)).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.connectorHint)).toBeInTheDocument();
  });

  it("offers Read & write on Admin-based roles, with nothing blocked", () => {
    renderSheet({ base: blankRoleDraft("admin") });
    const select = screen.getByLabelText("Eaglesoft access") as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(options.map((o) => o.textContent)).toEqual(["None", "Read", "Read & write"]);
    expect(options.map((o) => o.disabled)).toEqual([false, false, false]);
    expect(screen.queryByText("Read & write is for admins.")).not.toBeInTheDocument();
  });

  it("blocks the whole connectors axis on Guest-based roles, with the honest reason (WARP-1578)", () => {
    // A guest sits below O-2's family-and-up read floor, so any grant saved
    // here is inert. Shown-and-disabled, never hidden and never silently
    // accepted — the two halves of the design-brief doctrine.
    renderSheet({ base: blankRoleDraft("guest") });
    const select = screen.getByLabelText("Eaglesoft access") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    const options = Array.from(select.options);
    expect(options.map((o) => o.textContent)).toEqual(["None", "Read", "Read & write"]);
    expect(options.map((o) => o.disabled)).toEqual([false, true, true]);
    expect(screen.getByText("Connectors are for staff and admins.")).toBeInTheDocument();
  });

  it("switching TO Guest clears connector grants and says so — never a silent drop", () => {
    const base = blankRoleDraft("admin");
    base.connectors.eaglesoft = "read_write";
    renderSheet({ mode: "edit", base });
    fireEvent.click(screen.getByRole("button", { name: "Guest" }));
    expect((screen.getByLabelText("Eaglesoft access") as HTMLSelectElement).value).toBe("none");
    expect(
      screen.getByText(/Switching to Guest turns off Eaglesoft — guests can't reach connectors\./),
    ).toBeInTheDocument();
  });

  it("a Guest role that already HOLDS a grant shows it, and discloses that saving removes it", () => {
    // Reachable from rows written before this floor existed. The value stays
    // visible (hiding it would be the same dishonesty in reverse) and the
    // consequence of pressing Save is stated up front.
    const base = roleToDraft(
      makeRole({
        startingPoint: "guest",
        connectorGrants: [{ provider: "eaglesoft", level: "read" }],
      }),
    );
    const { onSave } = renderSheet({ mode: "edit", base });
    expect((screen.getByLabelText("Eaglesoft access") as HTMLSelectElement).value).toBe("read");
    expect(
      screen.getByText("Connectors are for staff and admins — saving removes this."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "front desk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    expect(onSave.mock.calls[0][0].connectorGrants).toEqual([]);
  });

  it("renders the connectors empty state with the Integrations link", () => {
    renderSheet({ connectors: [] });
    expect(screen.getByText(ACCESS_COPY.emptyConnectors)).toBeInTheDocument();
    // setup.ts mocks next/link into a plain string, so assert the deep-link
    // copy (+ its target) rather than an anchor role.
    expect(screen.getByText(/Open Integrations/)).toBeInTheDocument();
    expect(screen.getByText(/\/integrations/)).toBeInTheDocument();
  });
});

describe("tool grants — untouched groups round-trip verbatim (QA send-back)", () => {
  it("a name-only edit preserves mixed per-domain rows; touching a group fans out only that group", () => {
    const role = makeRole({
      startingPoint: "family",
      featureGrants: [
        { moduleId: "calendar", level: "view" },
        { moduleId: "files", level: "act" },
      ],
      toolGrants: [
        { domain: "calendar", level: "use" },
        { domain: "reminders", level: "view" },
        { domain: "files", level: "use" },
      ],
    });
    const { onSave } = renderSheet({ mode: "edit", base: roleToDraft(role) });

    // Name-only edit → Save: the tool axis was never touched.
    fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "Finance 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    const untouched = onSave.mock.calls[0][0].toolGrants;
    expect([...untouched].sort((a: any, b: any) => a.domain.localeCompare(b.domain))).toEqual([
      { domain: "calendar", level: "use" },
      { domain: "files", level: "use" },
      { domain: "reminders", level: "view" },
    ]);

    // Now explicitly set the calendar group to View → only that group fans
    // out; the files row still passes through verbatim.
    const calendarRow = screen.getByTestId("access-tools-calendar");
    fireEvent.click(within(calendarRow).getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    const touched = onSave.mock.calls[1][0].toolGrants;
    expect([...touched].sort((a: any, b: any) => a.domain.localeCompare(b.domain))).toEqual([
      { domain: "calendar", level: "view" },
      { domain: "files", level: "use" },
      { domain: "notifications", level: "view" },
      { domain: "reminders", level: "view" },
    ]);
  });
});

describe("save (footer)", () => {
  it("shows the Write safety chip and emits the contract payload on save", () => {
    const { onSave } = renderSheet();
    expect(screen.getByText("Write · confirm to apply")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Name this role"), {
      target: { value: "Front desk" },
    });
    const cameras = screen.getByTestId("access-feature-cameras");
    fireEvent.click(within(cameras).getByRole("button", { name: /Export clips/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0];
    expect(payload.name).toBe("Front desk");
    expect(payload.startingPoint).toBe("family");
    expect(payload.featureGrants).toEqual(
      expect.arrayContaining([{ moduleId: "cameras", level: "act" }]),
    );
    const ids = payload.featureGrants.map((g: { moduleId: string }) => g.moduleId);
    expect(ids).not.toContain("chat");
    expect(ids).not.toContain("home");
    expect(ids).not.toContain("settings");
  });
});
