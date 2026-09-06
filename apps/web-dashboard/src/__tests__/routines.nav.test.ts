/**
 * WARP-2671 — nav pins for the Routines entry.
 *
 * Mirrors reports.nav.test.ts: WHERE the item sits and WHO sees it, stated
 * sharply enough that a later re-grouping has to change this on purpose.
 *
 * The placement argument, since it is the part most likely to be "tidied"
 * later: `/tools` lives under Admin because a catalog of the box's built-in
 * capabilities is administrative reference material. A routine is a sequence
 * somebody composed to do their own job — their work, not an admin artefact —
 * so it belongs in Workspace and NOT bolted onto `/tools`, whose SEED-not-run
 * contract (WARP-829) must survive this feature intact.
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

describe("Routines nav entry (WARP-2671)", () => {
  it("sits in Workspace, not Admin", () => {
    expect(workspaceItems().map((i) => i.href)).toContain("/routines");
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    expect(admin?.items.map((i) => i.href) ?? []).not.toContain("/routines");
  });

  it("does not disturb the WARP-1992 Overview → Reports → Ask AI adjacency", () => {
    // Routines was placed after Ask AI precisely so that pin keeps holding.
    // If someone moves Routines up, reports.nav.test.ts goes red and they get
    // to decide on purpose rather than by accident.
    const hrefs = workspaceItems().map((i) => i.href);
    expect(hrefs.indexOf("/reports")).toBe(hrefs.indexOf("/") + 1);
    expect(hrefs.indexOf("/chat")).toBe(hrefs.indexOf("/reports") + 1);
    expect(hrefs.indexOf("/routines")).toBeGreaterThan(hrefs.indexOf("/chat"));
  });

  it("leaves the /tools catalog exactly where it was", () => {
    // The routine surface must not annex /tools. That page is a read-only
    // catalog with a deliberate SEED-not-run contract.
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    expect(admin?.items.map((i) => i.href) ?? []).toContain("/tools");
  });

  it("is visible to owner, admin and family", () => {
    for (const role of ["owner", "admin", "family"] as const) {
      const visible = visibleItems(workspaceItems(), role, openCapabilities, everyModuleOn);
      expect(visible.map((i) => i.href)).toContain("/routines");
    }
  });

  it("is hidden from guest — a guest can neither run nor publish a routine", () => {
    const visible = visibleItems(workspaceItems(), "guest", openCapabilities, everyModuleOn);
    expect(visible.map((i) => i.href)).not.toContain("/routines");
  });

  it("survives every module being off — routines span every surface", () => {
    // The regression this pins: tagging Routines with one module (say `files`)
    // would delete the page the moment that module is toggled off, even
    // though a routine may touch none of it.
    const visible = visibleItems(workspaceItems(), "owner", openCapabilities, everyModuleOff);
    expect(visible.map((i) => i.href)).toContain("/routines");
  });

  it("claims no module for its route, so the route gate can't 404 it", () => {
    expect(moduleForPath("/routines")).toBeNull();
  });

  it("is not tucked — it renders on the real nav surfaces", () => {
    const item = workspaceItems().find((i) => i.href === "/routines");
    expect(item?.hidden).toBeFalsy();
    expect(item?.label).toBe("Routines");
  });
});
