/**
 * WARP-2738 — the role-template gallery.
 *
 * The state trio, the render contract (server order, never sorted), and above
 * all THE HONESTY SPLIT: which of a template's feature grants genuinely
 * withhold data and which only hide a menu entry. That split is read from the
 * response's `enforcedModuleIds` — the live layer-2 gate roster — and the
 * regression these tests exist to prevent is someone "simplifying" it into a
 * hardcoded list of eight ids, or deriving it from a grant level.
 *
 * The catalogue itself is the SERVER's to get right
 * (`apps/orchestrator/src/services/access-role-templates.test.ts` runs every
 * template through the same clamps the write path applies). Nothing here
 * pretends to verify it; the fixtures below are deliberately small and made-up,
 * including a module id this build's catalog does not know.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const listRoleTemplatesMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listRoleTemplates: (...a: any[]) => listRoleTemplatesMock(...a),
}));

import { RoleTemplateGallery } from "./RoleTemplateGallery";
import { ACCESS_COPY } from "./copy";
import type { RoleTemplate } from "@/lib/types";

function template(overrides: Partial<RoleTemplate> = {}): RoleTemplate {
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

/** `files` is gated per person on a real box; `calendar` is not. Held as a
 *  fixture rather than a constant so the tests can move it and prove the UI
 *  follows the payload. */
const ENFORCED = ["files", "knowledge", "docs", "cameras", "network", "smart_home", "crm", "money"];

function renderGallery(props: Partial<React.ComponentProps<typeof RoleTemplateGallery>> = {}) {
  const onUse = vi.fn();
  const onCustomize = vi.fn();
  const utils = render(
    <RoleTemplateGallery onUse={onUse} onCustomize={onCustomize} {...props} />,
  );
  return { onUse, onCustomize, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  listRoleTemplatesMock.mockResolvedValue({
    roleTemplates: [template()],
    enforcedModuleIds: ENFORCED,
  });
});

describe("§10 state trio", () => {
  it("loading renders skeletons", () => {
    listRoleTemplatesMock.mockReturnValue(new Promise(() => {}));
    renderGallery();
    expect(screen.getAllByTestId("access-templates-skeleton").length).toBeGreaterThan(0);
  });

  it("error renders the §12 error card with a working Retry", async () => {
    listRoleTemplatesMock.mockRejectedValueOnce(new Error("boom"));
    renderGallery();
    await waitFor(() =>
      expect(screen.getByText(ACCESS_COPY.rolesErrorTitle)).toBeInTheDocument(),
    );
    // The body says WHY this is not simply an empty catalogue.
    expect(screen.getByText(ACCESS_COPY.templatesErrorBody)).toBeInTheDocument();
    listRoleTemplatesMock.mockResolvedValueOnce({
      roleTemplates: [template()],
      enforcedModuleIds: ENFORCED,
    });
    fireEvent.click(screen.getByRole("button", { name: ACCESS_COPY.retry }));
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
  });

  it("an empty catalogue says so instead of rendering a silent blank", async () => {
    listRoleTemplatesMock.mockResolvedValue({ roleTemplates: [], enforcedModuleIds: [] });
    renderGallery();
    await waitFor(() => expect(screen.getByText(ACCESS_COPY.templatesEmpty)).toBeInTheDocument());
  });
});

describe("the honesty split", () => {
  it("puts a genuinely-gated grant under 'Checked per person' and a nav-only one under 'Menu only'", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    const checked = screen.getByTestId("access-template-front-desk-checked");
    const navOnly = screen.getByTestId("access-template-front-desk-navonly");
    // `files` mounts a layer-2 gate → withholding it really withholds.
    expect(within(checked).getByText(/^Files/)).toBeInTheDocument();
    // `calendar` does not → the menu entry hides, the API still answers.
    expect(within(navOnly).getByText(/^Calendar/)).toBeInTheDocument();
    expect(within(checked).queryByText(/^Calendar/)).not.toBeInTheDocument();
  });

  it("REGRESSION: the split follows the payload, never a hardcoded list", async () => {
    // The whole reason `enforcedModuleIds` is served rather than compiled in:
    // FEATURE_GATED_MODULES has moved twice. Serve the OPPOSITE roster and the
    // two halves must swap — a dashboard-side copy would keep the old answer.
    listRoleTemplatesMock.mockResolvedValue({
      roleTemplates: [template()],
      enforcedModuleIds: ["calendar"],
    });
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    const checked = screen.getByTestId("access-template-front-desk-checked");
    const navOnly = screen.getByTestId("access-template-front-desk-navonly");
    expect(within(checked).getByText(/^Calendar/)).toBeInTheDocument();
    expect(within(navOnly).getByText(/^Files/)).toBeInTheDocument();
  });

  it("REGRESSION: the split is not derived from the grant LEVEL", async () => {
    // Both grants at the same level, one gated and one not — a card that
    // grouped by `manage` vs `view` would put them together.
    listRoleTemplatesMock.mockResolvedValue({
      roleTemplates: [
        template({
          featureGrants: [
            { moduleId: "files", level: "view" },
            { moduleId: "calendar", level: "view" },
          ],
        }),
      ],
      enforcedModuleIds: ["files"],
    });
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    expect(
      within(screen.getByTestId("access-template-front-desk-checked")).getByText(/^Files/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("access-template-front-desk-navonly")).getByText(/^Calendar/),
    ).toBeInTheDocument();
  });

  it("an empty half of the split renders 'None' rather than vanishing", async () => {
    listRoleTemplatesMock.mockResolvedValue({
      roleTemplates: [template({ featureGrants: [{ moduleId: "calendar", level: "view" }] })],
      enforcedModuleIds: ENFORCED,
    });
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    // "this template withholds nothing that is actually checked" is the fact.
    expect(
      within(screen.getByTestId("access-template-front-desk-checked")).getByText(
        ACCESS_COPY.templatesNoneGranted,
      ),
    ).toBeInTheDocument();
  });

  it("says 'will not see' and never that the person is told they lack permission", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    // The denial is a 404 byte-identical to the box-wide module toggle, so
    // there is no "you don't have permission" screen to promise.
    expect(document.body.textContent).toMatch(/will not see the page/);
    expect(document.body.textContent).not.toMatch(/lack permission|don't have permission/i);
  });

  it("discloses the narrowing, the view-level ceiling and the missing connectors/caps", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    expect(screen.getByText(ACCESS_COPY.templatesNarrowing)).toBeInTheDocument();
    // Both live in one note, so match on the text rather than an exact node.
    expect(document.body.textContent).toContain(ACCESS_COPY.templatesLevelsNote);
    expect(document.body.textContent).toContain(ACCESS_COPY.templatesNoExtras);
  });
});

