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
import { render, screen, fireEvent, within } from "@testing-library/react";
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
    renderSheet({ actingTier: "family" });
    const admin = screen.getByRole("radio", { name: "Admin" });
    expect(admin).toBeDisabled();
    expect(admin).toHaveAttribute("title", ACCESS_COPY.rankCap);
    // An admin actor may pick Admin — at-level is allowed (last-admin recovery).
    renderSheet({ actingTier: "admin" });
    expect(screen.getAllByRole("radio", { name: "Admin" })[1]).toBeEnabled();
  });

  it("re-floors on a starting-point drop and names the dropped grant (never silent)", () => {
    const base = roleToDraft(makeRole()); // admin SP with network=manage
    renderSheet({ mode: "edit", base });
    fireEvent.click(screen.getByRole("radio", { name: "Guest" }));
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

  it("caps connector levels at Read on non-Admin starting points (O-2)", () => {
    renderSheet(); // family base
    const select = screen.getByLabelText("Eaglesoft access");
    const labels = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels).toEqual(["None", "Read"]);
    expect(screen.getByText(ACCESS_COPY.connectorsPHI)).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.connectorHint)).toBeInTheDocument();
  });

  it("offers Read & write on Admin-based roles", () => {
    renderSheet({ base: blankRoleDraft("admin") });
    const select = screen.getByLabelText("Eaglesoft access");
    const labels = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels).toEqual(["None", "Read", "Read & write"]);
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
