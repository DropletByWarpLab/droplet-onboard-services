/**
 * WARP-1992 — nav pins for the Reports entry.
 *
 * Two things this holds that a render test can't state as sharply: WHERE the
 * item sits (it is a peer of Overview, not an Admin tool — a later
 * re-grouping should have to change this test on purpose) and WHO sees it.
 *
 * Reports is role-gated rather than module-gated. It composes ten tiles from
 * separately-gated surfaces, and each degrades on its own; a module gate here
 * would hide the whole page because one tile's module is off.
 */
import { describe, it, expect } from "vitest";
import { NAV_GROUPS, visibleItems, moduleForPath } from "@/components/nav-config";

const openCapabilities = { claudeActivity: true, ragEval: true };
const everyModuleOn = () => true;
const everyModuleOff = () => false;

function workspaceItems() {
  const group = NAV_GROUPS.find((g) => g.label === "Workspace");
  if (!group) throw new Error("Workspace nav group is gone");
  return group.items;
}

describe("Reports nav entry (WARP-1992)", () => {
  it("sits in Workspace, directly after Overview and before Ask AI", () => {
    const hrefs = workspaceItems().map((i) => i.href);
    const overview = hrefs.indexOf("/");
    const reports = hrefs.indexOf("/reports");
    const chat = hrefs.indexOf("/chat");

    expect(reports).toBeGreaterThan(-1);
    expect(reports).toBe(overview + 1);
    expect(chat).toBe(reports + 1);
  });

  it("is NOT in the Admin group — it is a peer of Overview, not an admin tool", () => {
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    expect(admin?.items.map((i) => i.href) ?? []).not.toContain("/reports");
  });

  it("is visible to owner, admin and family", () => {
    for (const role of ["owner", "admin", "family"] as const) {
      const visible = visibleItems(workspaceItems(), role, openCapabilities, everyModuleOn);
      expect(visible.map((i) => i.href)).toContain("/reports");
    }
  });

  it("is hidden from guest — the nav never advertises a page that would be mostly locked", () => {
    const visible = visibleItems(workspaceItems(), "guest", openCapabilities, everyModuleOn);
    expect(visible.map((i) => i.href)).not.toContain("/reports");
  });

  it("survives EVERY module being off — it is role-gated, not module-gated", () => {
    // The regression this pins: tagging Reports with one tile's module (say
    // `files`) would delete the whole page the moment that module is toggled
    // off, taking Money, Integrations and Activity with it.
    const visible = visibleItems(workspaceItems(), "owner", openCapabilities, everyModuleOff);
    expect(visible.map((i) => i.href)).toContain("/reports");
  });

  it("claims no module for its route, so the route gate can't 404 it", () => {
    expect(moduleForPath("/reports")).toBeNull();
  });

  it("is not tucked — it renders on the real nav surfaces", () => {
    const item = workspaceItems().find((i) => i.href === "/reports");
    expect(item?.hidden).toBeFalsy();
    expect(item?.label).toBe("Reports");
  });
});