describe("cards", () => {
  it("renders in the order served — never sorted, never grouped by tier", async () => {
    listRoleTemplatesMock.mockResolvedValue({
      roleTemplates: [
        template({ id: "front-desk", name: "Front Desk", startingPoint: "family" }),
        template({ id: "office-manager", name: "Office Manager", startingPoint: "admin" }),
        template({ id: "contractor-temp", name: "Contractor / Temp", startingPoint: "guest" }),
      ],
      enforcedModuleIds: ENFORCED,
    });
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    const grid = screen.getByTestId("access-template-gallery");
    const names = Array.from(grid.querySelectorAll(".acc-tplcard .nm")).map((n) => n.textContent);
    // Sorting alphabetically, or grouping the admin card with its tier, would
    // both reorder this.
    expect(names).toEqual(["Front Desk", "Office Manager", "Contractor / Temp"]);
  });

  it("labels the family tier 'Staff' — never the raw enum", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    expect(screen.getByText("Based on Staff")).toBeInTheDocument();
    expect(screen.queryByText(/Based on Family/)).not.toBeInTheDocument();
  });

  it("lists the tool domains, and says they stay read-only below admin", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    const tools = screen.getByTestId("access-template-front-desk-tools");
    expect(within(tools).getByText("files · view")).toBeInTheDocument();
    // `tierKeepsWriteTools` admits owner/admin only.
    expect(screen.getByText(ACCESS_COPY.toolsReadOnlyBelowAdmin)).toBeInTheDocument();
  });

  it("drops the read-only note on an admin-based template, where `use` really is use", async () => {
    listRoleTemplatesMock.mockResolvedValue({
      roleTemplates: [
        template({
          id: "office-manager",
          name: "Office Manager",
          startingPoint: "admin",
          toolGrants: [{ domain: "money", level: "use" }],
        }),
      ],
      enforcedModuleIds: ENFORCED,
    });
    renderGallery();
    await waitFor(() => expect(screen.getByText("Office Manager")).toBeInTheDocument());
    expect(screen.getByText("money · use")).toBeInTheDocument();
    expect(screen.queryByText(ACCESS_COPY.toolsReadOnlyBelowAdmin)).not.toBeInTheDocument();
  });

  it("shows a grant on a module this build's catalog does not know, rather than dropping it", async () => {
    // A box newer than this dashboard. `templateToDraft` cannot carry such a
    // grant (documented hole), which is exactly why the CARD must not hide it.
    listRoleTemplatesMock.mockResolvedValue({
      roleTemplates: [
        template({ featureGrants: [{ moduleId: "quantum_lab" as never, level: "act" }] }),
      ],
      enforcedModuleIds: ENFORCED,
    });
    renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    expect(screen.getByText("quantum_lab · act")).toBeInTheDocument();
  });

  it("hands the whole template to both create paths", async () => {
    const { onUse, onCustomize } = renderGallery();
    await waitFor(() => expect(screen.getByText("Front Desk")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: ACCESS_COPY.templatesUse }));
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: "front-desk" }));
    fireEvent.click(screen.getByRole("button", { name: ACCESS_COPY.templatesCustomize }));
    expect(onCustomize).toHaveBeenCalledWith(expect.objectContaining({ id: "front-desk" }));
  });

  it("disables only the busy card's actions", async () => {
    listRoleTemplatesMock.mockResolvedValue({
      roleTemplates: [template(), template({ id: "bookkeeper", name: "Bookkeeper" })],
      enforcedModuleIds: ENFORCED,
    });
    renderGallery({ busyTemplateId: "front-desk" });
    await waitFor(() => expect(screen.getByText("Bookkeeper")).toBeInTheDocument());
    const busy = screen.getByTestId("access-template-front-desk");
    const idle = screen.getByTestId("access-template-bookkeeper");
    expect(within(busy).getByRole("button", { name: ACCESS_COPY.templatesUse })).toBeDisabled();
    expect(within(idle).getByRole("button", { name: ACCESS_COPY.templatesUse })).toBeEnabled();
  });
});
